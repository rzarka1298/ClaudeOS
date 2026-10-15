// The trusted stage for the summariser's answer (plan 07-07 Task 1, D-06, D-15, research Pattern 6).
// The answer is data: it is parsed strictly, each item is checked on its own, cited ids must have
// been fetched in this run, and a fact or a claim keeps its kind only when its quote is found
// verbatim (after the shared normalisation) in a cited source.
import {
  REPORT_ITEM_QUOTE_MAX_LENGTH,
  REPORT_ITEM_QUOTE_MIN_LENGTH,
  REPORT_ITEM_QUOTE_MIN_WORDS,
  ReportItemSchema,
} from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { validateSummariserOutput } from "./claims.js";
import { ADDRESS_REMOVED_MARKER } from "./neutralise.js";
import { normaliseForMatch } from "./text-canon.js";

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const ID_C = "c".repeat(32);
const ID_UNFETCHED = "d".repeat(32);
const ID_E = "e".repeat(32);
const LONG_QUOTE = "abcdef ".repeat(80).trim();

const SOURCES = {
  [ID_A]: "Node 24.21 fixes a stream reset in http2. It also updates npm.",
  [ID_B]: "The release notes\nlist   a   new   permission   flag.",
} as const;

function answer(items: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ items, ...extra });
}

function fact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "source-fact",
    text: "Node 24.21 fixes an HTTP/2 stream reset.",
    citedSourceIds: [ID_A],
    quote: "fixes a stream reset in http2",
    ...overrides,
  };
}

function ok(result: ReturnType<typeof validateSummariserOutput>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result;
}

describe("normaliseForMatch", () => {
  it("applies NFC and collapses every whitespace run to one space, trimming the ends", () => {
    expect(normaliseForMatch("  a \t\n b\r\n\r\nc  ")).toBe("a b c");
    expect(normaliseForMatch("e\u0301")).toBe("\u00E9");
    expect(normaliseForMatch("a\u00A0\u2003b")).toBe("a b");
  });

  it("keeps wording and case, and is idempotent", () => {
    expect(normaliseForMatch("Stream Reset")).toBe("Stream Reset");
    const once = normaliseForMatch(" x \n y\u0301 ");
    expect(normaliseForMatch(once)).toBe(once);
  });
});

describe("Task 1 Test 1 (tracer): one answer becomes one validated, cited item", () => {
  it("keeps a source-fact that cites a fetched source and quotes it verbatim", () => {
    const result = ok(validateSummariserOutput(answer([fact()]), { sources: SOURCES }));
    expect(result.items).toEqual([
      {
        kind: "source-fact",
        text: "Node 24.21 fixes an HTTP/2 stream reset.",
        quote: "fixes a stream reset in http2",
        citedSourceIds: [ID_A],
      },
    ]);
    expect(result.counts).toMatchObject({ droppedItems: 0, droppedIds: 0, downgraded: 0 });
  });
});

describe("Task 1 Test 2 (fence): the shape of the whole answer", () => {
  const body = answer([fact()]);

  it("accepts exactly one surrounding json fence", () => {
    const fenced = `\`\`\`json\n${body}\n\`\`\``;
    expect(ok(validateSummariserOutput(fenced, { sources: SOURCES })).items).toHaveLength(1);
    expect(ok(validateSummariserOutput(`  ${fenced}\n`, { sources: SOURCES })).items).toHaveLength(
      1,
    );
  });

  it("refuses two fences, prose around the JSON, an extra top-level key and a bad items value", () => {
    const refused = [
      `\`\`\`json\n${body}\n\`\`\`\n\`\`\`json\n${body}\n\`\`\``,
      `Here is the summary:\n${body}`,
      `${body}\nHope that helps.`,
      `\`\`\`json\n${body}\n\`\`\`\nThanks`,
      `Sure!\n\`\`\`json\n${body}\n\`\`\``,
      answer([fact()], { note: "extra" }),
      JSON.stringify({ items: "nope" }),
      JSON.stringify({ items: { 0: fact() } }),
      JSON.stringify({}),
      JSON.stringify([fact()]),
      "null",
      '"text"',
      "",
      "   ",
      "{",
    ];
    for (const text of refused) {
      const result = validateSummariserOutput(text, { sources: SOURCES });
      expect(result, text).toEqual({ ok: false, code: "summariser-invalid-output" });
    }
  });

  it("accepts 25 items and refuses 26", () => {
    const many = (n: number) =>
      answer(Array.from({ length: n }, () => fact({ kind: "inference", quote: undefined })));
    expect(ok(validateSummariserOutput(many(25), { sources: SOURCES })).items).toHaveLength(25);
    expect(validateSummariserOutput(many(26), { sources: SOURCES })).toEqual({
      ok: false,
      code: "summariser-invalid-output",
    });
  });

  it("accepts an empty items array as a valid answer with no findings", () => {
    const result = ok(validateSummariserOutput('{"items":[]}', { sources: SOURCES }));
    expect(result.items).toEqual([]);
  });
});

