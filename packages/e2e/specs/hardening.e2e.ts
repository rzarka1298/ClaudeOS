/**
 * The Phase 9 automated UAT (plan 09-21, D-17): the behaviours Phase 9 added or fixed, proved in the
 * runner's sandbox. Item 1 (and item 2) run against a `quiet` kind service whose quiet threshold is
 * 5 seconds (`CCC_QUIET_THRESHOLD_MS`), with synthetic hook events about sacrificial children this
 * spec spawned and ledgered itself; the only process ever signalled is one of those handles.
 *
 * Safety (T-09-46): no item here spawns the real presence helper, reads or writes the owner's
 * Keychain presence items, or touches launchd. Every service gets `CCC_INSTALL_SECRET_ACCOUNT`
 * (the presence port stays fail-closed), and no run root holds the helper. The two real-Mac
 * checks (the presence prompt and the LaunchAgent re-install) are owner items in 09-UAT.md.
 *
 * Authored and CI-verified only; the live behaviour is first seen in the orchestrator's run at
 * the final head (09-23).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { browser, expect } from "@wdio/globals";
import { assertSandboxConnected, type DriverBrowser } from "../src/driver.js";
import { appendLedger } from "../src/ledger.js";
import { readProcessTable } from "../src/process-table.js";
import { installConsoleCapture } from "../src/renderer-spies.js";
import { installResultRecorder, type RecorderOptions } from "../src/results.js";
import { loadRunContext, type RunContext, serviceFixtureFor } from "../src/spec-context.js";
import {
  asQuietBrowser,
  buildSessionEventRecord,
  checkAgentRunsIdle,
  checkAgentRunsRunning,
  checkCardIdle,
  checkCardRunning,
  expectRunningAfterEvent,
  openQuietView,
  type SessionEvent,
  waitForQuiet,
} from "../src/spec-support/hardening-support.js";
import {
  buildSessionStartRecord,
  ledgerPidsOf,
  reapSacrificialChildren,
  runHook,
  type SacrificialChild,
  type SacrificialDeps,
  spawnSacrificialChild,
} from "../src/spec-support/synthetic-session.js";

/** Past the 5 second quiet threshold of the quiet service kind, with room for one sweep. */
const QUIET_WAIT_MS = 7_000;

const qb = asQuietBrowser(browser);

describe("hardening: quiet sessions", () => {
  let context: RunContext;
  let fixture: ReturnType<typeof serviceFixtureFor> | undefined;
  const registry: SacrificialChild[] = [];
  const service = (): ReturnType<typeof serviceFixtureFor> => {
    if (fixture === undefined) fixture = serviceFixtureFor(context);
    return fixture;
  };
  const deps = (): SacrificialDeps => ({
    registry,
    ledger: (entry) => appendLedger(context.paths.ledgerPath, entry),
    readStart: async (pid) => {
      const row = (await readProcessTable()).find((entry) => entry.pid === pid);
      if (row === undefined) {
        throw new Error("The sacrificial child is missing from the process table.");
      }
      return row.start;
    },
  });

  interface Synthetic {
    readonly sacrificial: SacrificialChild;
    readonly sessionId: string;
    readonly cwd: string;
    readonly name: string;
  }

  /** Spawns a sacrificial child and registers a synthetic session whose process it is. */
  async function startSession(label: string): Promise<Synthetic> {
    const sacrificial = await spawnSacrificialChild(deps());
    const sessionId = randomBytes(8).toString("hex");
    const cwd = `${context.paths.tmpDir}/scratch-${label}`;
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    await runHook({
      runtimeDir: context.paths.runtimeDir,
      runRoot: context.runRoot,
      home: context.paths.tmpDir,
      pid: sacrificial.pid,
      ledgerPids: ledgerPidsOf(registry),
      record: buildSessionStartRecord(sessionId, cwd, context.runRoot),
    });
    return { sacrificial, sessionId, cwd, name: `Session ${sessionId.slice(0, 8)}` };
  }

  /** Sends one lifecycle event about a synthetic session through the sandbox hook. */
  async function send(session: Synthetic, event: SessionEvent): Promise<void> {
    await runHook({
      runtimeDir: context.paths.runtimeDir,
      runRoot: context.runRoot,
      home: context.paths.tmpDir,
      pid: session.sacrificial.pid,
      ledgerPids: ledgerPidsOf(registry),
      record: buildSessionEventRecord(event, session.sessionId, session.cwd, context.runRoot),
    });
  }

  before(async function startRun() {
    context = loadRunContext();
    installResultRecorder({
      afterEach: afterEach as unknown as RecorderOptions["afterEach"],
      resultsPath: context.paths.resultsPath,
    });
    await service().resetData();
    await service().start({ kind: "quiet" });
    await assertSandboxConnected(browser as unknown as DriverBrowser, {
      expectedSocketPath: context.socketPath,
    });
    await browser.execute(installConsoleCapture);
  });

  after(async function stopRun() {
    await reapSacrificialChildren(registry);
    await service().stop();
  });

  it("[09-UAT#01] A quiet idle session reads Idle, is not counted as running, and a new event restores Running", async () => {
    const session = await startSession("idle");
    await send(session, "Stop");
    await browser.pause(QUIET_WAIT_MS);

    // Agent runs: Idle with the age, excluded from the active numeral, named in the quiet segment.
    await openQuietView(qb, "agent-runs");
    const quietAgent = await waitForQuiet(
      qb,
      (read) => checkAgentRunsIdle(read, session.name),
      "the session to read Idle in Agent runs",
    );
    expect(checkAgentRunsIdle(quietAgent, session.name)).toEqual([]);

    // The Active sessions card says the same: Idle, not in the numeral, `1 quiet` in the caption.
    await openQuietView(qb, "overview");
    const quietCard = await waitForQuiet(
      qb,
      (read) => checkCardIdle(read, session.name),
      "the session to read Idle on the Active sessions card",
    );
    expect(checkCardIdle(quietCard, session.name)).toEqual([]);
    expect(quietCard.card.caption).toContain("1 quiet");

    // A new hook event restores Running, on the card ...
    const card = await expectRunningAfterEvent(
      qb,
      () => send(session, "UserPromptSubmit"),
      (read) => checkCardRunning(read, session.name),
      "the session to read Running on the card after a new event",
    );
    expect(checkCardRunning(card, session.name)).toEqual([]);

    // ... and in Agent runs.
    await openQuietView(qb, "agent-runs");
    const agent = await expectRunningAfterEvent(
      qb,
      () => send(session, "UserPromptSubmit"),
      (read) => checkAgentRunsRunning(read, session.name),
      "the session to read Running in Agent runs after a new event",
    );
    expect(checkAgentRunsRunning(agent, session.name)).toEqual([]);
  });
});
