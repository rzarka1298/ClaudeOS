import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ResearchReportItemsPage,
  ResearchReportItemsPageSchema,
  ResearchReportSourcesPageSchema,
} from "@ccc/domain";
import { appendJobRunStage, finishJobRun } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BuiltReport,
  createReportVault,
  type ProvenanceSpec,
  type ReportSpec,
  type ReportVault,
} from "./test-support/report-vault.js";
import { buildReportItemsPage, buildReportSourcesPage, findReport } from "./view-model.js";

/**
 * 07-FIX6b (ADR-0030): two ways a quote was still shown as verified after 07-FIX6.
 *
 * MAJOR-1: a run that is not the report's own finished run (failed, cut off, stale, still working
 * and not yet at its output stage, or finished without naming a report) keeps the sources it
 * recorded genuinely, and a forged report could borrow them. Only a run that finished and
 * published THIS report, or that has logged its output stage for it, vouches.
 *
 * MAJOR-2: a forger who keeps a genuine report's note id and run id can rewrite what the report
 * says in place (a claim, a kind, a quote, the run facts) and every source still verifies. The
 * store holds a digest of the report as the run finalised it; a report that no longer matches is
 * not the run's report, so none of its quotes is shown as verified.
 */

let vault: ReportVault;
beforeEach(() => {
  vault = createReportVault();
});
afterEach(() => vault.cleanup());

const URL_A = "https://one.example.invalid/a";
const URL_B = "https://two.example.invalid/b";
const SOURCE_A =
  "The maintainers confirmed that the alpha parser is now twice as fast in this release. The cache was also rebuilt.";
const SOURCE_B = "Version 1.9 fixes a crash when reading empty archives from the cache.";
const QUOTE_A = "the alpha parser is now twice as fast";
const QUOTE_A2 = "The cache was also rebuilt";
const QUOTE_B = "fixes a crash when reading empty archives";

function spec(extra: Partial<ReportSpec> = {}): ReportSpec {
  return {
    sources: [
      { url: URL_A, title: "Outlet A", text: SOURCE_A },
      { url: URL_B, title: "Outlet B", text: SOURCE_B },
    ],
    items: [
      { kind: "source-fact", text: "Parser is faster.", quote: QUOTE_A, cites: [0] },
      { kind: "source-fact", text: "A crash is fixed.", quote: QUOTE_B, cites: [1] },
      { kind: "inference", text: "Both are quality work.", cites: [0, 1] },
    ],
    unavailable: [{ label: "Third feed", code: "timeout" }],
    ...extra,
  };
}

function entryOf(built: BuiltReport) {
  const found = findReport(vault.root, built.noteId);
  if (found.kind !== "found") throw new Error("expected the report to be found and readable");
  return found.entry;
}

function items(built: BuiltReport): ResearchReportItemsPage {
  const result = buildReportItemsPage(vault.root, vault.store.db, entryOf(built));
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return ResearchReportItemsPageSchema.parse(result.value);
}

/** Rewrites the report file in place, as a forger with vault access would. The edit must change it. */
function editReport(built: BuiltReport, edit: (text: string) => string): void {
  const file = join(vault.root, built.path);
  const before = readFileSync(file, "utf8");
  const after = edit(before);
  expect(after, "the edit must change the report").not.toBe(before);
  writeFileSync(file, after);
}

const withheld = { kind: "inference", quote: null, quoteUnverified: true } as const;
const verifiedA = { kind: "source-fact", quote: QUOTE_A } as const;
const verifiedB = { kind: "source-fact", quote: QUOTE_B } as const;

