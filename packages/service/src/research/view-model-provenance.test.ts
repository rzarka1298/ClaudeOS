import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ResearchReportItemsPage, ResearchReportItemsPageSchema } from "@ccc/domain";
import { quoteInSource } from "@ccc/research";
import { RAW_SOURCE_BANNER, readRawSourceNote } from "@ccc/vault-repo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BuiltReport,
  createReportVault,
  type ReportSpec,
  type ReportVault,
} from "./test-support/report-vault.js";
import { buildReportItemsPage, findReport } from "./view-model.js";

/**
 * Plan 07-14 (provenance, RSRCH-04, RSRCH-05, wave 3 A2/M3 contract): the reader's view model
 * re-verifies every stored quote against the EVIDENCE TEXT read back from the raw note, with the
 * one exported predicate `quoteInSource`. A quote the stored snapshot does not hold (a hand-edited
 * report, an edited or removed raw note) is not shown as evidence: the finding is served as the
 * model's inference, with no quote.
 */

let vault: ReportVault;
beforeEach(() => {
  vault = createReportVault();
});
afterEach(() => vault.cleanup());

const SOURCE_A =
  "The maintainers confirmed that the alpha parser is now twice as fast in this release.";
const SOURCE_B = "Version 1.9 fixes a crash when reading empty archives from the cache.";
const QUOTE_A = "the alpha parser is now twice as fast";
const QUOTE_B = "fixes a crash when reading empty archives";

function twoSources(extra: Partial<ReportSpec> = {}): ReportSpec {
  return {
    sources: [
      { url: "https://one.example.invalid/a", title: "One", text: SOURCE_A },
      { url: "https://two.example.invalid/b", title: "Two", text: SOURCE_B },
    ],
    items: [
      { kind: "source-fact", text: "Parser is faster.", quote: QUOTE_A, cites: [0] },
      { kind: "unverified-claim", text: "A crash is fixed.", quote: QUOTE_B, cites: [1] },
      { kind: "inference", text: "Both are quality work.", cites: [0, 1] },
    ],
    ...extra,
  };
}

function serve(built: BuiltReport): ResearchReportItemsPage {
  const lookup = findReport(vault.root, built.noteId);
  if (lookup.kind !== "found") throw new Error("expected the report");
  const result = buildReportItemsPage(vault.root, vault.store.db, lookup.entry);
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return ResearchReportItemsPageSchema.parse(result.value);
}