describe("Task 1 Test 3 (ids): only sources fetched in this run can be cited", () => {
  it("drops an unfetched id, keeps the others and reports the count", () => {
    const result = ok(
      validateSummariserOutput(answer([fact({ citedSourceIds: [ID_UNFETCHED, ID_A] })]), {
        sources: SOURCES,
      }),
    );
    expect(result.items[0]?.citedSourceIds).toEqual([ID_A]);
    expect(result.items[0]?.kind).toBe("source-fact");
    expect(result.counts.droppedIds).toBe(1);
  });

  it("turns an item left with no ids into inference and counts the downgrade", () => {
    const result = ok(
      validateSummariserOutput(answer([fact({ citedSourceIds: [ID_UNFETCHED] })]), {
        sources: SOURCES,
      }),
    );
    expect(result.items[0]).toMatchObject({ kind: "inference", citedSourceIds: [] });
    expect(result.items[0]?.quote).toBeUndefined();
    expect(result.counts).toMatchObject({ droppedIds: 1, downgraded: 1 });
  });

  it("keeps an inference with no ids as inference", () => {
    const result = ok(
      validateSummariserOutput(
        answer([{ kind: "inference", text: "Probably relevant.", citedSourceIds: [] }]),
        { sources: SOURCES },
      ),
    );
    expect(result.items[0]).toMatchObject({ kind: "inference", citedSourceIds: [] });
    expect(result.counts.downgraded).toBe(0);
  });

  it("does not treat object-prototype names as fetched ids", () => {
    const result = ok(
      validateSummariserOutput(answer([fact({ citedSourceIds: ["__proto__", "constructor"] })]), {
        sources: SOURCES,
      }),
    );
    expect(result.items[0]).toMatchObject({ kind: "inference", citedSourceIds: [] });
  });
});

describe("Task 1 Test 4 (quote check): a reported fact is a machine-verified quotation", () => {
  it("downgrades a source-fact whose quote is in no cited source", () => {
    const result = ok(
      validateSummariserOutput(answer([fact({ quote: "fixes a memory leak in http2" })]), {
        sources: SOURCES,
      }),
    );
    expect(result.items[0]).toMatchObject({ kind: "inference", citedSourceIds: [ID_A] });
    expect(result.items[0]?.quote).toBeUndefined();
    expect(result.counts.downgraded).toBe(1);
  });

  it("downgrades a source-fact with no quote, or a blank one", () => {
    for (const quote of [undefined, "", "   \n "]) {
      const result = ok(validateSummariserOutput(answer([fact({ quote })]), { sources: SOURCES }));
      expect(result.items[0]?.kind, JSON.stringify(quote)).toBe("inference");
    }
  });

  it("looks only in the sources the item cites", () => {
    const result = ok(
      validateSummariserOutput(answer([fact({ citedSourceIds: [ID_B] })]), { sources: SOURCES }),
    );
    expect(result.items[0]?.kind).toBe("inference");
  });

  it("does not take a quote from a source the item does not cite, even when another is cited", () => {
    const result = ok(
      validateSummariserOutput(answer([fact({ citedSourceIds: [ID_UNFETCHED, ID_B] })]), {
        sources: SOURCES,
      }),
    );
    expect(result.items[0]).toMatchObject({ kind: "inference", citedSourceIds: [ID_B] });
    expect(result.counts).toMatchObject({ droppedIds: 1, downgraded: 1 });
  });

  it("ignores whitespace differences and Unicode normalisation form but not wording", () => {
    const spaced = ok(
      validateSummariserOutput(
        answer([
          fact({
            citedSourceIds: [ID_B],
            quote: "release   notes list a new\tpermission flag",
          }),
        ]),
        { sources: SOURCES },
      ),
    );
    expect(spaced.items[0]?.kind).toBe("source-fact");

    const decomposed = ok(
      validateSummariserOutput(answer([fact({ quote: "a cafe\u0301 near the station today" })]), {
        sources: { [ID_A]: "Visit a caf\u00E9 near the station today." },
      }),
    );
    expect(decomposed.items[0]?.kind).toBe("source-fact");

    const reworded = ok(
      validateSummariserOutput(answer([fact({ quote: "fixed a stream reset in http2" })]), {
        sources: SOURCES,
      }),
    );
    expect(reworded.items[0]?.kind).toBe("inference");
  });

  it("applies the same rule to an unverified-claim", () => {
    const verified = ok(
      validateSummariserOutput(answer([fact({ kind: "unverified-claim" })]), { sources: SOURCES }),
    );
    expect(verified.items[0]?.kind).toBe("unverified-claim");
    const unverified = ok(
      validateSummariserOutput(
        answer([fact({ kind: "unverified-claim", quote: "not in the source" })]),
        { sources: SOURCES },
      ),
    );
    expect(unverified.items[0]).toMatchObject({ kind: "inference", citedSourceIds: [ID_A] });
    expect(unverified.counts.downgraded).toBe(1);
  });

  it("keeps a stored quote only when it is verified", () => {
    const kept = ok(
      validateSummariserOutput(
        answer([fact({ kind: "inference", quote: "fixes a stream reset in http2" })]),
        { sources: SOURCES },
      ),
    );
    expect(kept.items[0]?.quote).toBe("fixes a stream reset in http2");
    const dropped = ok(
      validateSummariserOutput(answer([fact({ kind: "inference", quote: "invented words" })]), {
        sources: SOURCES,
      }),
    );
    expect(dropped.items[0]?.quote).toBeUndefined();
    expect(dropped.counts.downgraded).toBe(0);
  });
});

