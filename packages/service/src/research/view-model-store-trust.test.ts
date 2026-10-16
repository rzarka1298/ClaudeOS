import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ResearchReportItemsPage,
  ResearchReportItemsPageSchema,
  ResearchReportSourcesPageSchema,
  rawSnapshotPathFor,
} from "@ccc/domain";
import { evidenceText } from "@ccc/research";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentHashFor } from "./hash.js";
import {
  type BuiltReport,
  createReportVault,
  type ReportSpec,
  type ReportVault,
} from "./test-support/report-vault.js";
import { buildReportItemsPage, buildReportSourcesPage, findReport } from "./view-model.js";

/**
 * 07-FIX6 (decision D-A, ADR-0030; opus M2, the deeper half): the operational store, not the vault,
 * is the trust root of "verified". The vault is writable by anyone who can reach the owner's files,
 * so a report and its raw source note can be forged TOGETHER (an invented body, its real hash, a
 * frontmatter that agrees, and a report that cites both). Every vault-side check passes on such a
 * pair. Only the record the pipeline wrote to the store at raw-write time tells it from a real
 * run's: a quote counts as evidence only when the report's run exists in the store, the run
 * recorded this source, the raw note hashes to the recorded hash, and the recorded address and
 * snapshot path are the cited ones.
 *
 * The forged pairs here are built with the same writers a real run uses (the strongest forgery an
 * attacker with write access can make); what the attacker cannot do is reach the store.
 */

let vault: ReportVault;
beforeEach(() => {
  vault = createReportVault();
});
afterEach(() => vault.cleanup());

const URL_A = "https://one.example.invalid/a";
const URL_B = "https://two.example.invalid/b";
const SOURCE_A =
  "The maintainers confirmed that the alpha parser is now twice as fast in this release.";
const SOURCE_B = "Version 1.9 fixes a crash when reading empty archives from the cache.";
const QUOTE_A = "the alpha parser is now twice as fast";
const QUOTE_B = "fixes a crash when reading empty archives";
const INVENTED = "The vendor admitted that the beta scheduler silently drops one job in ten.";
const INVENTED_QUOTE = "the beta scheduler silently drops one job in ten";
const NONCE = "0123456789abcdef0123456789abcdef";

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
    ...extra,
  };
}

function forgedSpec(extra: Partial<ReportSpec> = {}): ReportSpec {
  return {
    sources: [{ url: URL_A, title: "Outlet A", text: INVENTED }],
    items: [
      { kind: "source-fact", text: "Scheduler loses jobs.", quote: INVENTED_QUOTE, cites: [0] },
    ],
    ...extra,
  };
}

function entryOf(built: BuiltReport) {
  const found = findReport(vault.root, built.noteId);
  if (found.kind !== "found") throw new Error("expected the report");
  return found.entry;
}

function items(built: BuiltReport): ResearchReportItemsPage {
  const result = buildReportItemsPage(vault.root, vault.store.db, entryOf(built));
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return ResearchReportItemsPageSchema.parse(result.value);
}

function sources(built: BuiltReport) {
  const result = buildReportSourcesPage(vault.root, vault.store.db, entryOf(built));
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return ResearchReportSourcesPageSchema.parse(result.value);
}

/** A finding served with no evidence: an inference, no quote, and the owner told it was withheld. */
const withheld = { kind: "inference", quote: null, quoteUnverified: true } as const;

describe("(e) a genuine run, untouched", () => {
  it("serves every quote as evidence, with the recorded title and address", () => {
    const built = vault.addReport(spec());
    const page = items(built);
    expect(page.items[0]).toMatchObject({ kind: "source-fact", quote: QUOTE_A });
    expect(page.items[1]).toMatchObject({ kind: "source-fact", quote: QUOTE_B });
    expect("quoteUnverified" in (page.items[0] ?? {})).toBe(false);
    expect(page.header.kindCounts).toEqual({
      "source-fact": 2,
      "unverified-claim": 0,
      inference: 1,
    });
    expect(sources(built).sources.map((s) => [s.title, s.canonicalUrl])).toEqual([
      ["Outlet A", URL_A],
      ["Outlet B", URL_B],
    ]);
  });
});

describe("(a) a forged report with a matching forged raw note, for a run the store never saw", () => {
  it("serves the invented quote as an inference with no quote", () => {
    // Everything in the vault is consistent: the body hashes to the cited hash, the raw note's
    // reference agrees with the report's, the id is the hash of the address, the path is derived.
    const built = vault.addReport(
      forgedSpec({ provenance: { registerRun: false, recordSources: "none" } }),
    );
    expect(items(built).items[0]).toMatchObject(withheld);
    expect(items(built).header.kindCounts).toEqual({
      "source-fact": 0,
      "unverified-claim": 0,
      inference: 1,
    });
  });

  it("does the same when the run is real but never recorded this source", () => {
    const built = vault.addReport(forgedSpec({ provenance: { recordSources: "none" } }));
    expect(items(built).items[0]).toMatchObject(withheld);
  });

  it("keeps the finding's text and citations, only the evidence is withheld", () => {
    const built = vault.addReport(
      forgedSpec({ provenance: { registerRun: false, recordSources: "none" } }),
    );
    const item = items(built).items[0];
    expect(item?.text).toBe("Scheduler loses jobs.");
    expect(item?.citations).toEqual([{ number: 1, title: "Outlet A" }]);
    expect(item?.quoteSourceNumber).toBeNull();
  });
});

