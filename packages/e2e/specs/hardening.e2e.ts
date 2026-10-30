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
import { homedir } from "node:os";
import { createApprovalsClient, createTasksClient } from "@ccc/service-api-client";
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { assertSandboxConnected, type DriverBrowser, pollUntil } from "../src/driver.js";
import { appendLedger } from "../src/ledger.js";
import { readProcessTable } from "../src/process-table.js";
import { installConsoleCapture } from "../src/renderer-spies.js";
import { loadRunContext, type RunContext, serviceFixtureFor } from "../src/spec-context.js";
import {
  clearPending,
  selectOnlyPendingRequest,
  supportBrowser,
  waitForPane,
} from "../src/spec-support/approvals-support.js";
import {
  asQuietBrowser,
  BANNER_CONFIG,
  BUNDLE_GEOMETRY_CONFIG,
  type BundleGeometry,
  buildSessionEventRecord,
  checkAgentRunsIdle,
  checkAgentRunsRunning,
  checkAgentRunsSilent,
  checkBundleLineInView,
  checkCardIdle,
  checkCardRunning,
  checkDecidedThrough,
  checkLaunchersHeading,
  checkOneReport,
  checkPresenceUnavailable,
  checkTodayOverdueHeading,
  expectRunningAfterEvent,
  findPresenceHelpers,
  HEADING_CONFIG,
  openQuietView,
  rendererReadBanner,
  rendererReadBundleGeometry,
  rendererReadLaunchersHeading,
  rendererScrollButtonIntoView,
  runBannerDisconnectDrill,
  type SessionEvent,
  type WindowBrowser,
  waitForQuiet,
  withWindowHeight,
} from "../src/spec-support/hardening-support.js";
import { HEALTH_TEXT } from "../src/spec-support/health-copy.js";
import {
  asHealthBrowser,
  checkSettled,
  openBundlePreview,
  openDiagnostics,
  pressBundleButton,
  readHealth,
  reopenDiagnostics,
  waitForHealth,
  waitForLive,
} from "../src/spec-support/health-support.js";
import { OVERVIEW_TEXT } from "../src/spec-support/overview-copy.js";
import {
  asOverviewBrowser,
  readOverviewCards,
  reopenOverview,
  waitForVerdict,
} from "../src/spec-support/overview-support.js";
import {
  rendererClearSpies,
  rendererInstallSpies,
  rendererReadSpies,
} from "../src/spec-support/research-dom.js";
import {
  asResearchBrowser,
  clearResearchNotes,
  type ResearchEnvironment,
  runScenario,
  startResearchEnvironment,
  VAULT_TASKS_AT_LEAST,
} from "../src/spec-support/research-support.js";
import { installSessionGuard, type SessionGuardHooks } from "../src/spec-support/session-guard.js";
import { SETTINGS_TEXT } from "../src/spec-support/settings-copy.js";
import {
  asSettingsBrowser,
  openSettingsSection,
  pressRowControl,
  waitForSettings,
} from "../src/spec-support/settings-support.js";
import {
  buildSessionStartRecord,
  ledgerPidsOf,
  reapSacrificialChildren,
  runHook,
  type SacrificialChild,
  type SacrificialDeps,
  spawnSacrificialChild,
} from "../src/spec-support/synthetic-session.js";
import {
  asTasksBrowser,
  localDateIn,
  recordResults,
  runSetUpManagedVault,
  shiftLocalDate,
  WAIT,
} from "../src/spec-support/tasks-support.js";

/** Past the 5 second quiet threshold of the quiet service kind, with room for one sweep. */
const QUIET_WAIT_MS = 7_000;

const qb = asQuietBrowser(browser);
const hb = asHealthBrowser(browser);
const sb = asSettingsBrowser(browser);
const ob = asOverviewBrowser(browser);
const rb = asResearchBrowser(browser);
const tb = asTasksBrowser(browser);
const ab = supportBrowser(browser);

// One recorder for the whole file: it sees every finished `it` of both describes.
recordResults(loadRunContext(), (hook) => afterEach(hook as Mocha.Func));