describe("quotes are re-verified against the stored evidence text", () => {
  it("serves a quote the stored snapshot holds, unchanged", () => {
    const page = serve(vault.addReport(twoSources()));
    expect(page.items.map((item) => item.kind)).toEqual([
      "source-fact",
      "unverified-claim",
      "inference",
    ]);
    expect(page.items[0]?.quote).toBe(QUOTE_A);
    expect(page.items[1]?.quote).toBe(QUOTE_B);
    expect(page.header.kindCounts).toEqual({
      "source-fact": 1,
      "unverified-claim": 1,
      inference: 1,
    });
  });

  it("serves a quote the snapshot does not hold as an inference with no quote", () => {
    const planted = "a sentence that the source never contained at all";
    const built = vault.addReport(
      twoSources({
        items: [
          { kind: "source-fact", text: "Planted.", quote: planted, cites: [0] },
          { kind: "source-fact", text: "Real.", quote: QUOTE_A, cites: [0] },
        ],
      }),
    );
    const page = serve(built);
    expect(page.items[0]).toMatchObject({
      kind: "inference",
      quote: null,
      quoteSourceNumber: null,
      quoteUnverified: true,
    });
    expect(page.items[0]?.citations).toEqual([{ number: 1, title: "One" }]);
    expect(page.items[1]).toMatchObject({ kind: "source-fact", quote: QUOTE_A });
    expect(page.header.kindCounts).toEqual({
      "source-fact": 1,
      "unverified-claim": 0,
      inference: 1,
    });
  });

  it("requires the quote in every source the finding cites", () => {
    const built = vault.addReport(
      twoSources({
        items: [{ kind: "source-fact", text: "Two sources.", quote: QUOTE_A, cites: [0, 1] }],
      }),
    );
    expect(serve(built).items[0]).toMatchObject({
      kind: "inference",
      quote: null,
      quoteUnverified: true,
    });
  });

  it("does not accept a quote that only the raw note's banner holds", () => {
    const bannerQuote = RAW_SOURCE_BANNER.replace(/\.$/, "").replace(
      `${String.fromCodePoint(0x2014)} `,
      "",
    );
    const built = vault.addReport(
      twoSources({
        items: [{ kind: "source-fact", text: "From the banner.", quote: bannerQuote, cites: [0] }],
      }),
    );
    expect(serve(built).items[0]).toMatchObject({
      kind: "inference",
      quote: null,
      quoteUnverified: true,
    });
  });

  it("does not trust a raw note whose text was edited after the report was written", () => {
    const built = vault.addReport(twoSources());
    const rawPath = join(vault.root, built.rawPaths[0] ?? "");
    const original = readFileSync(rawPath, "utf8");
    writeFileSync(rawPath, original.replace("twice as fast", "three times as fast"));
    const page = serve(built);
    // The edited snapshot is not the one the report cites: its quote is not shown as evidence,
    // while the untouched second source still verifies.
    expect(page.items[0]).toMatchObject({ kind: "inference", quote: null, quoteUnverified: true });
    expect(page.items[1]).toMatchObject({ kind: "unverified-claim", quote: QUOTE_B });
  });

  it("does not show a quote whose raw note is gone", () => {
    const built = vault.addReport(twoSources());
    rmSync(join(vault.root, built.rawPaths[1] ?? ""));
    const page = serve(built);
    expect(page.items[0]).toMatchObject({ kind: "source-fact", quote: QUOTE_A });
    expect(page.items[1]).toMatchObject({ kind: "inference", quote: null, quoteUnverified: true });
  });

  it("does not show a quote whose raw note is no longer the written shape", () => {
    const built = vault.addReport(twoSources());
    const rawPath = join(vault.root, built.rawPaths[0] ?? "");
    const original = readFileSync(rawPath, "utf8");
    writeFileSync(rawPath, original.replace(RAW_SOURCE_BANNER, "Changed banner"));
    expect(serve(built).items[0]).toMatchObject({ kind: "inference", quote: null });
  });
});

