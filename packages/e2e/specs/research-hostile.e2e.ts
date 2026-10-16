/**
 * Hostile-content items of the Phase 7 UAT (plan 07-17, D-28, RSRCH-08, RSRCH-09, research
 * Pitfall 7): sources that carry injected instructions, a forged closing delimiter, scripts, event
 * handlers, a javascript: address, hidden CSS text, comments, shell commands, an image beacon,
 * wikilink embeds and bidi and zero-width characters are fetched through the REAL pipeline from
 * the fixture directory (the documents come from the repository's hostile research corpus, so this
 * file holds no hostile string). The raw snapshots, the reader and Obsidian's Reading view are
 * then checked. No network, no model, no key; authored and CI-verified only (D-15).
 */
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { assertSandboxConnected } from "../src/driver.js";
import { hostileSources } from "../src/research-uat-fixture.js";
import { loadRunContext } from "../src/spec-context.js";
import { RESEARCH_TEXT } from "../src/spec-support/research-copy.js";
import type { RenderedReader } from "../src/spec-support/research-dom.js";
import {
  noteHead,
  parseRawNote,
  scalarOf,
  totalRemoved,
} from "../src/spec-support/research-notes.js";
import {
  asResearchBrowser,
  clearResearchNotes,
  openReport,
  type ResearchEnvironment,
  readItemsPages,
  readNoteInReadingView,
  readResearch,
  readSourcesPage,
  readVaultNotes,
  runScenario,
  sandboxAncestors,
  startResearchEnvironment,
  VAULT_TASKS_AT_LEAST,
  watchDescendants,
} from "../src/spec-support/research-support.js";
import { checkHostileRaw, checkReadingFacts } from "../src/spec-support/research-verdicts.js";
import {
  asTasksBrowser,
  recordResults,
  runSetUpManagedVault,
} from "../src/spec-support/tasks-support.js";

const rb = asResearchBrowser(browser);
const tb = asTasksBrowser(browser);

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

