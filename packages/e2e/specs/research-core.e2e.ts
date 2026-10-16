/**
 * Core research items of the Phase 7 UAT (plan 07-17, D-28, E2E-04): the first open of Research,
 * Run now writing one cited report, the run traced through its stages, the source references, the
 * three kinds, a partial run, an all-sources-failed run and the summariser that is not set up.
 * Every run here is the REAL pipeline of the built service reading a fixture directory with the
 * extractive summariser (no network, no model, no key), in the run's own runtime directory and
 * throwaway vault, so the operational store holds the provenance records a verified quote needs.
 * Notes are read from the sandbox vault copy; the store is read from a copy. Authored and
 * CI-verified only (D-15): the live behaviour is first seen in the orchestrator's run.
 */
import { SOURCE_FAILURE_DISPLAY } from "@ccc/domain";
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { assertSandboxConnected, pollUntil } from "../src/driver.js";
import { loadRunContext } from "../src/spec-context.js";
import { RAW_BANNER, RESEARCH_TEXT } from "../src/spec-support/research-copy.js";
import {
  rendererClickByText,
  rendererClickInSource,
  rendererClickNth,
  rendererReadFocus,
} from "../src/spec-support/research-dom.js";
import {
  missingSourceRefFields,
  noteHead,
  parseRawNote,
  parseReportNote,
  parseRunNote,
  parseStageLog,
  scalarOf,
} from "../src/spec-support/research-notes.js";
import {
  asResearchBrowser,
  clearResearchNotes,
  closeNotes,
  KIND_LABELS,
  openReport,
  openResearch,
  pressRunNow,
  readResearch,
  readResearchStore,
  readServiceLogSince,
  readTranscript,
  readVaultNotes,
  type ResearchEnvironment,
  runScenario,
  serviceLogMark,
  startResearchEnvironment,
  startTranscript,
  VAULT_TASKS_AT_LEAST,
  waitForNoteOpen,
  waitForConnected,
  waitForRunEnd,
} from "../src/spec-support/research-support.js";
import {
  checkFailedView,
  checkFirstOpen,
  checkKindsView,
  checkPartialView,
  checkReportRow,
  checkRunRecords,
  checkRunTranscript,
  checkSourceEntry,
  checkUnconfiguredView,
} from "../src/spec-support/research-verdicts.js";
import {
  asTasksBrowser,
  recordResults,
  runSetUpManagedVault,
} from "../src/spec-support/tasks-support.js";

const rb = asResearchBrowser(browser);
const tb = asTasksBrowser(browser);