describe("the one predicate decides, not a substring test (behaviour, wave 5 fix round)", () => {
  // Text with irregular whitespace and a decomposed letter, as a page can hold it.
  const MESSY =
    "The   maintainers confirmed\tthat the alpha parser is now twice as fast in this release; " +
    "the cafe\u0301 build is also faster.";

  function messy(quote: string) {
    return serve(
      vault.addReport({
        sources: [{ url: "https://one.example.invalid/a", title: "One", text: MESSY }],
        items: [{ kind: "source-fact", text: "A finding.", quote, cites: [0] }],
      }),
    ).items[0];
  }

  it("keeps a quote that differs from the stored text only in whitespace or composition", () => {
    expect(messy("confirmed that the alpha parser is now twice as fast")).toMatchObject({
      kind: "source-fact",
      quote: "confirmed that the alpha parser is now twice as fast",
    });
    expect(messy("the caf\u00e9 build is also faster")).toMatchObject({ kind: "source-fact" });
  });

  it("withholds a quote that starts inside a word although the text contains it", () => {
    const quote = "lpha parser is now twice as fast";
    expect(MESSY.includes(quote)).toBe(true);
    expect(messy(quote)).toMatchObject({ kind: "inference", quote: null, quoteUnverified: true });
  });

  it("withholds a quote that stops inside a word although the text contains it", () => {
    const quote = "the alpha parser is now twice as fa";
    expect(MESSY.includes(quote)).toBe(true);
    expect(messy(quote)).toMatchObject({ kind: "inference", quote: null, quoteUnverified: true });
  });

  it("withholds a quote too short to verify anything although the text contains it", () => {
    const quote = "alpha parser";
    expect(MESSY.includes(quote)).toBe(true);
    expect(messy(quote)).toMatchObject({ kind: "inference", quote: null, quoteUnverified: true });
  });

  it("gives the same verdict as the exported predicate for every case", () => {
    const text = serveEvidence();
    for (const quote of [
      "confirmed that the alpha parser is now twice as fast",
      "lpha parser is now twice as fast",
      "the alpha parser is now twice as fa",
      "alpha parser",
      "the caf\u00e9 build is also faster",
      "The Alpha Parser is now TWICE as fast",
    ]) {
      expect(messy(quote)?.quote === null, quote).toBe(!quoteInSource(text, quote));
    }
  });

  function serveEvidence(): string {
    const built = vault.addReport({
      sources: [{ url: "https://one.example.invalid/a", title: "One", text: MESSY }],
      items: [{ kind: "inference", text: "A finding.", cites: [0] }],
    });
    const raw = readRawSourceNote(vault.root, built.rawPaths[0] ?? "");
    if (!raw.readable || raw.text === null) throw new Error("expected the raw note");
    return raw.text;
  }
});

describe("the downgrade marker (plan 07-15): a withheld quote is said, never silent", () => {
  it("marks exactly the findings whose stored quote failed re-verification", () => {
    const built = vault.addReport(
      twoSources({
        items: [
          {
            kind: "source-fact",
            text: "Planted.",
            quote: "never in any source at all",
            cites: [0],
          },
          { kind: "source-fact", text: "Real.", quote: QUOTE_A, cites: [0] },
          { kind: "unverified-claim", text: "Real claim.", quote: QUOTE_B, cites: [1] },
          { kind: "inference", text: "Authored inference.", cites: [0, 1] },
        ],
      }),
    );
    const page = serve(built);
    expect(page.items.map((item) => item.quoteUnverified === true)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    // The key is absent on every other finding, not present as false or undefined.
    for (const item of page.items.slice(1)) expect("quoteUnverified" in item).toBe(false);
  });

  it("survives the wire: the key is in the JSON of a downgraded finding only", () => {
    const built = vault.addReport(
      twoSources({
        items: [
          {
            kind: "source-fact",
            text: "Planted.",
            quote: "never in any source at all",
            cites: [0],
          },
          { kind: "inference", text: "Authored inference.", cites: [0, 1] },
        ],
      }),
    );
    const wire = JSON.parse(JSON.stringify(serve(built))) as {
      items: Record<string, unknown>[];
    };
    expect(wire.items[0]?.quoteUnverified).toBe(true);
    expect("quoteUnverified" in (wire.items[1] ?? {})).toBe(false);
  });

  it("an edited raw note marks the finding whose snapshot changed, and no other", () => {
    const built = vault.addReport(twoSources());
    const rawPath = join(vault.root, built.rawPaths[0] ?? "");
    writeFileSync(
      rawPath,
      readFileSync(rawPath, "utf8").replace("twice as fast", "three times as fast"),
    );
    const page = serve(built);
    expect(page.items.map((item) => item.quoteUnverified === true)).toEqual([true, false, false]);
  });

  it("leaves kindCounts following what is served, marker included", () => {
    const built = vault.addReport(
      twoSources({
        items: [
          { kind: "source-fact", text: "Planted.", quote: "never in any source", cites: [0] },
        ],
      }),
    );
    const page = serve(built);
    expect(page.header.kindCounts).toEqual({
      "source-fact": 0,
      "unverified-claim": 0,
      inference: 1,
    });
    expect(page.items[0]?.quoteUnverified).toBe(true);
  });
});