describe("Task 1 Test 5 (kinds): no recommendation is ever stored", () => {
  it("drops and counts a recommendation, an unknown kind and a malformed item, keeping the rest", () => {
    const result = ok(
      validateSummariserOutput(
        answer([
          fact({ kind: "recommendation", text: "You should upgrade now." }),
          fact({ kind: "advice" }),
          fact({ kind: 7 }),
          fact({ text: undefined }),
          fact({ citedSourceIds: "nope" }),
          fact({ extra: true }),
          { ...fact(), citedSourceIds: undefined },
          "not an object",
          null,
          fact(),
        ]),
        { sources: SOURCES },
      ),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.kind).toBe("source-fact");
    expect(result.counts.droppedItems).toBe(9);
    for (const item of result.items) expect(item.kind).not.toBe("recommendation");
  });

  it("keeps inference items as inference with their surviving ids", () => {
    const result = ok(
      validateSummariserOutput(
        answer([
          { kind: "inference", text: "Likely a patch release.", citedSourceIds: [ID_A, ID_B] },
        ]),
        { sources: SOURCES },
      ),
    );
    expect(result.items[0]).toMatchObject({
      kind: "inference",
      citedSourceIds: [ID_A, ID_B],
    });
  });

  it("drops an item that cites more than eight sources, and de-duplicates repeated ids", () => {
    const nine = Array.from({ length: 9 }, () => ID_A);
    const tooMany = ok(
      validateSummariserOutput(answer([fact({ citedSourceIds: nine })]), { sources: SOURCES }),
    );
    expect(tooMany.items).toHaveLength(0);
    const repeated = ok(
      validateSummariserOutput(answer([fact({ citedSourceIds: [ID_A, ID_A] })]), {
        sources: SOURCES,
      }),
    );
    expect(repeated.items[0]?.citedSourceIds).toEqual([ID_A]);
  });
});

describe("Task 1 Test 6 (result shape): every returned item parses with the domain schema", () => {
  it("parses each item with ReportItemSchema", () => {
    const result = ok(
      validateSummariserOutput(
        answer([
          fact(),
          fact({ kind: "unverified-claim", citedSourceIds: [ID_A, ID_B] }),
          fact({ quote: "not there" }),
          { kind: "inference", text: "Own reading.", citedSourceIds: [] },
          fact({ citedSourceIds: [ID_C] }),
        ]),
        { sources: { ...SOURCES, [ID_C]: "Other text." } },
      ),
    );
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(ReportItemSchema.safeParse(item).success).toBe(true);
    }
  });
});

describe("Task 1 never throws", () => {
  it("returns invalid output, never an exception, for random strings and odd inputs", () => {
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed;
    };
    const alphabet = '{}[]",:\\ \n`json items kind text 0123456789abcdef\u0000\u202E\ud800';
    for (let i = 0; i < 2000; i += 1) {
      const length = next() % 80;
      let text = "";
      for (let j = 0; j < length; j += 1) text += alphabet[next() % alphabet.length];
      const result = validateSummariserOutput(text, { sources: SOURCES });
      expect(result.ok, JSON.stringify(text)).toBe(false);
    }
  });

  it("survives pathological and non-string input", () => {
    const deep = `${"[".repeat(200_000)}${"]".repeat(200_000)}`;
    expect(validateSummariserOutput(deep, { sources: SOURCES }).ok).toBe(false);
    expect(validateSummariserOutput("x".repeat(5_000_000), { sources: SOURCES }).ok).toBe(false);
    for (const odd of [undefined, null, 5, {}, [], Symbol("s")]) {
      const result = validateSummariserOutput(odd as unknown as string, { sources: SOURCES });
      expect(result).toEqual({ ok: false, code: "summariser-invalid-output" });
    }
  });
});