describe("research hostile content", () => {
  let env: ResearchEnvironment;
  /** The one hostile run both items judge, made on demand. */
  let hostile:
    | { runId: string; ok: boolean; descendants: Array<{ pid: number; command: string }> }
    | undefined;

  recordResults(loadRunContext(), (hook) => afterEach(hook as Mocha.Func));

  const vaultNotes = () => readVaultNotes(obsidianPage.getVaultPath(), env.context.runRoot);

  /** The report note and the ids of the hostile run. */
  function reportOfRun(runId: string) {
    const report = vaultNotes().output.find((note) => scalarOf(note.text, "jobRunId") === runId);
    if (report === undefined) throw new Error("The hostile run left no report note.");
    return { note: report, noteId: noteHead(report.text).id ?? "" };
  }

  async function ensureHostileRun() {
    if (hostile !== undefined) return hostile;
    // Anything that appears below the service or the sandbox Obsidian during the run is recorded.
    const watch = watchDescendants(await sandboxAncestors(env.context));
    const run = await runScenario(rb, env, "hostile");
    const descendants = (await watch.stop()).map((node) => ({
      pid: node.pid,
      command: node.command.slice(0, 120),
    }));
    hostile = { runId: run.runId, ok: run.ok, descendants };
    return hostile;
  }

  before(async () => {
    await assertSandboxConnected(tb, { expectedSocketPath: loadRunContext().socketPath });
    env = await startResearchEnvironment();
    await runSetUpManagedVault(tb, VAULT_TASKS_AT_LEAST);
    clearResearchNotes(obsidianPage.getVaultPath(), env.context.runRoot);
  });

  after(async () => {
    await env?.stop();
  });

  it("[07-UAT#09] Hostile source content is delimited, stripped, described and never executed", async () => {
    const run = await ensureHostileRun();
    expect(run.ok).toBe(true);
    // No process was spawned beyond the service and Obsidian while the sources were handled.
    expect(run.descendants).toEqual([]);

    // The raw notes: sanitised text alone inside one fence under the banner, none of the
    // strings the corpus says must go, all of those it says must stay.
    const bySource = new Map(hostileSources().map((entry) => [entry.label, entry]));
    const raws = vaultNotes().raw.map((note) => ({ note, raw: parseRawNote(note.text) }));
    expect(raws).toHaveLength(bySource.size);
    let removed = 0;
    for (const { raw } of raws) {
      const source = bySource.get(raw.title ?? "");
      expect(source).toBeDefined();
      expect(checkHostileRaw(raw, source ?? { forbidden: [], keeps: [] })).toEqual([]);
      removed += totalRemoved(raw.sanitise);
    }
    expect(removed).toBeGreaterThan(0);

    // The reader lists what was removed from each source, and shows findings and titles as text.
    const { noteId } = reportOfRun(run.runId);
    const row = (await env.research.list({})).rows.find(
      (entry) => entry.readable && entry.noteId === noteId,
    );
    if (row === undefined || !row.readable) throw new Error("The hostile report is not listed.");
    const reader = await openReport(rb, 0, { items: row.itemCount, sources: row.sourceTotal });
    expect(reader.activeElements).toBe(0);
    expectRemovedLines(
      reader,
      raws.map((entry) => entry.raw),
    );

    const served = (await readItemsPages(env.research, noteId)).flatMap((page) => page.items);
    expect(reader.findings.map((entry) => collapse(entry.text))).toEqual(
      served.map((entry) => collapse(entry.text)),
    );
    const sources = (await readSourcesPage(env.research, noteId)).sources;
    expect(reader.sources.map((entry) => collapse(entry.title))).toEqual(
      sources.map((entry) => collapse(entry.title)),
    );
    expect(collapse(reader.title)).toBe(collapse(row.title));
  });

  it("[07-UAT#10] Reading view renders nothing active", async () => {
    const run = await ensureHostileRun();
    const { note, noteId } = reportOfRun(run.runId);

    // The hostile report note: no image, frame, script, embed or link; the findings read as text.
    const served = (await readItemsPages(env.research, noteId)).flatMap((page) => page.items);
    const reportFacts = await readNoteInReadingView(rb, note.path);
    expect(checkReadingFacts(reportFacts, { texts: served.map((entry) => entry.text) })).toEqual(
      [],
    );

    // Hostile raw notes of the categories that carry active markup: the sanitised text shows as
    // one code block and nothing else comes out of it.
    const bySource = new Map(hostileSources().map((entry) => [entry.label, entry]));
    const categories = ["script", "javascript-url", "markdown-image-beacon", "wikilink-embed"];
    const chosen = vaultNotes().raw.filter((candidate) => {
      const title = parseRawNote(candidate.text).title ?? "";
      return categories.includes(bySource.get(title)?.category ?? "");
    });
    expect(chosen).toHaveLength(categories.length);
    for (const raw of chosen) {
      const parsed = parseRawNote(raw.text);
      const first = (parsed.fenced ?? "").split("\n").find((line) => line.trim() !== "") ?? "";
      const facts = await readNoteInReadingView(rb, raw.path);
      expect(
        checkReadingFacts(facts, {
          fenced: parsed.fenced ?? "",
          texts: first === "" ? [] : [first],
        }),
      ).toEqual([]);
    }
    expect((await readResearch(rb)).mounted).toBe(true);
  });
});

/**
 * Each source entry's "Removed before summarising" line: `Nothing removed` when the raw note
 * counts nothing, otherwise a sentence that gives every non-zero count.
 */
function expectRemovedLines(reader: RenderedReader, raws: ReturnType<typeof parseRawNote>[]): void {
  expect(reader.sources).toHaveLength(raws.length);
  for (const source of reader.sources) {
    const raw = raws.find((candidate) => candidate.title === source.title);
    expect(raw).toBeDefined();
    const line =
      source.fields.find((field) => field.term === RESEARCH_TEXT.removedBeforeSummarising)?.text ??
      "";
    if (raw === undefined || totalRemoved(raw.sanitise) === 0) {
      expect(line).toBe(RESEARCH_TEXT.nothingRemoved);
    } else {
      expect(line).not.toBe(RESEARCH_TEXT.nothingRemoved);
      for (const count of Object.values(raw.sanitise)) {
        if (count > 0) expect(line).toContain(`${count} `);
      }
    }
  }
}