describe("(b) a genuine run whose raw note and report were then rewritten together", () => {
  it("serves the invented quote as an inference: the recorded hash is the genuine text's", () => {
    // The attacker replaced the body with an invented one, rewrote its hash in the raw note and in
    // the report's citation, and moved the snapshot path with it. The run, the source and the
    // address are the real ones; only the hash the store recorded at raw-write time disagrees.
    const genuineHash = contentHashFor(evidenceText(SOURCE_A, NONCE));
    const built = vault.addReport(
      forgedSpec({
        provenance: {
          edit: (record) => ({
            ...record,
            contentHash: genuineHash,
            snapshotPath: rawSnapshotPathFor(record.sourceId, genuineHash),
          }),
        },
      }),
    );
    expect(items(built).items[0]).toMatchObject(withheld);
  });

  it("serves it as an inference when the recorded hash differs, with the same address", () => {
    const built = vault.addReport(
      spec({
        provenance: {
          edit: (record, index) =>
            index === 0
              ? {
                  ...record,
                  contentHash: contentHashFor("something else"),
                  snapshotPath: rawSnapshotPathFor(
                    record.sourceId,
                    contentHashFor("something else"),
                  ),
                }
              : record,
        },
      }),
    );
    const page = items(built);
    expect(page.items[0]).toMatchObject(withheld);
    expect(page.items[1]).toMatchObject({ kind: "source-fact", quote: QUOTE_B });
  });

  it("serves it as an inference when the body is edited in place, even with the hash rewritten to match", () => {
    const built = vault.addReport(spec());
    const path = join(vault.root, built.rawPaths[0] ?? "");
    const oldHash = built.sourceRefs[0]?.contentHash ?? "";
    const newBody = evidenceText(INVENTED, NONCE);
    const newHash = contentHashFor(newBody);
    const before = readFileSync(path, "utf8");
    const edited = before.replaceAll(oldHash, newHash).replace(SOURCE_A, INVENTED);
    expect(edited).not.toBe(before);
    writeFileSync(path, edited);
    expect(items(built).items[0]).toMatchObject(withheld);
  });
});

describe("(c) a report naming a job run the store does not know", () => {
  it("serves every quote as an inference, even when rows exist under that run id", () => {
    const built = vault.addReport(spec({ provenance: { registerRun: false } }));
    const page = items(built);
    expect(page.items[0]).toMatchObject(withheld);
    expect(page.items[1]).toMatchObject(withheld);
    expect(page.header.kindCounts["source-fact"]).toBe(0);
    expect(page.header.runOutcome).toBeNull();
  });

  it("serves them as inferences when the finished run names another report", () => {
    const built = vault.addReport(spec({ provenance: { runReportNoteId: "z".repeat(25) } }));
    expect(items(built).items[0]).toMatchObject(withheld);
  });
});

describe("(d) one source's record missing while the others exist", () => {
  it("withholds the finding that cites the missing one and keeps the rest", () => {
    const built = vault.addReport(spec({ provenance: { recordSources: [0] } }));
    const page = items(built);
    expect(page.items[0]).toMatchObject({ kind: "source-fact", quote: QUOTE_A });
    expect(page.items[1]).toMatchObject(withheld);
    // The inference that cites both has no quote to withhold.
    expect(page.items[2]).toMatchObject({ kind: "inference", quote: null });
    expect("quoteUnverified" in (page.items[2] ?? {})).toBe(false);
  });

  it("withholds a quote that is only verified for one of two cited sources if the other has no record", () => {
    const both = `${SOURCE_A} ${SOURCE_B}`;
    const built = vault.addReport({
      sources: [
        { url: URL_A, title: "Outlet A", text: both },
        { url: URL_B, title: "Outlet B", text: both },
      ],
      items: [{ kind: "source-fact", text: "Both say it.", quote: QUOTE_A, cites: [0, 1] }],
      provenance: { recordSources: [0] },
    });
    expect(items(built).items[0]).toMatchObject(withheld);
  });
});

describe("the record must agree with what the report cites", () => {
  it("withholds a quote whose record names another address", () => {
    const built = vault.addReport(
      spec({
        provenance: {
          edit: (record, index) =>
            index === 0
              ? { ...record, canonicalUrl: "https://elsewhere.example.invalid/x" }
              : record,
        },
      }),
    );
    expect(items(built).items[0]).toMatchObject(withheld);
  });
});

describe("what is shown comes from the record when there is one", () => {
  it("shows the recorded label and address, not the raw note's or the report's copy", () => {
    const built = vault.addReport(
      spec({
        provenance: {
          edit: (record, index) => (index === 0 ? { ...record, label: "Recorded name" } : record),
        },
      }),
    );
    const page = items(built);
    expect(page.items[0]?.citations).toEqual([{ number: 1, title: "Recorded name" }]);
    expect(sources(built).sources[0]?.title).toBe("Recorded name");
    expect(sources(built).sources[0]?.canonicalUrl).toBe(URL_A);
    // The label is not what verifies: the quote is still evidence.
    expect(page.items[0]).toMatchObject({ kind: "source-fact", quote: QUOTE_A });
  });

  it("shows the recorded address for a source whose record disagrees with the report", () => {
    const built = vault.addReport(
      spec({
        provenance: {
          edit: (record, index) =>
            index === 0
              ? { ...record, canonicalUrl: "https://elsewhere.example.invalid/x" }
              : record,
        },
      }),
    );
    expect(sources(built).sources[0]?.canonicalUrl).toBe("https://elsewhere.example.invalid/x");
  });

  it("falls back to the raw note's title and address when the run has no record", () => {
    const built = vault.addReport(spec({ provenance: { recordSources: "none" } }));
    const served = sources(built).sources[0];
    expect(served?.title).toBe("Outlet A");
    expect(served?.canonicalUrl).toBe(URL_A);
  });
});
