import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ResearchReportItemsPage, ResearchReportItemsPageSchema } from "@ccc/domain";
import { RAW_SOURCE_BANNER } from "@ccc/vault-repo";
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

  it("uses the exported predicate and no second matcher", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "view-model.ts"),
      "utf8",
    );
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(code).toMatch(/import \{[^}]*\bquoteInSource\b[^}]*\} from "@ccc\/research"/);
    expect(code.match(/quoteInSource\(/g)).toHaveLength(1);
    // No normaliser, whole-word search or substring test of its own.
    for (const forbidden of [
      "normaliseForQuoteMatch",
      "findWholeWord",
      "quoteInNormalisedSource",
      "isSubstantialQuote",
      ".includes(item.quote",
      ".indexOf(item.quote",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    // The text it checks against is what the raw note read-back returns.
    expect(code).toMatch(/readRawSourceNote\(/);
  });
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
