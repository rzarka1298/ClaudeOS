// Wave 3 review fixes, batch A (07-FIX3A) for the trusted stage. Source is pure ASCII.
import { REPORT_ITEM_QUOTE_MAX_LENGTH } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { validateSummariserOutput } from "./claims.js";

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);

function answer(items: unknown[]): string {
  return JSON.stringify({ items });
}

function ok(result: ReturnType<typeof validateSummariserOutput>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result;
}

describe("F1: a quote longer than the cap is not stored as a prefix", () => {
  // A source sentence whose trailing qualifier sits past the cap.
  const BODY = "alpha beta gamma delta ".repeat(12);
  const LONG = `${BODY}are all valid, except when the cache is cold`;

  it("downgrades a fact whose quote is over the cap instead of storing a cut prefix", () => {
    expect(LONG.length).toBeGreaterThan(REPORT_ITEM_QUOTE_MAX_LENGTH);
    const result = ok(
      validateSummariserOutput(
        answer([
          {
            kind: "source-fact",
            text: "The values are valid.",
            citedSourceIds: [ID_A],
            quote: LONG,
          },
        ]),
        { sources: { [ID_A]: `Intro. ${LONG}. Outro.` } },
      ),
    );
    const item = result.items[0];
    expect(item?.kind).toBe("inference");
    expect(item?.quote).toBeUndefined();
    expect(result.counts.downgraded).toBe(1);
    expect(result.counts.truncated).toBe(1);
  });

  it("keeps a quote exactly at the cap", () => {
    const words = "abcdef ".repeat(34).trim();
    const exact = words.slice(0, REPORT_ITEM_QUOTE_MAX_LENGTH).replace(/ [^ ]*$/, "");
    expect(exact.length).toBeLessThanOrEqual(REPORT_ITEM_QUOTE_MAX_LENGTH);
    const result = ok(
      validateSummariserOutput(
        answer([
          { kind: "source-fact", text: "Six letters.", citedSourceIds: [ID_B], quote: exact },
        ]),
        { sources: { [ID_B]: `Intro. ${exact} Outro.` } },
      ),
    );
    expect(result.items[0]?.kind).toBe("source-fact");
    expect(result.items[0]?.quote).toBe(exact);
    expect(result.counts.truncated).toBe(0);
  });
});

describe("F2: citations are narrowed to the quote holders for every kind that stores a quote", () => {
  const SOURCE_A = "Intro. The team does not fix the cache bug in this release at all.";
  const SOURCE_B = "Unrelated notes about something else entirely.";
  const QUOTE = "does not fix the cache bug in this release";

  for (const kind of ["inference", "source-fact", "unverified-claim"] as const) {
    it(`narrows a ${kind} that cites a source which does not hold its quote`, () => {
      const result = ok(
        validateSummariserOutput(
          answer([
            { kind, text: "The cache bug stays.", citedSourceIds: [ID_A, ID_B], quote: QUOTE },
          ]),
          { sources: { [ID_A]: SOURCE_A, [ID_B]: SOURCE_B } },
        ),
      );
      expect(result.items[0]?.kind).toBe(kind);
      expect(result.items[0]?.quote).toBe(QUOTE);
      expect(result.items[0]?.citedSourceIds).toEqual([ID_A]);
      expect(result.counts.narrowedIds).toBe(1);
    });
  }

  it("keeps an inference's ids when it carries no verified quote", () => {
    const result = ok(
      validateSummariserOutput(
        answer([
          {
            kind: "inference",
            text: "Probably stays.",
            citedSourceIds: [ID_A, ID_B],
            quote: "never in any source at all really",
          },
        ]),
        { sources: { [ID_A]: SOURCE_A, [ID_B]: SOURCE_B } },
      ),
    );
    expect(result.items[0]?.quote).toBeUndefined();
    expect(result.items[0]?.citedSourceIds).toEqual([ID_A, ID_B]);
  });
});