describe("MAJOR-1: only the report's own finished run vouches", () => {
  const run = (provenance: ProvenanceSpec) => vault.addReport(spec({ provenance }));

  it("accepts a run that finished and published this report", () => {
    const page = items(run({}));
    expect(page.items[0]).toMatchObject(verifiedA);
    expect(page.items[1]).toMatchObject(verifiedB);
  });

  it("accepts a run still working that has logged its output stage for this report", () => {
    const page = items(run({ runEnd: "in-flight-output" }));
    expect(page.items[0]).toMatchObject(verifiedA);
  });

  it("refuses a failed run that kept the sources it recorded (it names no report)", () => {
    expect(items(run({ runEnd: "failure" })).items[0]).toMatchObject(withheld);
  });

  it("refuses a run that finished with success but names no report", () => {
    expect(items(run({ runEnd: "success-no-report" })).items[0]).toMatchObject(withheld);
  });

  it("refuses a stale run (cut off, then recovered at start-up)", () => {
    const page = items(run({ runEnd: "stale" }));
    expect(page.items[0]).toMatchObject(withheld);
    expect(page.items[1]).toMatchObject(withheld);
  });

  it("refuses a run still in flight that has not reached its output stage", () => {
    expect(items(run({ runEnd: "in-flight" })).items[0]).toMatchObject(withheld);
  });

  it("refuses a run in flight whose output stage names some other report", () => {
    const built = run({ runEnd: "in-flight-output", runReportNoteId: "z".repeat(25) });
    expect(items(built).items[0]).toMatchObject(withheld);
  });

  it("refuses a run in flight whose output stage came after only earlier stages (deliverable is not output)", () => {
    const built = run({ runEnd: "in-flight" });
    appendJobRunStage(vault.store.db, built.runId as never, {
      stage: "deliverable",
      at: "2026-10-14T10:00:10.000Z",
      noteIds: [built.noteId],
    });
    expect(items(built).items[0]).toMatchObject(withheld);
  });

  it("refuses a finished run that names another report, even with the output stage logged for this one", () => {
    const built = run({ runEnd: "in-flight-output" });
    finishJobRun(vault.store.db, built.runId as never, {
      outcome: "success",
      endedAt: "2026-10-14T10:00:30.000Z",
      sourceCount: 2,
      sourceTotal: 3,
      reportNoteId: "z".repeat(25),
      unavailableSources: [],
      errorCode: null,
    });
    expect(items(built).items[0]).toMatchObject(withheld);
  });
});

