// The trusted stage for the summariser's answer (plan 07-07 Task 1, D-06, D-15, research Pattern 6).
// The answer is data: it is parsed strictly, each item is checked on its own, cited ids must have
// been fetched in this run, and a fact or a claim keeps its kind only when its quote is found
// verbatim (after the shared normalisation) in a cited source.
import { ReportItemSchema } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { validateSummariserOutput } from "./claims.js";
import { ADDRESS_REMOVED_MARKER } from "./neutralise.js";
import { normaliseForMatch } from "./text-canon.js";

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const ID_C = "c".repeat(32);
const ID_UNFETCHED = "d".repeat(32);
const ID_E = "e".repeat(32);

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
      validateSummariserOutput(answer([fact({ quote: "cafe\u0301" })]), {
        sources: { [ID_A]: "A caf\u00E9 near the station." },
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

  it("replaces addresses in text and quote, counts them, and keeps the kind", () => {
    const result = ok(
      validateSummariserOutput(
        answer([
          fact({
            text: "Details at https://evil.example/p?d=1 and www.evil.example/x here.",
            citedSourceIds: [ID_E],
            quote: "see https://example.org/a for details",
          }),
        ]),
        { sources: { [ID_E]: "Please see https://example.org/a for details." } },
      ),
    );
    const item = result.items[0];
    expect(item?.kind).toBe("source-fact");
    expect(item?.text).toBe(`Details at ${MARKER} and ${MARKER} here.`);
    expect(item?.quote).toBe(`see ${MARKER} for details`);
    expect(result.counts.addressesRemoved).toBe(3);
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
            quote: "q".repeat(500),
          }),
        ]),
        { sources: { ...SOURCES, [ID_E]: `${"q".repeat(500)} end` } },
      ),
    );
    expect(result.items[0]?.text).toHaveLength(600);
    expect(result.items[1]?.quote).toHaveLength(240);
    expect(result.items[1]?.kind).toBe("source-fact");
    expect(result.counts.truncated).toBe(2);
    for (const item of result.items) expect(ReportItemSchema.safeParse(item).success).toBe(true);
  });

  it("keeps the kind for a very short verified quote (a known limit: the quote does not bind the text)", () => {
    const result = ok(
      validateSummariserOutput(answer([fact({ quote: "x", citedSourceIds: [ID_E] })]), {
        sources: { [ID_E]: "x" },
      }),
    );
    expect(result.items[0]?.kind).toBe("source-fact");
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