describe("hardening: quiet sessions", function () {
  this.timeout(300_000);
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

  it("[09-UAT#02] A quiet working session reads No events for, not Running", async () => {
    const session = await startSession("working");
    // PostToolUse is the last event: the session said it was working, then went silent.
    await send(session, "PostToolUse");
    await browser.pause(QUIET_WAIT_MS);
    await openQuietView(qb, "agent-runs");
    const read = await waitForQuiet(
      qb,
      (current) => checkAgentRunsSilent(current, session.name),
      "the session to read No events for in Agent runs",
    );
    expect(checkAgentRunsSilent(read, session.name)).toEqual([]);
  });
});

describe("hardening: settings, approvals and research", function () {
  this.timeout(300_000);
  let env: ResearchEnvironment;
  const context = loadRunContext();

  // A closed Obsidian stops the file with one clear message, not a cascade of timeouts.
  installSessionGuard({ beforeEach, afterEach } as unknown as SessionGuardHooks, () =>
    browser.execute(() => true),
  );

  before(async () => {
    await assertSandboxConnected(tb, { expectedSocketPath: context.socketPath });
    env = await startResearchEnvironment();
    await runSetUpManagedVault(tb, VAULT_TASKS_AT_LEAST);
    clearResearchNotes(obsidianPage.getVaultPath(), context.runRoot);
    // The environment restarted the service and the plugin reconnects a moment later, which reloads
    // Diagnostics. Let that happen now, not under the first press of an item.
    await openDiagnostics(hb);
    await waitForLive(hb);
  });

  after(async () => {
    await env?.stop();
  });

  /** Opens Diagnostics, waits for a settled answer and returns it with the preview offered. */
  async function offeredBundle(): Promise<void> {
    await openDiagnostics(hb);
    // Leaving and coming back mounts the block again, so its preview starts closed.
    await reopenDiagnostics(hb);
    await waitForHealth(hb, checkSettled, "the first answer", WAIT.connect);
    await openBundlePreview(hb);
  }

  it("[09-UAT#03] Copy bundle's outcome appears beside its button at a short window height", async () => {
    await offeredBundle();
    const topLineBefore = (await readHealth(hb)).statusLine;
    await hb.execute(rendererInstallSpies);
    let geometry: BundleGeometry | undefined;
    await withWindowHeight(browser as unknown as WindowBrowser, 600, async () => {
      // A person scrolls the button into view before pressing it; the press must not need a scroll back.
      for (let attempt = 1; ; attempt += 1) {
        await hb.execute(rendererClearSpies);
        await hb.execute(
          rendererScrollButtonIntoView,
          BUNDLE_GEOMETRY_CONFIG,
          HEALTH_TEXT.copyBundle,
        );
        await pressBundleButton(hb, HEALTH_TEXT.copyBundle);
        try {
          await pollUntil(
            async () => (await readHealth(hb)).bundleStatusLine === HEALTH_TEXT.bundleCopied,
            {
              timeoutMs: 5_000,
              intervalMs: 100,
              describe: `the bundle line to read "${HEALTH_TEXT.bundleCopied}"`,
            },
          );
          break;
        } catch (error) {
          // The page can reload under a press while the plugin reconnects; offer the block again.
          if (attempt >= 3) throw error;
          await offeredBundle();
        }
      }
      geometry = await hb.execute(rendererReadBundleGeometry, BUNDLE_GEOMETRY_CONFIG);
    });
    if (geometry === undefined) throw new Error("The bundle geometry was not read.");
    expect(checkBundleLineInView(geometry, HEALTH_TEXT.copyBundle)).toEqual([]);
    // The outcome is in the bundle's own line; the destination's top line stayed silent (D-09).
    const after = await readHealth(hb);
    expect(after.statusLine).toBe(topLineBefore);
    expect(after.statusLine).not.toContain(HEALTH_TEXT.bundleCopied);
    // The copy went to the spy, not to the owner's clipboard.
    expect((await hb.execute(rendererReadSpies)).clipboard.length).toBeGreaterThan(0);
  });

  it("[09-UAT#04] The disconnected banner shows a display path with no /Users/", async () => {
    await offeredBundle();
    // The drill stops the sandbox service and restarts it in a finally, so a failure here cannot
    // leave items 5 to 8 with no socket. It waits for the reason that names where the plugin looked
    // (the transport's own first reason, `stream ended`, names no path) and checks every read.
    const problems = await runBannerDisconnectDrill({
      service: env,
      readBanner: () => browser.execute(rendererReadBanner, BANNER_CONFIG),
      waitForLive: () => waitForLive(hb),
      facts: { homeDir: homedir(), runRoot: context.runRoot },
    });
    expect(problems).toEqual([]);
  });

  it("[09-UAT#05] Settings > Security reads Approval presence check Unavailable in the sandbox", async () => {
    await openSettingsSection(sb, "security");
    const read = await waitForSettings(
      sb,
      (current) => {
        const fact = current.facts.find(
          (entry) => entry.name === SETTINGS_TEXT.factApprovalPresence,
        );
        return fact === undefined || fact.loading ? ["the presence row has not loaded"] : [];
      },
      "the presence row to load",
      WAIT.connect,
    );
    expect(checkPresenceUnavailable(read.facts)).toEqual([]);
    // No helper exists in the run root for the sandbox service to start.
    expect(findPresenceHelpers(context.runRoot)).toEqual([]);
  });

  it("[09-UAT#06] A test approval is approved with no prompt and reads decided through the command center", async () => {
    const approvals = createApprovalsClient(env.client);
    await clearPending(approvals);
    await openSettingsSection(sb, "approvals-tasks");
    await pressRowControl(sb, SETTINGS_TEXT.rowSendTest);
    await pollUntil(async () => ((await approvals.list()).pending.length === 1 ? true : null), {
      timeoutMs: 30_000,
      intervalMs: 500,
      describe: "a pending test approval",
    });
    await selectOnlyPendingRequest(ab);
    expect(
      await browser.execute(() => {
        const button = document.querySelector("[data-decision='approve']") as HTMLElement | null;
        if (button === null) return false;
        button.click();
        return true;
      }),
    ).toBe(true);
    const done = await waitForPane(
      ab,
      (pane) => pane.state === "executed",
      "the approved test request to be carried out",
    );
    expect(checkDecidedThrough(done.fields)).toEqual([]);
    // Nothing asked for Touch ID: the sandbox run root holds no presence helper at all.
    expect(findPresenceHelpers(context.runRoot)).toEqual([]);
  });

  it("[09-UAT#07] The Launchers heading reads Launchers and the Today heading reads Due today and overdue", async () => {
    await openSettingsSection(sb, "launchers");
    const heading = await pollUntil(
      async () => {
        const read = await browser.execute(rendererReadLaunchersHeading, HEADING_CONFIG);
        return read.present ? read : null;
      },
      { ...WAIT.short, describe: "the Launchers heading" },
    );
    expect(checkLaunchersHeading(heading)).toEqual([]);

    // An overdue task: the Today heading must say so (the feed words an overdue row "Overdue ...").
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await createTasksClient(env.client).create({
      title: "Phase 9 overdue task",
      intent: "ready",
      zone,
      dueDate: shiftLocalDate(localDateIn(zone, Date.now()), -1),
    });
    await reopenOverview(ob);
    const cards = await waitForVerdict(
      ob,
      (current) => checkTodayOverdueHeading(current),
      `the Today heading to read ${OVERVIEW_TEXT.dueTodayOverdueHeading}`,
      WAIT.connect,
    );
    expect(checkTodayOverdueHeading(cards)).toEqual([]);
    expect((await readOverviewCards(ob)).length).toBeGreaterThan(0);
  });

  it("[09-UAT#08] One research run on fixture sources still publishes one report with its sources", async () => {
    const run = await runScenario(rb, env, "base");
    const list = await env.research.list({ limit: 10 });
    const rows = list.rows.map((row) => ({
      readable: row.readable,
      sourceCount: row.readable ? row.sourceCount : 0,
    }));
    expect(checkOneReport({ ok: run.ok, rows })).toEqual([]);
  });
});