describe("MAJOR-2: a report edited in place after its run is not the run's report", () => {
  it("serves every quote of an untouched genuine report as evidence", () => {
    const page = items(vault.addReport(spec()));
    expect(page.items[0]).toMatchObject(verifiedA);
    expect(page.items[1]).toMatchObject(verifiedB);
    expect("quoteUnverified" in (page.items[0] ?? {})).toBe(false);
  });

  it("withholds every quote when a claim's text was changed", () => {
    const built = vault.addReport(spec());
    editReport(built, (text) => text.replace("text: Parser is faster.", "text: Parser is slower."));
    const page = items(built);
    expect(page.items[0]).toMatchObject({ ...withheld, text: "Parser is slower." });
    // The whole report is no longer the run's: the untouched finding loses its quote too.
    expect(page.items[1]).toMatchObject(withheld);
    expect(page.header.kindCounts["source-fact"]).toBe(0);
  });

  it("withholds the quote of an inference flipped to a source fact with a real quote of the source", () => {
    const built = vault.addReport(spec());
    editReport(built, (text) =>
      text.replace(
        "  - kind: inference\n    text: Both are quality work.\n",
        `  - kind: source-fact\n    text: Both are quality work.\n    quote: ${QUOTE_A}\n`,
      ),
    );
    const page = items(built);
    expect(page.items[2]).toMatchObject({ ...withheld, text: "Both are quality work." });
    expect(page.items[0]).toMatchObject(withheld);
  });

  it("withholds a quote swapped for another real quote of the same source", () => {
    const built = vault.addReport(spec());
    editReport(built, (text) => text.replace(`quote: ${QUOTE_A}\n`, `quote: ${QUOTE_A2}\n`));
    const page = items(built);
    expect(page.items[0]).toMatchObject(withheld);
    expect(page.items[1]).toMatchObject(withheld);
  });

  it("withholds the quotes when the run facts were rewritten (unavailable source hidden, partial flipped)", () => {
    const built = vault.addReport(spec());
    editReport(built, (text) =>
      text
        .replace("partial: true\n", "partial: false\n")
        .replace(
          "unavailableSources:\n  - label: Third feed\n    code: timeout\n",
          "unavailableSources: []\n",
        ),
    );
    expect(entryOf(built).frontmatter.partial).toBe(false);
    const page = items(built);
    expect(page.items[0]).toMatchObject(withheld);
    expect(page.items[1]).toMatchObject(withheld);
  });

  it("withholds the quotes when the source total was changed", () => {
    const built = vault.addReport(spec());
    editReport(built, (text) => text.replace(/^sourceTotal: 3$/m, "sourceTotal: 9"));
    expect(items(built).items[0]).toMatchObject(withheld);
  });

  it("withholds the quotes when a finding was dropped", () => {
    const built = vault.addReport(spec());
    editReport(built, (text) =>
      text.replace(
        "  - kind: inference\n    text: Both are quality work.\n    citedSourceIds:\n      - " +
          `${built.sourceRefs[0]?.id}\n      - ${built.sourceRefs[1]?.id}\n`,
        "",
      ),
    );
    const page = items(built);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject(withheld);
  });

  it("withholds the quotes when no report record exists for the run", () => {
    const built = vault.addReport(spec({ provenance: { reportRecord: "none" } }));
    expect(items(built).items[0]).toMatchObject(withheld);
  });

  it("withholds the quotes when the record holds the digest of some other content", () => {
    const built = vault.addReport(spec({ provenance: { reportRecord: "a".repeat(64) } }));
    expect(items(built).items[0]).toMatchObject(withheld);
  });

  it("withholds the quotes when the record names another report note", () => {
    const built = vault.addReport(spec());
    vault.store.db
      .prepare("UPDATE research_report_records SET report_note_id = ?")
      .run("y".repeat(25));
    expect(items(built).items[0]).toMatchObject(withheld);
  });

  it("does not take another run's record for this run's", () => {
    const first = vault.addReport(spec());
    // End the first run's record's relevance: a second report whose own record is missing.
    const second = vault.addReport(spec({ provenance: { reportRecord: "none" } }));
    expect(items(first).items[0]).toMatchObject(verifiedA);
    expect(items(second).items[0]).toMatchObject(withheld);
  });
});

describe("what a rewritten report still shows", () => {
  it("keeps the finding's text and citations, only the evidence is withheld", () => {
    const built = vault.addReport(spec());
    editReport(built, (text) => text.replace("text: Parser is faster.", "text: Parser is slower."));
    const item = items(built).items[0];
    expect(item?.text).toBe("Parser is slower.");
    expect(item?.citations).toEqual([{ number: 1, title: "Outlet A" }]);
    expect(item?.quoteSourceNumber).toBeNull();
  });
});

describe("the title and address served from the record (07-FIX6, MINOR a)", () => {
  it("never serves both addresses: a raw note whose own reference has a deep link is served with the recorded https address only", () => {
    const built = vault.addReport(spec());
    const rawFile = join(vault.root, built.rawPaths[0] ?? "");
    const before = readFileSync(rawFile, "utf8");
    const after = before.replace(
      `canonicalUrl: '${URL_A}'`,
      "deepLink: 'obsidian://open?vault=owner&file=note'",
    );
    expect(after).not.toBe(before);
    writeFileSync(rawFile, after);
    const result = buildReportSourcesPage(vault.root, vault.store.db, entryOf(built));
    if (!result.ok) throw new Error(`refused: ${result.code}`);
    // The schema allows exactly one of the two addresses: parsing the page is the assertion that
    // the served source does not carry the recorded address AND the raw note's deep link.
    const first = ResearchReportSourcesPageSchema.parse(result.value).sources[0];
    expect(first?.canonicalUrl).toBe(URL_A);
    expect(first?.deepLink).toBeUndefined();
    expect(first?.title).toBe("Outlet A");
  });
});
