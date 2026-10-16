/**
 * Lifecycle items of the Phase 7 UAT (plan 07-17, D-28, ADR-09, RSRCH-06, DIAG-05, PRIV-04): a
 * second press, the service stopping mid-run, reruns reusing their snapshots, the disconnect
 * drill and the privacy of the logs and settings. Every run is the REAL pipeline of the built
 * service over the fixture directory with the extractive summariser; the slow scenario holds each
 * fetch long enough to stop the service in the middle of one. No network, no model, no key;
 * authored and CI-verified only (D-15).
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { assertSandboxConnected, pollUntil } from "../src/driver.js";
import {
  privacyMarkers,
  REFETCH_MARKER_NAME,
  scenarioSources,
} from "../src/research-uat-fixture.js";
import { loadRunContext } from "../src/spec-context.js";
import { checkPluginDataKeys } from "../src/spec-support/cross-support.js";
import { RESEARCH_CLASSES, RESEARCH_TEXT } from "../src/spec-support/research-copy.js";
import {
  rendererClickByText,
  rendererClickInSource,
  rendererClickTwice,
  rendererInstallSpies,
  rendererMountAndPress,
  rendererReadSpies,
} from "../src/spec-support/research-dom.js";
import { parseReportNote, scalarOf } from "../src/spec-support/research-notes.js";
import {
  asResearchBrowser,
  clearResearchNotes,
  closeNotes,
  KIND_LABELS,
  notesSnapshot,
  openReport,
  openResearch,
  pluginDataPath,
  pressRunNow,
  type ResearchEnvironment,
  readAllServiceLogs,
  readNoteInReadingView,
  readResearch,
  readResearchStore,
  readVaultNotes,
  runScenario,
  runViaApi,
  startResearchEnvironment,
  VAULT_TASKS_AT_LEAST,
  waitForConnected,
  waitForIdle,
  waitForNoteOpen,
  waitForRunEnd,
} from "../src/spec-support/research-support.js";
import {
  checkDisconnectedView,
  checkLogPrivacy,
  checkReconnectedView,
  checkReuse,
  checkUnknownRun,
} from "../src/spec-support/research-verdicts.js";
import {
  asTasksBrowser,
  recordResults,
  rendererClick,
  runSetUpManagedVault,
} from "../src/spec-support/tasks-support.js";

const rb = asResearchBrowser(browser);
const tb = asTasksBrowser(browser);

describe("research lifecycle", () => {
  let env: ResearchEnvironment;

  recordResults(loadRunContext(), (hook) => afterEach(hook as Mocha.Func));

  const vaultPath = () => obsidianPage.getVaultPath();
  const vaultNotes = () => readVaultNotes(vaultPath(), env.context.runRoot);
  const jobCount = async () => (await readResearchStore(env.context)).jobs.length;

  before(async () => {
    await assertSandboxConnected(tb, { expectedSocketPath: loadRunContext().socketPath });
    env = await startResearchEnvironment();
    await runSetUpManagedVault(tb, VAULT_TASKS_AT_LEAST);
    clearResearchNotes(vaultPath(), env.context.runRoot);
  });

  after(async () => {
    await env?.stop();
  });

  it("[07-UAT#11] A second press returns the running run", async () => {
    // Two presses back to back from the window: the button itself refuses the second, so exactly
    // one run starts.
    env.prepared.select("base");
    await openResearch(rb);
    const before = await jobCount();
    expect(await rb.execute(rendererClickTwice, `.${RESEARCH_CLASSES.runBox} button`)).toBe(2);
    await waitForRunEnd(rb);
    expect(await jobCount()).toBe(before + 1);

    // A press that reaches the service while a run it has not told this window about is going
    // on is answered with that run: the window is left, a run is started from outside, and
    // the window is opened and pressed before its first status answer lands. If the window
    // learned of the run first, the run is ended by restarting the service and the try repeats.
    env.prepared.select("slow");
    const beforeSecond = await jobCount();
    let answered = false;
    let startedRuns = 0;
    for (let attempt = 1; attempt <= 4 && !answered; attempt += 1) {
      await browser.executeObsidian(
        rendererClick,
        `#${RESEARCH_CLASSES.tabPrefix}${RESEARCH_TEXT.overviewTabId}`,
        null,
      );
      const started = await env.research.run();
      expect(started.alreadyRunning).toBe(false);
      startedRuns += 1;
      const pressed = await browser.execute(
        rendererMountAndPress,
        `#${RESEARCH_CLASSES.tabPrefix}${RESEARCH_TEXT.tabResearchId}`,
        `.${RESEARCH_CLASSES.runBox} button`,
        5_000,
      );
      if (pressed.clicked) {
        answered = await pollUntil(
          async () =>
            (await readResearch(rb)).status === RESEARCH_TEXT.statusAlreadyRunning || null,
          { timeoutMs: 8_000, intervalMs: 100, describe: "the already-running sentence" },
        ).catch(() => false);
      }
      if (!answered && attempt < 4) {
        await env.restart();
        await waitForConnected(rb);
      }
    }
    expect(answered).toBe(true);
    // "Showing it here": the Current run row is there, and the press started nothing new.
    const shown = await readResearch(rb);
    expect(shown.runStatus.rows.some((row) => row.label === RESEARCH_TEXT.currentRunLabel)).toBe(
      true,
    );
    expect(await jobCount()).toBe(beforeSecond + startedRuns);
    await waitForIdle(env);
  });

  it("[07-UAT#12] The service stops mid-run", async () => {
    env.prepared.select("slow");
    await openResearch(rb);
    expect(await pressRunNow(rb)).toBe(true);
    const running = await pollUntil(
      async () => {
        const read = await readResearch(rb);
        return read.runStatus.rows.some((row) => row.label === RESEARCH_TEXT.currentRunLabel)
          ? read
          : null;
      },
      { timeoutMs: 30_000, intervalMs: 250, describe: "the Current run row" },
    );
    expect(running.runNow.disabled).toBe(true);
    const inFlight = (await env.research.status()).inFlight;
    if (inFlight === null) throw new Error("The service reports no run in flight.");

    // Stop the service while the run is in its fetch, then start it again.
    await env.stopService();
    await env.startService();
    await waitForConnected(rb);
    const read = await pollUntil(
      async () => {
        const state = await readResearch(rb);
        return checkUnknownRun(state).length === 0 ? state : null;
      },
      { timeoutMs: 30_000, intervalMs: 250, describe: "the Unknown run row" },
    );
    expect(checkUnknownRun(read)).toEqual([]);
    const store = await readResearchStore(env.context);
    expect(store.jobs.find((entry) => entry.job_run_id === inFlight.runId)?.state).toBe("stale");
    expect(store.runs.find((entry) => entry.run_id === inFlight.runId)?.state).toBe("stale");

    // A new Run now completes.
    const again = await runScenario(rb, env, "base");
    expect(again.ok).toBe(true);
  });

  it("[07-UAT#13] Re-running reuses unchanged snapshots and updates wiki notes in place", async () => {
    clearResearchNotes(vaultPath(), env.context.runRoot);
    env.prepared.select("base");
    const firstRun = await runViaApi(env);
    const first = notesSnapshot(vaultNotes());
    expect(first.raw).toHaveLength(3);
    const secondRun = await runViaApi(env);
    const second = notesSnapshot(vaultNotes());
    let third = second;
    env.prepared.changeBaseFeed();
    try {
      await runViaApi(env);
      third = notesSnapshot(vaultNotes());
    } finally {
      env.prepared.restoreBaseFeed();
    }
    expect(secondRun).not.toBe(firstRun);
    expect(checkReuse({ first, second, third })).toEqual([]);

    // The first report's snapshots still exist and open, the changed source's included.
    const report = vaultNotes().output.find((note) => scalarOf(note.text, "jobRunId") === firstRun);
    if (report === undefined) throw new Error("The first run's report is gone.");
    const paths = parseReportNote(report.text, KIND_LABELS).snapshotPaths;
    expect(paths).toHaveLength(3);
    for (const path of paths) expect(vaultNotes().raw.map((note) => note.path)).toContain(path);
    const changedSource = paths[0] ?? "";
    await readNoteInReadingView(rb, changedSource);
    await waitForNoteOpen(rb, changedSource);
  });

  it("[07-UAT#14] Disconnect drill", async () => {
    const run = await runScenario(rb, env, "base");
    expect(run.ok).toBe(true);
    const reader = await openReport(rb, 0, { items: 3, sources: 3 });
    const rows = (await readResearch(rb)).list.rows.length;
    const report = vaultNotes().output.find(
      (note) => scalarOf(note.text, "jobRunId") === run.runId,
    );
    if (report === undefined) throw new Error("The run left no report note.");
    const address = parseReportNote(report.text, KIND_LABELS).sourceRefs[0]?.canonicalUrl ?? "";
    expect(address).not.toBe("");
    expect(reader.hasOpenNote).toBe(true);
    await browser.execute(rendererInstallSpies);

    await env.stopService();
    const marker = join(vaultPath(), "global", "output", REFETCH_MARKER_NAME);
    try {
      const down = await pollUntil(
        async () => {
          const read = await readResearch(rb);
          return read.dimmed ? read : null;
        },
        { timeoutMs: 60_000, intervalMs: 500, describe: "the destination to dim" },
      );
      expect(checkDisconnectedView(down, { rows, findings: 3 })).toEqual([]);

      // Open note and Copy address are local actions and still work.
      await closeNotes(rb);
      expect(
        await browser.execute(
          rendererClickByText,
          `.${RESEARCH_CLASSES.readerActions} button`,
          RESEARCH_TEXT.openNoteLabel,
        ),
      ).toBe(true);
      await waitForNoteOpen(rb, report.path);
      expect(
        await browser.execute(rendererClickInSource, "1", RESEARCH_TEXT.copyAddressLabel),
      ).toBe(true);
      await pollUntil(
        async () => (await browser.execute(rendererReadSpies)).clipboard.at(-1) === address,
        { timeoutMs: 10_000, intervalMs: 100, describe: "the address on the clipboard" },
      );
      expect((await readResearch(rb)).status).toBe(RESEARCH_TEXT.addressCopied);

      // While the service is away a file that is not a report appears; the list fetched again
      // on reconnect shows it as an unreadable row.
      writeFileSync(marker, "not a report\n");
      await env.startService();
      const back = await waitForConnected(rb);
      expect(checkReconnectedView(back)).toEqual([]);
      await pollUntil(
        async () => (await readResearch(rb)).list.rows.some((row) => row.unreadable) || null,
        {
          timeoutMs: 30_000,
          intervalMs: 500,
          describe: "the list to be fetched again after reconnect",
        },
      );
    } finally {
      rmSync(marker, { force: true });
    }
  });

  it("[07-UAT#21] Logs and settings stay private", async () => {
    const run = await runScenario(rb, env, "query");
    expect(run.ok).toBe(true);
    const configDir = await obsidianPage.getConfigDir();
    const dataText = await obsidianPage.read(
      await pluginDataPath({ getConfigDir: async () => configDir }),
    );
    const data = JSON.parse(dataText) as unknown;
    expect(checkPluginDataKeys(data, { socketPath: env.context.socketPath })).toEqual([]);
    const logs = readAllServiceLogs(env.context);
    expect(
      checkLogPrivacy(
        [
          { label: "the service log", text: logs },
          { label: "the plugin data file", text: dataText },
        ],
        privacyMarkers(),
      ),
    ).toEqual([]);
    // The runs of this file used addresses with a query string; none of them is in the log.
    expect(scenarioSources("query").some((source) => source.url.includes("?"))).toBe(true);
  });
});