describe("research core", () => {
  let env: ResearchEnvironment;
  /** The run of item 2, which items 3 to 5 trace; made on demand when item 2 did not run. */
  let firstRun: { jobRunId: string; reportNoteId: string } | undefined;

  recordResults(loadRunContext(), (hook) => afterEach(hook as Mocha.Func));

  const vaultNotes = () => readVaultNotes(obsidianPage.getVaultPath(), env.context.runRoot);

  /** The report note of a run, from the vault. */
  const reportOf = (jobRunId: string) => {
    const found = vaultNotes().output.find((note) => scalarOf(note.text, "jobRunId") === jobRunId);
    if (found === undefined) throw new Error("The run left no report note.");
    return found;
  };

  /** Runs the base scenario once for the items that trace its report. */
  async function ensureFirstRun(): Promise<{ jobRunId: string; reportNoteId: string }> {
    if (firstRun !== undefined) return firstRun;
    const run = await runScenario(rb, env, "base");
    expect(run.ok).toBe(true);
    firstRun = { jobRunId: run.runId, reportNoteId: noteHead(reportOf(run.runId).text).id ?? "" };
    return firstRun;
  }

  before(async () => {
    // The sandbox is asserted before anything else happens in this file.
    await assertSandboxConnected(tb, { expectedSocketPath: loadRunContext().socketPath });
    env = await startResearchEnvironment();
    await runSetUpManagedVault(tb, VAULT_TASKS_AT_LEAST);
    clearResearchNotes(obsidianPage.getVaultPath(), env.context.runRoot);
  });

  after(async () => {
    await env?.stop();
  });

  it("[07-UAT#01] First open of Research shows the empty state", async () => {
    expect(checkFirstOpen(await openResearch(rb))).toEqual([]);
  });

  it("[07-UAT#02] Run now writes one cited report", async () => {
    await openResearch(rb);
    await startTranscript(rb);
    const notBefore = Date.now() - 5_000;
    expect(await pressRunNow(rb)).toBe(true);
    const ended = await waitForRunEnd(rb);
    const notAfter = Date.now() + 5_000;

    // The status line and the Current run row, as the run went by.
    expect(checkRunTranscript(await readTranscript(rb))).toEqual([]);

    // Reports lists one row: its generation time, the Cached badge, 3 sources and the item count.
    expect(ended.list.rows).toHaveLength(1);
    const row = ended.list.rows[0];
    if (row === undefined) throw new Error("The report list has no row.");
    expect(
      checkReportRow(row, {
        sourcesPhrase: "3 sources",
        itemsPhrase: "3 items",
        notBefore,
        notAfter,
      }),
    ).toEqual([]);
    expect(ended.status).toBe(`${RESEARCH_TEXT.reportReadyPrefix}${row.title}.`);

    // The report note and the run note are on disk, and the store holds the successful run.
    const notes = vaultNotes();
    expect(notes.output).toHaveLength(1);
    const report = notes.output[0];
    if (report === undefined) throw new Error("No report note was written.");
    const head = noteHead(report.text);
    expect(head).toMatchObject({ stage: "output", type: "report" });
    const jobRunId = scalarOf(report.text, "jobRunId");
    expect(jobRunId).not.toBeNull();
    expect(notes.runs.map((note) => note.name)).toContain(`${jobRunId}.md`);
    const store = await readResearchStore(env.context);
    const job = store.jobs.find((entry) => entry.job_run_id === jobRunId);
    expect(job).toMatchObject({ outcome: "success", state: "completed", report_note_id: head.id });
    firstRun = { jobRunId: jobRunId ?? "", reportNoteId: head.id ?? "" };
  });

  it("[07-UAT#03] The run is traceable through every lifecycle stage", async () => {
    const run = await ensureFirstRun();
    const store = await readResearchStore(env.context);
    expect(
      checkRunRecords({
        jobRunId: run.jobRunId,
        notes: vaultNotes(),
        job: store.jobs.find((entry) => entry.job_run_id === run.jobRunId),
        runs: store.runs,
      }),
    ).toEqual([]);
    // The run note lists the note ids each stage produced (a stage with notes names at least one).
    const runNote = parseRunNote(
      vaultNotes().runs.find((note) => note.name === `${run.jobRunId}.md`)?.text ?? "",
    );
    expect(runNote.outcome).toBe("Success");
    expect(
      runNote.stages.filter((entry) => entry.noteIds.length > 0).map((entry) => entry.stage),
    ).toEqual(["raw", "wiki", "deliverable", "output"]);
    expect(
      parseStageLog(store.jobs.find((entry) => entry.job_run_id === run.jobRunId)?.stage_log),
    ).not.toBeNull();
  });

  it("[07-UAT#04] Every finding carries a full source reference", async () => {
    const run = await ensureFirstRun();
    await openResearch(rb);
    const reader = await openReport(rb, 0, { items: 3, sources: 3 });
    const report = parseReportNote(reportOf(run.jobRunId).text, KIND_LABELS);
    expect(report.sourceRefs).toHaveLength(3);
    // The note's sourceRefs carry every field, and each source entry shows the note's values.
    for (const [index, ref] of report.sourceRefs.entries()) {
      expect(missingSourceRefFields(ref)).toEqual([]);
      const source = reader.sources[index];
      if (source === undefined) throw new Error(`The reader has no source ${index + 1}.`);
      expect(checkSourceEntry(source, ref)).toEqual([]);
    }

    // Activating a citation moves focus to its source entry, which offers the way back.
    const citation = reader.findings[0]?.citations[0];
    if (citation === undefined) throw new Error("The first finding cites no source.");
    const sourceNumber = citation.cite.split("-")[1] ?? "";
    expect(await browser.execute(rendererClickNth, `[data-cite="${citation.cite}"]`, 0)).toBe(true);
    const focus = await pollUntil(
      async () => {
        const found = await browser.execute(
          rendererReadFocus,
          "ccc-report-reader",
          "ccc-report-row",
        );
        return found?.tag === "h5" && found.sourceNumber === sourceNumber ? found : null;
      },
      { timeoutMs: 15_000, intervalMs: 250, describe: "focus to move to the cited source entry" },
    );
    expect(focus.inReader).toBe(true);
    const after = (await readResearch(rb)).reader;
    expect(after?.sources[Number(sourceNumber) - 1]?.backTo).toBe(
      `${RESEARCH_TEXT.backToFindingPrefix}${citation.cite.split("-")[0]}`,
    );

    // Open snapshot opens the raw note, whose banner marks it untrusted data.
    const snapshotPath = report.sourceRefs[Number(sourceNumber) - 1]?.snapshotPath ?? "";
    await closeNotes(rb);
    expect(
      await browser.execute(rendererClickInSource, sourceNumber, RESEARCH_TEXT.openSnapshotLabel),
    ).toBe(true);
    await waitForNoteOpen(rb, snapshotPath);
    const raw = vaultNotes().raw.find((note) => note.path === snapshotPath);
    expect(parseRawNote(raw?.text ?? "").banner).toBe(RAW_BANNER);
  });

  it("[07-UAT#05] Reported fact, source claim and model inference, in the view and in the note", async () => {
    // The long scenario's report holds both sourced kinds (12 reported facts, 12 source claims).
    const run = await runScenario(rb, env, "long");
    expect(run.ok).toBe(true);
    const reader = await openReport(rb, 0, { items: 24, sources: 12 });
    const note = parseReportNote(reportOf(run.runId).text, KIND_LABELS);
    expect(note.itemKinds).toHaveLength(24);
    expect(checkKindsView(reader, note)).toEqual([]);
    expect(reader.counts).toBe("12 reported facts · 12 source claims · 0 model inferences");
  });

  it("[07-UAT#06] A partial run lists its unavailable sources", async () => {
    const before = vaultNotes().output.length;
    const run = await runScenario(rb, env, "partial");
    expect(run.ok).toBe(true);
    await openReport(rb, 0, { items: 2, sources: 2 });
    const read = await readResearch(rb);
    expect(
      checkPartialView(read, {
        total: 3,
        unavailable: [{ label: "Announcement page", phrase: SOURCE_FAILURE_DISPLAY.timeout }],
      }),
    ).toEqual([]);
    expect(vaultNotes().output).toHaveLength(before + 1);
    const store = await readResearchStore(env.context);
    expect(store.jobs.find((entry) => entry.job_run_id === run.runId)).toMatchObject({
      outcome: "partial",
      state: "completed",
      source_count: 2,
      source_total: 3,
    });
  });

  it("[07-UAT#07] Every source fails: a failed run and no report", async () => {
    await closeOpenReport();
    const before = vaultNotes().output.length;
    const rowsBefore = (await readResearch(rb)).list.rows.length;
    const run = await runScenario(rb, env, "all-failing");
    expect(run.ok).toBe(false);
    expect(
      checkFailedView(run.read, { reason: RESEARCH_TEXT.failureAllSources, reports: rowsBefore }),
    ).toEqual([]);
    expect(vaultNotes().output).toHaveLength(before);
    const runNote = parseRunNote(
      vaultNotes().runs.find((note) => note.name === `${run.runId}.md`)?.text ?? "",
    );
    expect(runNote).toMatchObject({
      outcome: "Failure",
      error: "all-sources-failed",
      report: null,
    });
    const store = await readResearchStore(env.context);
    expect(store.jobs.find((entry) => entry.job_run_id === run.runId)).toMatchObject({
      outcome: "failure",
      state: "failed",
      error_code: "all-sources-failed",
    });
  });

  it("[07-UAT#08] The summariser is not set up", async () => {
    await restartWithoutSummariser();
    const rawBefore = vaultNotes().raw.length;
    const run = await runScenario(rb, env, "base");
    expect(run.ok).toBe(false);
    expect(checkUnconfiguredView(run.read)).toEqual([]);
    // The service log shows no connection to the summariser host, and the service started without
    // the summariser override (only the fixture fetcher and the test key account were on).
    const log = readServiceLogSince(env.context, restartMark);
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain("anthropic.com");
    expect(log).toContain("research-test-overrides-active");
    expect(log).toContain("key-account");
    expect(log).toContain("fixture-fetcher");
    expect(log).not.toContain("extractive-summariser");
    const store = await readResearchStore(env.context);
    expect(store.jobs.find((entry) => entry.job_run_id === run.runId)).toMatchObject({
      outcome: "failure",
      error_code: "summariser-unconfigured",
    });
    expect(vaultNotes().raw).toHaveLength(rawBefore);
  });

  it("[07-UAT#22] With an empty key account the run fails as summariser-unconfigured before any network call", async () => {
    // Automated part of the owner's live run: the service is still started without the summariser
    // override and with its empty test key account, so the run must stop before it fetches.
    await restartWithoutSummariser();
    const mark = serviceLogMark(env.context);
    const rawBefore = vaultNotes().raw.length;
    const run = await runScenario(rb, env, "base");
    expect(run.ok).toBe(false);
    expect(checkUnconfiguredView(run.read)).toEqual([]);
    const store = await readResearchStore(env.context);
    const job = store.jobs.find((entry) => entry.job_run_id === run.runId);
    expect(job).toMatchObject({ outcome: "failure", error_code: "summariser-unconfigured" });
    // Before any fetch: the stage log never reached the raw stage, and no source note was written.
    const stages = parseStageLog(job?.stage_log) ?? [];
    expect(stages.map((entry) => entry.stage)).not.toContain("raw");
    expect(vaultNotes().raw).toHaveLength(rawBefore);
    expect(readServiceLogSince(env.context, mark)).not.toContain("anthropic.com");
  });

  /** Closes an open report in the one-column layout so the list is what the next run is judged by. */
  async function closeOpenReport(): Promise<void> {
    const read = await readResearch(rb);
    if (read.reader?.hasBackButton === true) {
      await browser.execute(rendererClickByText, "button", RESEARCH_TEXT.backToReportsLabel);
      await pollUntil(async () => (await readResearch(rb)).reader === null, {
        timeoutMs: 15_000,
        intervalMs: 250,
        describe: "the reader to close",
      });
    }
  }

  /** Restarts the throwaway service without the summariser override, once, and waits for the plugin. */
  async function restartWithoutSummariser(): Promise<void> {
    if (withoutSummariser) return;
    restartMark = serviceLogMark(env.context);
    await env.restart({ summariser: false });
    withoutSummariser = true;
    await waitForConnected(rb);
  }
  let withoutSummariser = false;
  /** Where the live service log stood just before the restart, to read only the new service's lines. */
  let restartMark = 0;
});
