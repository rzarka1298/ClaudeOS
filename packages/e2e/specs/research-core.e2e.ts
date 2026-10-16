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
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { assertSandboxConnected } from "../src/driver.js";
import { loadRunContext } from "../src/spec-context.js";
import { RESEARCH_TEXT } from "../src/spec-support/research-copy.js";
import { noteHead, scalarOf } from "../src/spec-support/research-notes.js";
import {
  asResearchBrowser,
  clearResearchNotes,
  openResearch,
  pressRunNow,
  readResearchStore,
  readTranscript,
  readVaultNotes,
  type ResearchEnvironment,
  startResearchEnvironment,
  startTranscript,
  VAULT_TASKS_AT_LEAST,
  waitForRunEnd,
} from "../src/spec-support/research-support.js";
import { checkReportRow, checkRunTranscript } from "../src/spec-support/research-verdicts.js";
import {
  asTasksBrowser,
  recordResults,
  runSetUpManagedVault,
} from "../src/spec-support/tasks-support.js";

const rb = asResearchBrowser(browser);
const tb = asTasksBrowser(browser);

describe("research core", () => {
  let env: ResearchEnvironment;

  recordResults(loadRunContext(), (hook) => afterEach(hook as Mocha.Func));

  const vaultNotes = () => readVaultNotes(obsidianPage.getVaultPath(), env.context.runRoot);

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
  });
});
