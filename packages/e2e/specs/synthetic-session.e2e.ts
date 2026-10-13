/**
 * 06-UAT test 11 on a synthetic session (05.2-08, D-13, E2E-09): Force-terminate end to end with
 * synthetic hook events about a process this spec spawned itself.
 *
 * Safety (T-05.2-30, T-05.2-31): the only process ever signalled is a ChildProcess handle from
 * `spawnSacrificialChild`; before Approve once is pressed the pid the SERVICE recorded for the
 * session must equal a ledgered sacrificial pid, or the spec aborts. The hook runs with a minimal
 * environment and the sandbox runtime directory, so no real session, spool or Claude settings is
 * touched. If the hook cannot register a session, the test fails; there is no fallback that fakes
 * a pass (plan 05.2-09 retags the item to owner in that case).
 *
 * Authored and CI-checked only (D-15); the live run is the orchestrator's baseline in 05.2-09.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";
import {
  assertSandboxConnected,
  type DriverBrowser,
  pollUntil,
  runPluginCommand,
} from "../src/driver.js";
import { appendLedger } from "../src/ledger.js";
import { readProcessTable } from "../src/process-table.js";
import { installConsoleCapture } from "../src/renderer-spies.js";
import { installResultRecorder, type RecorderOptions } from "../src/results.js";
import { loadRunContext, type RunContext, serviceFixtureFor } from "../src/spec-context.js";
import {
  AWAITING_EXIT_SENTENCE,
  DENY_LABEL,
  FAILED_REASON_LABELS,
} from "../src/spec-support/cross-copy.js";
import {
  type FocusRecord,
  readTextInRenderer,
  recordFocusInRenderer,
} from "../src/spec-support/cross-support.js";
import {
  AUDIT_SEQUENCE_SQL,
  assertTargetIsSacrificial,
  buildSessionStartRecord,
  checkAuditSequence,
  ledgerPidsOf,
  RUNS_SQL,
  reapSacrificialChildren,
  recordedPidFor,
  runHook,
  type SacrificialChild,
  type SacrificialDeps,
  spawnSacrificialChild,
} from "../src/spec-support/synthetic-session.js";
import { copyStore, queryStore } from "../src/store-copy.js";

const TERMINATE_CAPABILITY = "session:terminate";
const SEND_TO_INBOX_LABEL = "Send to approval inbox";

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
    if (row === undefined)
      throw new Error("The sacrificial child is missing from the process table.");
    return row.start;
  },
});
const running = (entry: SacrificialChild): boolean =>
  entry.child.exitCode === null && entry.child.signalCode === null;

async function openAgentRuns(): Promise<void> {
  // The command center may not be open (nothing else in this spec opens it), so open it first.
  await runPluginCommand(
    browser as unknown as DriverBrowser,
    "claude-command-center:open-overview",
  );
  await pollUntil(
    () => browser.execute(() => document.getElementById("ccc-tab-agent-runs") !== null),
    {
      timeoutMs: 15_000,
      intervalMs: 250,
      describe: "the Agent runs tab",
    },
  );
  await browser.execute(() => {
    (document.getElementById("ccc-tab-agent-runs") as HTMLElement).click();
  });
}

/** Spawns a sacrificial child and registers a synthetic session whose process it is. */
async function startSession(
  label: string,
): Promise<{ sacrificial: SacrificialChild; sessionId: string; name: string }> {
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
  return { sacrificial, sessionId, name: `Session ${sessionId.slice(0, 8)}` };
}

/** Waits for the service to record a pid for the session and returns it (copy, then read-only). */
async function recordedPid(sessionId: string): Promise<number> {
  return pollUntil(
    async () => {
      const { copyPath } = copyStore({
        runtimeDir: context.paths.runtimeDir,
        destDir: context.paths.tmpDir,
        runRoot: context.runRoot,
      });
      return recordedPidFor(
        await queryStore({ copyPath, sql: RUNS_SQL, runRoot: context.runRoot }),
        sessionId,
      );
    },
    { timeoutMs: 30_000, intervalMs: 500, describe: "the service to record the session pid" },
  );
}

/** Selects the session, presses Force-terminate and sends the request to the approval inbox. */
async function requestTermination(sessionName: string, expectedRows: number): Promise<void> {
  await openAgentRuns();
  await pollUntil(
    () =>
      browser.execute((name: string) => {
        const link = Array.from(document.querySelectorAll(".ccc-session-row-link")).find(
          (el) => el.getAttribute("title") === name,
        );
        if (link === undefined) return false;
        (link as HTMLElement).click();
        return true;
      }, sessionName),
    { timeoutMs: 30_000, intervalMs: 500, describe: "the session in Agent runs" },
  );
  await pollUntil(
    () =>
      browser.execute((capability: string) => {
        const button = document.querySelector(`button[data-capability="${capability}"]`);
        if (button === null || button.getAttribute("aria-disabled") === "true") return false;
        (button as HTMLElement).click();
        return true;
      }, TERMINATE_CAPABILITY),
    { timeoutMs: 20_000, intervalMs: 500, describe: "an enabled Force-terminate control" },
  );
  await pollUntil(
    () =>
      browser.execute((label: string) => {
        const button = Array.from(document.querySelectorAll(".modal button")).find(
          (el) => el.textContent?.trim() === label,
        );
        if (button === undefined) return false;
        (button as HTMLElement).click();
        return true;
      }, SEND_TO_INBOX_LABEL),
    { timeoutMs: 15_000, intervalMs: 250, describe: "the force-terminate confirmation" },
  );
  await pollUntil(
    async () =>
      (await browser.execute(
        () => document.querySelectorAll('.ccc-approval-row[data-state="pending"]').length,
      )) >= expectedRows,
    { timeoutMs: 30_000, intervalMs: 500, describe: "the termination request in Approvals" },
  );
}