describe("Task 2 (neutralised items): no address, markup or invisible character reaches a stored item", () => {
  const MARKER = ADDRESS_REMOVED_MARKER;

  it("replaces addresses in the text and counts them, keeping the kind", () => {
    const result = ok(
      validateSummariserOutput(
        answer([
          fact({
            text: "Details at https://evil.example/p?d=1 and www.evil.example/x here.",
          }),
        ]),
        { sources: SOURCES },
      ),
    );
    const item = result.items[0];
    expect(item?.kind).toBe("source-fact");
    expect(item?.text).toBe(`Details at ${MARKER} and ${MARKER} here.`);
    expect(result.counts.addressesRemoved).toBe(2);
    expect(result.counts.downgraded).toBe(0);
  });

  it("checks the quote as the model wrote it, before neutralising", () => {
    // A zero-width character inside the quote would be removed by neutralising; the check must
    // still see the original and refuse it.
    const result = ok(
      validateSummariserOutput(answer([fact({ quote: "fixes a stream\u200B reset in http2" })]), {
        sources: SOURCES,
      }),
    );
    expect(result.items[0]?.kind).toBe("inference");
    expect(result.counts.downgraded).toBe(1);
  });

  it("strips invisible characters from stored text and counts them", () => {
    const result = ok(
      validateSummariserOutput(
        answer([fact({ text: "Fixes\u202E a\u200D reset.\nSecond\tline." })]),
        {
          sources: SOURCES,
        },
      ),
    );
    expect(result.items[0]?.text).toBe("Fixes a reset. Second line.");
    expect(result.counts.controlCharsRemoved).toBe(2);
  });

  it("drops an item whose text is empty after neutralising", () => {
    const result = ok(
      validateSummariserOutput(answer([fact({ text: "\u200B\u202E  \n" }), fact()]), {
        sources: SOURCES,
      }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.counts.droppedItems).toBe(1);
  });

  it("cuts a long text and quote after neutralising and counts, never rejecting", () => {
    const longQuote = "fixes a stream reset in http2";
    const result = ok(
      validateSummariserOutput(
        answer([
          fact({ text: "x".repeat(900), quote: longQuote }),
          fact({
            citedSourceIds: [ID_E],
            quote: LONG_QUOTE,
          }),
        ]),
        { sources: { ...SOURCES, [ID_E]: `${LONG_QUOTE} end` } },
      ),
    );
    expect(result.items[0]?.text).toHaveLength(600);
    expect(result.items[1]?.quote).toHaveLength(240);
    expect(result.items[1]?.kind).toBe("source-fact");
    expect(result.counts.truncated).toBe(2);
    for (const item of result.items) expect(ReportItemSchema.safeParse(item).success).toBe(true);
  });

  it("leaves no usable address anywhere in a hostile answer", () => {
    const hostile = [
      "![t](https://beacon.example/p.gif)",
      "[[Secret Plans]] ![[image.png]]",
      "javascript:alert(1) and data:text/html,x and obsidian://open?vault=v",
      "ht\u200Btps://evil.example/x and www.evil.example",
      "<img src=x onerror=y> **bold**",
    ];
    const items = hostile.map((text) => ({
      kind: "inference",
      text,
      citedSourceIds: [ID_A],
      quote: text,
    }));
    const result = ok(validateSummariserOutput(answer(items), { sources: SOURCES }));
    expect(result.items).toHaveLength(hostile.length);
    for (const item of result.items) {
      expect(`${item.text} ${item.quote ?? ""}`).not.toMatch(
        /https?:|www\.|javascript:|data:|obsidian:|:\/\//i,
      );
    }
    expect(result.items[1]?.text).toBe("[[Secret Plans]] ![[image.png]]");
    expect(result.items[4]?.text).toBe("<img src=x onerror=y> **bold**");
  });
});

// --- coordinator hardening (security review of 3638f339) -----------------------------------------
// (a) a minimum quote, (b) folding must not widen a match, (c) a fact cites only the sources that
// hold its quote, (d) the stored quote is verified after neutralising and truncating.

const SENTENCE = "The maintainers confirmed that the http2 stream reset is fixed in this release.";
const HARD_SOURCES = {
  [ID_A]: `${SENTENCE} Other text follows here.`,
  [ID_B]: "Unrelated notes: http2-stream-reset-fixed and released today for everyone.",
  [ID_C]: `Mirror copy. ${SENTENCE}`,
} as const;

function quoted(quote: string, overrides: Record<string, unknown> = {}) {
  return validateSummariserOutput(answer([fact({ quote, ...overrides })]), {
    sources: HARD_SOURCES,
  });
}

describe("Hardening (a): the quote has a minimum", () => {
  it("exports the minimums next to the maximum", () => {
    expect(REPORT_ITEM_QUOTE_MIN_LENGTH).toBe(24);
    expect(REPORT_ITEM_QUOTE_MIN_WORDS).toBe(4);
    expect(REPORT_ITEM_QUOTE_MIN_LENGTH).toBeLessThan(REPORT_ITEM_QUOTE_MAX_LENGTH);
  });

  it("downgrades a short quote that is a perfect substring", () => {
    for (const quote of ["http2", "stream reset", "the", "fixed in this", "a", "e"]) {
      expect(ok(quoted(quote)).items[0]?.kind, quote).toBe("inference");
    }
  });

  it("accepts exactly 24 characters and 4 words, and refuses one character less", () => {
    const edge = "stream reset is fixed in";
    expect(edge).toHaveLength(24);
    expect(ok(quoted(edge)).items[0]?.kind).toBe("source-fact");
    expect(ok(quoted(edge.slice(1))).items[0]?.kind).toBe("inference");
  });

  it("counts words as well as characters", () => {
    const threeWords = "http2-stream-reset-fixed and released";
    expect(threeWords.length).toBeGreaterThanOrEqual(24);
    expect(ok(quoted(threeWords, { citedSourceIds: [ID_B] })).items[0]?.kind).toBe("inference");
    const fourWords = "http2-stream-reset-fixed and released today";
    expect(ok(quoted(fourWords, { citedSourceIds: [ID_B] })).items[0]?.kind).toBe("source-fact");
  });

  it("measures the minimum after normalising, so padding does not count", () => {
    expect(ok(quoted(`http2${" ".repeat(60)}`)).items[0]?.kind).toBe("inference");
    expect(ok(quoted(`   stream reset${"\n".repeat(30)}`)).items[0]?.kind).toBe("inference");
  });

  it("applies the minimum to an unverified-claim and drops the quote of an inference", () => {
    const claim = ok(quoted("http2", { kind: "unverified-claim" }));
    expect(claim.items[0]?.kind).toBe("inference");
    expect(claim.items[0]?.quote).toBeUndefined();
  });
});

describe("Hardening (b): folding never widens a match", () => {
  const exact = "stream reset is fixed in this release";

  it("verifies the exact text", () => {
    expect(ok(quoted(exact)).items[0]?.kind).toBe("source-fact");
  });

  it("does not fold case, punctuation, zero-width characters, a BOM or homoglyphs", () => {
    const variants: Record<string, string> = {
      case: "Stream reset is fixed in this release",
      punctuation: "stream-reset is fixed in this release",
      "zero-width space": "stream reset is\u200B fixed in this release",
      "zero-width joiner": "stream reset is fixed\u200D in this release",
      "byte order mark as a space": "stream\uFEFFreset is fixed in this release",
      "soft hyphen": "stream re\u00ADset is fixed in this release",
      "cyrillic a": "stre\u0430m reset is fixed in this release",
      "cyrillic i": "stream reset \u0456s fixed in this release",
      "fullwidth letters": "\uFF53tream reset is fixed in this release",
      "dotless i": "stream reset \u0131s fixed in this release",
      "braille blank": "stream reset is fixed\u2800in this release",
      "hangul filler": "stream reset is fixed\u3164in this release",
      "hyphen for space": "stream-reset-is-fixed-in-this-release",
      reordered: "reset stream is fixed in this release",
      "extra word": "stream reset is not fixed in this release",
      "dropped word": "stream reset fixed in this release",
    };
    for (const [name, quote] of Object.entries(variants)) {
      const result = ok(quoted(quote));
      expect(result.items[0]?.kind, name).toBe("inference");
      expect(result.items[0]?.quote, name).toBeUndefined();
    }
  });

  it("folds only whitespace and normalisation form", () => {
    for (const quote of [
      "stream   reset\tis\nfixed  in this release",
      "stream\u00A0reset\u2003is fixed in this release",
      "stream reset is fixed in this release  ",
    ]) {
      expect(ok(quoted(quote)).items[0]?.kind, JSON.stringify(quote)).toBe("source-fact");
    }
  });

  it("stores the source's text, never the model's variant", () => {
    const result = ok(quoted("stream   reset\tis\nfixed  in this release"));
    expect(result.items[0]?.quote).toBe(exact);
    const nbsp = ok(quoted("stream\u00A0reset\u2003is fixed in this release"));
    expect(nbsp.items[0]?.quote).toBe(exact);
    const decomposed = ok(
      validateSummariserOutput(answer([fact({ quote: "a cafe\u0301 near the station today" })]), {
        sources: { [ID_A]: "Visit a caf\u00E9 near the station today." },
      }),
    );
    expect(decomposed.items[0]?.quote).toBe("a caf\u00E9 near the station today");
  });
});

describe("Hardening (c): a fact cites only the sources that hold its quote", () => {
  it("keeps only the id whose text contains the quote and counts the narrowing", () => {
    const result = ok(
      quoted("stream reset is fixed in this release", { citedSourceIds: [ID_A, ID_B] }),
    );
    expect(result.items[0]?.citedSourceIds).toEqual([ID_A]);
    expect(result.counts.narrowedIds).toBe(1);
  });

  it("keeps every id whose text contains the quote", () => {
    const result = ok(
      quoted("stream reset is fixed in this release", { citedSourceIds: [ID_A, ID_B, ID_C] }),
    );
    expect(result.items[0]?.citedSourceIds).toEqual([ID_A, ID_C]);
    expect(result.counts.narrowedIds).toBe(1);
  });

  it("narrows an unverified-claim the same way", () => {
    const result = ok(
      quoted("stream reset is fixed in this release", {
        kind: "unverified-claim",
        citedSourceIds: [ID_B, ID_A],
      }),
    );
    expect(result.items[0]).toMatchObject({ kind: "unverified-claim", citedSourceIds: [ID_A] });
  });

  it("keeps all surviving ids on a downgraded item and on an inference", () => {
    const downgraded = ok(
      quoted("not in any source at all here", { citedSourceIds: [ID_A, ID_B] }),
    );
    expect(downgraded.items[0]).toMatchObject({ kind: "inference", citedSourceIds: [ID_A, ID_B] });
    expect(downgraded.counts.narrowedIds).toBe(0);
    const inference = ok(
      quoted("stream reset is fixed in this release", {
        kind: "inference",
        citedSourceIds: [ID_A, ID_B],
      }),
    );
    expect(inference.items[0]).toMatchObject({ kind: "inference", citedSourceIds: [ID_A, ID_B] });
  });
});

describe("Hardening (d): the stored quote is verified after neutralising and truncating", () => {
  const LONG_SENTENCE = `${"alpha beta gamma delta ".repeat(30)}end of the long passage`;

  it("stores a truncated quote that is still a substring of the cited source", () => {
    const result = ok(
      validateSummariserOutput(answer([fact({ citedSourceIds: [ID_E], quote: LONG_SENTENCE })]), {
        sources: { [ID_E]: `Intro. ${LONG_SENTENCE} Outro.` },
      }),
    );
    const stored = result.items[0]?.quote ?? "";
    expect(result.items[0]?.kind).toBe("source-fact");
    expect(stored.length).toBeLessThanOrEqual(REPORT_ITEM_QUOTE_MAX_LENGTH);
    expect(stored.length).toBeGreaterThan(200);
    expect(`Intro. ${LONG_SENTENCE} Outro.`.includes(stored)).toBe(true);
    expect(result.counts.truncated).toBe(1);
  });

  it("downgrades a fact whose verified quote held an address, since the marker breaks the match", () => {
    const text = "Please read the guide at https://docs.example.org/guide before upgrading.";
    const result = ok(
      validateSummariserOutput(
        answer([
          fact({
            citedSourceIds: [ID_E],
            quote: "read the guide at https://docs.example.org/guide before",
          }),
        ]),
        { sources: { [ID_E]: text } },
      ),
    );
    expect(result.items[0]?.kind).toBe("inference");
    expect(result.items[0]?.quote).toBeUndefined();
    expect(result.items[0]?.citedSourceIds).toEqual([ID_E]);
    expect(result.counts).toMatchObject({ downgraded: 1, addressesRemoved: 1 });
    expect(JSON.stringify(result.items)).not.toContain("docs.example.org");
  });

  it("checks every stored quote against its stored ids", () => {
    const sources: Record<string, string> = { ...HARD_SOURCES, [ID_E]: LONG_SENTENCE };
    const result = ok(
      validateSummariserOutput(
        answer([
          fact({
            quote: "stream reset is fixed in this release",
            citedSourceIds: [ID_A, ID_B, ID_C],
          }),
          fact({ quote: LONG_SENTENCE, citedSourceIds: [ID_E, ID_A] }),
          fact({
            quote: "http2-stream-reset-fixed and released today",
            citedSourceIds: [ID_B, ID_A],
          }),
        ]),
        { sources },
      ),
    );
    for (const item of result.items) {
      if (item.quote === undefined) continue;
      for (const id of item.citedSourceIds) {
        const source = (sources[id] ?? "").replace(/\s+/g, " ");
        if (item.kind !== "inference") expect(source.includes(item.quote)).toBe(true);
      }
    }
  });
});

// --- hardening round 2 (07-07 resume): a quote needs real words and whole-word edges ------------------
// A run of punctuation is long enough and "words" apart, yet proves nothing; and a quote that starts
// or stops inside a word can drop a negation ("known" read as "now"), so its edges must sit on word
// boundaries of the source.

describe("Hardening (a2): a quote needs real words, not punctuation runs", () => {
  const RULE = "- - - - - - - - - - - - -";
  const SRC = { [ID_E]: `Heading\n${RULE}\nBody text continues here for the reader.` };

  function check(quote: string, sources: Record<string, string> = SRC) {
    return ok(
      validateSummariserOutput(answer([fact({ citedSourceIds: [ID_E], quote })]), { sources }),
    );
  }

  it("downgrades a punctuation-only quote that is a perfect substring of a cited source", () => {
    expect(RULE.length).toBeGreaterThanOrEqual(REPORT_ITEM_QUOTE_MIN_LENGTH);
    const result = check(RULE);
    expect(result.items[0]?.kind).toBe("inference");
    expect(result.items[0]?.quote).toBeUndefined();
    expect(result.counts.downgraded).toBe(1);
  });

  it("downgrades a quote of four tokens of which only one carries a letter or digit", () => {
    const sources = {
      [ID_E]: "Result: ok ---------- .......... ********** ########## end of notes.",
    };
    const quote = "ok ---------- .......... ********** ########## end";
    expect(quote.length).toBeGreaterThanOrEqual(REPORT_ITEM_QUOTE_MIN_LENGTH);
    expect(check(quote, sources).items[0]?.kind).toBe("inference");
  });

  it("still accepts four real words with punctuation in between", () => {
    const sources = { [ID_E]: "Note: the fix, which shipped today, is stable for all users." };
    expect(check("the fix, which shipped today, is stable", sources).items[0]?.kind).toBe(
      "source-fact",
    );
  });
});

describe("Hardening (b2): a quote starts and stops on whole words of the source", () => {
  it("downgrades a quote that begins inside a word", () => {
    const result = quoted("he http2 stream reset is fixed in this release");
    expect(result.ok && result.items[0]?.kind).toBe("inference");
  });

  it("downgrades a quote that stops inside a word", () => {
    const result = quoted("the http2 stream reset is fixed in this releas");
    expect(result.ok && result.items[0]?.kind).toBe("inference");
  });

  it("downgrades a quote that drops the negation's first letters", () => {
    const sources = { [ID_E]: "The team does not fix the stream reset in this release at all." };
    const result = ok(
      validateSummariserOutput(
        answer([
          fact({ citedSourceIds: [ID_E], quote: "ot fix the stream reset in this release" }),
        ]),
        { sources },
      ),
    );
    expect(result.items[0]?.kind).toBe("inference");
  });

  it("accepts a whole-word quote, one that starts at the source start and one that ends at its end", () => {
    const sources = { [ID_E]: "stream reset fixed in this release" };
    const result = ok(
      validateSummariserOutput(
        answer([fact({ citedSourceIds: [ID_E], quote: "stream reset fixed in this release" })]),
        { sources },
      ),
    );
    expect(result.items[0]?.kind).toBe("source-fact");
  });

  it("finds a whole-word occurrence after a mid-word one", () => {
    const sources = {
      [ID_E]: "unstream reset is fixed in this release. A stream reset is fixed in this release.",
    };
    const result = ok(
      validateSummariserOutput(
        answer([fact({ citedSourceIds: [ID_E], quote: "stream reset is fixed in this release" })]),
        { sources },
      ),
    );
    expect(result.items[0]?.kind).toBe("source-fact");
  });

  it("narrows ids by whole-word holders only", () => {
    const sources = {
      [ID_A]: "unstream reset is fixed in this release",
      [ID_B]: "A stream reset is fixed in this release",
    };
    const result = ok(
      validateSummariserOutput(
        answer([
          fact({
            citedSourceIds: [ID_A, ID_B],
            quote: "stream reset is fixed in this release",
          }),
        ]),
        { sources },
      ),
    );
    expect(result.items[0]?.citedSourceIds).toEqual([ID_B]);
    expect(result.counts.narrowedIds).toBe(1);
  });
});

// --- coordinator blocker 2 (parser differentials) --------------------------------------------------
// (1) JSON.parse keeps the LAST of a duplicated key, so a duplicate could flip a kind after the shape
// check; any duplicate key at any depth, and the keys __proto__ and constructor, refuse the answer.
// (2)+(3) one exported match predicate everywhere. (4) a fence must be the whole answer.

describe("Blocker 2 (1): duplicate and forbidden JSON keys refuse the whole answer", () => {
  const QUOTE_OK = "stream reset is fixed in this release";
  const body = (kindPair: string) =>
    `{"items":[{${kindPair},"text":"x y z","citedSourceIds":["${ID_A}"],"quote":"${QUOTE_OK}"}]}`;
  const options = { sources: HARD_SOURCES };

  it("accepts the same answer without a duplicate", () => {
    const result = validateSummariserOutput(body('"kind":"inference"'), options);
    expect(result.ok).toBe(true);
  });

  it("refuses a duplicate kind inside an item, whichever comes last", () => {
    for (const pair of [
      '"kind":"inference","kind":"source-fact"',
      '"kind":"source-fact","kind":"inference"',
    ]) {
      expect(validateSummariserOutput(body(pair), options)).toEqual({
        ok: false,
        code: "summariser-invalid-output",
      });
    }
  });

  it("refuses a duplicate whose first key is spelled with an escape", () => {
    const result = validateSummariserOutput(
      body('"\\u006bind":"inference","kind":"source-fact"'),
      options,
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a duplicate top-level items key and a duplicate in a later item", () => {
    expect(validateSummariserOutput('{"items":[],"items":[]}', options).ok).toBe(false);
    const later = `{"items":[${answerItemJson()},{"kind":"inference","text":"a b c","text":"d e f","citedSourceIds":[]}]}`;
    expect(validateSummariserOutput(later, options).ok).toBe(false);
  });

  it("refuses __proto__, constructor and prototype keys at any depth", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const inItem = `{"items":[{"kind":"inference","text":"a b c","citedSourceIds":[],"${key}":1}]}`;
      expect(validateSummariserOutput(inItem, options).ok, key).toBe(false);
      const top = `{"items":[],"${key}":{}}`;
      expect(validateSummariserOutput(top, options).ok, key).toBe(false);
    }
  });

  it("does not mistake those words in a value, or the same key in different objects, for a duplicate", () => {
    const text = "the constructor and __proto__ and prototype words are only text";
    const two = `{"items":[{"kind":"inference","text":"${text}","citedSourceIds":[]},{"kind":"inference","text":"${text}","citedSourceIds":[]}]}`;
    const result = validateSummariserOutput(two, options);
    expect(result.ok && result.items).toHaveLength(2);
  });

  function answerItemJson(): string {
    return JSON.stringify({ kind: "inference", text: "a b c", citedSourceIds: [] });
  }
});

describe("Blocker 2 (4): a fence is the whole answer or nothing", () => {
  const good = JSON.stringify({ items: [] });
  const options = { sources: HARD_SOURCES };

  it("refuses text after a fence, text before it, a second fence and an unterminated fence", () => {
    const refused = [
      `\`\`\`json\n${good}\n\`\`\`\nThanks!`,
      `Here you go:\n\`\`\`json\n${good}\n\`\`\``,
      `\`\`\`json\n${good}\n\`\`\`\n\`\`\`json\n${good}\n\`\`\``,
      `\`\`\`json\n${good}\n\`\`\`\n\`\`\``,
      `\`\`\`json\n${good}`,
      `\`\`\`json\n${good}\n\`\`\` \`\`\``,
    ];
    for (const text of refused) {
      expect(validateSummariserOutput(text, options).ok, text).toBe(false);
    }
  });

  it("accepts one fence, with or without the language tag, and triple backticks inside a string", () => {
    const withTicks = JSON.stringify({
      items: [{ kind: "inference", text: "uses ``` fences in text", citedSourceIds: [] }],
    });
    for (const text of [
      `\`\`\`json\n${good}\n\`\`\``,
      `\`\`\`\n${good}\n\`\`\``,
      `\`\`\`json\n${withTicks}\n\`\`\``,
    ]) {
      expect(validateSummariserOutput(text, options).ok, text).toBe(true);
    }
  });
});