/** Opens the pending request in the pane. */
async function selectPendingRequest(): Promise<void> {
  await browser.execute(() => {
    (
      document.querySelector(
        '.ccc-approval-row[data-state="pending"] .ccc-approval-row-button',
      ) as HTMLElement
    ).click();
  });
  await pollUntil(() => browser.execute(() => document.querySelector("[data-decision]") !== null), {
    timeoutMs: 15_000,
    intervalMs: 250,
    describe: "the decision group",
  });
}

/** Focus is on Deny, or on the pane heading with Deny the first control reached by Tab. */
async function focusLandsOnDeny(): Promise<boolean> {
  const first = await browser.execute(recordFocusInRenderer);
  if (first?.name.startsWith(DENY_LABEL) === true) return true;
  await browser.keys(Key.Tab);
  const next: FocusRecord | null = await browser.execute(recordFocusInRenderer);
  if (next?.name.startsWith(DENY_LABEL) === true) return true;
  // Name what had focus, so a miss can be told from a Tab that never reached the page.
  throw new Error(
    `Focus did not reach Deny: first ${JSON.stringify(first?.name ?? null)} (${first?.tag ?? "none"}), after Tab ${JSON.stringify(next?.name ?? null)} (${next?.tag ?? "none"})`,
  );
}

async function press(decision: "deny" | "approve"): Promise<void> {
  await browser.execute((kind: string) => {
    (document.querySelector(`[data-decision="${kind}"]`) as HTMLElement).click();
  }, decision);
}

const paneText = (): Promise<string> => browser.execute(readTextInRenderer, ".ccc-approvals");

before(async function startRun() {
  context = loadRunContext();
  installResultRecorder({
    afterEach: afterEach as unknown as RecorderOptions["afterEach"],
    resultsPath: context.paths.resultsPath,
  });
  // A fresh store, so the audit trail read at the end holds only this spec's requests.
  await service().resetData();
  await service().start({ kind: "normal" });
  await assertSandboxConnected(browser as unknown as DriverBrowser, {
    expectedSocketPath: context.socketPath,
  });
  await browser.execute(installConsoleCapture);
});

after(async function stopRun() {
  await reapSacrificialChildren(registry);
  await service().stop();
});

describe("synthetic session", () => {
  it("[06-UAT#11] Force-terminate on a synthetic session: deny keeps it, approve ends it, an ended one is refused", async () => {
    // --- session A: deny, then approve ---
    const a = await startSession("a");
    assertTargetIsSacrificial(await recordedPid(a.sessionId), ledgerPidsOf(registry));
    expect(running(a.sacrificial)).toBe(true);

    await requestTermination(a.name, 1);
    await selectPendingRequest();
    expect(running(a.sacrificial)).toBe(true);
    expect(await focusLandsOnDeny()).toBe(true);

    await press("deny");
    await pollUntil(async () => /denied/i.test(await paneText()), {
      timeoutMs: 20_000,
      intervalMs: 500,
      describe: "the denied outcome",
    });
    expect(running(a.sacrificial)).toBe(true);

    await requestTermination(a.name, 1);
    await selectPendingRequest();
    assertTargetIsSacrificial(await recordedPid(a.sessionId), ledgerPidsOf(registry));
    await press("approve");
    await pollUntil(() => !running(a.sacrificial), {
      timeoutMs: 30_000,
      intervalMs: 250,
      describe: "the sacrificial child to exit after Approve once",
    });
    await pollUntil(
      async () => {
        const text = await paneText();
        return text.includes(AWAITING_EXIT_SENTENCE) || /carried out/i.test(text);
      },
      { timeoutMs: 30_000, intervalMs: 500, describe: "the carried-out sentence" },
    );
    // The run's final state is shown in Agent runs (the session row stays listed, ended).
    const rowText = await browser.execute((name: string) => {
      const link = Array.from(document.querySelectorAll(".ccc-session-row-link")).find(
        (el) => el.getAttribute("title") === name,
      );
      return link?.closest("tr")?.textContent ?? "";
    }, a.name);
    expect(rowText).not.toBe("");

    // --- session B: ended by the spec itself before the approval ---
    const b = await startSession("b");
    assertTargetIsSacrificial(await recordedPid(b.sessionId), ledgerPidsOf(registry));
    await requestTermination(b.name, 1);
    b.sacrificial.child.kill("SIGKILL");
    await pollUntil(() => !running(b.sacrificial), {
      timeoutMs: 15_000,
      intervalMs: 250,
      describe: "the second child to end",
    });
    await selectPendingRequest();
    assertTargetIsSacrificial(await recordedPid(b.sessionId), ledgerPidsOf(registry));
    await press("approve");
    await pollUntil(
      async () => {
        const text = await paneText();
        return FAILED_REASON_LABELS.some((reason) => text.includes(reason));
      },
      { timeoutMs: 30_000, intervalMs: 500, describe: "one of the fixed refusal reasons" },
    );

    // --- the audit trail, read from a copy of the store ---
    const { copyPath } = copyStore({
      runtimeDir: context.paths.runtimeDir,
      destDir: context.paths.tmpDir,
      runRoot: context.runRoot,
    });
    const rows = await queryStore({ copyPath, sql: AUDIT_SEQUENCE_SQL, runRoot: context.runRoot });
    const events = rows.map((row) => String(row.event));
    expect(checkAuditSequence(events)).toEqual({ ok: true, reason: "" });
  });
});