describe("Blocker 2 (2)(3): one exported predicate decides every quote check", () => {
  it("exports the predicate and applies the minimum, the words and the whole-word edges", () => {
    const source =
      "Intro. The maintainers confirmed that the http2 stream reset is fixed in this release.";
    expect(quoteInSource(source, "stream reset is fixed in this release")).toBe(true);
    expect(quoteInSource(source, "stream   reset\nis fixed in this  release")).toBe(true);
    expect(quoteInSource(source, "tream reset is fixed in this release")).toBe(false);
    expect(quoteInSource(source, "stream reset is fixed in this releas")).toBe(false);
    expect(quoteInSource(source, "http2")).toBe(false);
    expect(quoteInSource(source, "- - - - - - - - - - - - -")).toBe(false);
  });

  it("re-verifies every stored quote, truncated ones included, through the exported predicate", () => {
    const words = "abcdef ".repeat(80).trim();
    const sources: Record<string, string> = { [ID_E]: `Intro. ${words} Outro.`, ...HARD_SOURCES };
    const result = ok(
      validateSummariserOutput(
        answer([
          fact({ citedSourceIds: [ID_E], quote: words }),
          fact({
            quote: "stream reset is fixed in this release",
            citedSourceIds: [ID_A, ID_B, ID_C],
          }),
          fact({ quote: "Mirror copy. The maintainers", citedSourceIds: [ID_A, ID_C] }),
        ]),
        { sources },
      ),
    );
    expect(result.items.map((i) => i.kind)).toEqual(["source-fact", "source-fact", "source-fact"]);
    const truncated = result.items[0]?.quote ?? "";
    expect(truncated.length).toBeLessThanOrEqual(REPORT_ITEM_QUOTE_MAX_LENGTH);
    expect(truncated.endsWith("abcdef")).toBe(true);
    expect(result.counts.truncated).toBe(1);
    for (const item of result.items) {
      for (const id of item.citedSourceIds) {
        expect(quoteInSource(sources[id] ?? "", item.quote ?? ""), `${item.quote} in ${id}`).toBe(
          true,
        );
      }
    }
  });
});
