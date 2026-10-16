// Coordinator blocker on the quote predicate (07-FIX3A): invisible format characters bind a token,
// bidi and other invisible characters never sit in a verifying quote, a quote never crosses a
// line or block boundary of the evidence text, and a stored quote is made of the source's own
// code points. Source is pure ASCII: every special character is a \u escape.
import { REPORT_ITEM_QUOTE_MAX_LENGTH } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { validateSummariserOutput } from "./claims.js";
import { evidenceText } from "./delimit.js";
import { extractiveSummary } from "./extractive.js";
import { quoteInSource } from "./quote-match.js";
import { normaliseForQuoteMatch } from "./text-canon.js";

const ID = "a".repeat(32);
const NONCE = "0123456789abcdef0123456789abcdef";

// Soft hyphen, zero-width space, non-joiner, joiner, word joiner, byte order mark.
const FORMAT_CHARS = ["\u00AD", "\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF"];
const BIDI_CHARS = [
  "\u200E",
  "\u200F",
  "\u202A",
  "\u202B",
  "\u202C",
  "\u202D",
  "\u202E",
  "\u2066",
  "\u2067",
  "\u2068",
  "\u2069",
];

function answer(quote: string, kind = "source-fact"): string {
  return JSON.stringify({
    items: [{ kind, text: "A finding about the text.", citedSourceIds: [ID], quote }],
  });
}

describe("invisible format characters bind the token they touch", () => {
  for (const c of FORMAT_CHARS) {
    const name = `U+${c.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`;
    it(`${name} before the quote start is inside the token`, () => {
      const source = `the update was un${c}safe checks are required before release`;
      expect(quoteInSource(source, "safe checks are required before release")).toBe(false);
    });
    it(`${name} after the quote end is inside the token`, () => {
      const source = `all required safety checks${c}pass before the release ships`;
      expect(quoteInSource(source, "all required safety checks")).toBe(false);
    });
  }

  it("treats connector punctuation and combining marks as part of the token", () => {
    expect(
      quoteInSource("see snake_case_name is used here always", "case_name is used here always"),
    ).toBe(false);
    expect(
      quoteInSource("see the tie\u203Fcase is used here always", "case is used here always"),
    ).toBe(false);
    expect(
      quoteInSource("all required checks of q\u0301 are done", "all required checks of q"),
    ).toBe(false);
  });

  it("still verifies a quote on ordinary boundaries", () => {
    expect(
      quoteInSource(
        "the update was safe checks are required before release",
        "safe checks are required before release",
      ),
    ).toBe(true);
  });
});

describe("a verifying quote holds no invisible or bidi character", () => {
  for (const c of [...BIDI_CHARS, ...FORMAT_CHARS, "\u0000", "\u2028"]) {
    const name = `U+${c.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`;
    it(`refuses a quote that contains ${name}, even when the source holds the same`, () => {
      const source = `the release was approved by ${c}the board and shipped on time`;
      expect(quoteInSource(source, `approved by ${c}the board and shipped`)).toBe(false);
      expect(quoteInSource(source, "approved by the board and shipped")).toBe(false);
    });
  }

  it("removes every format and bidi character from the evidence text", () => {
    for (const c of [...BIDI_CHARS, ...FORMAT_CHARS]) {
      expect(evidenceText(`a${c}b`, NONCE), `U+${c.codePointAt(0)?.toString(16)}`).toBe("ab");
    }
  });

  it("removes every code point of the format category from the evidence text", () => {
    const FORMAT = /^\p{Cf}$/u;
    for (let code = 0; code < 0x110000; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const c = String.fromCodePoint(code);
      if (FORMAT.test(c)) expect(evidenceText(`x${c}y`), `U+${code.toString(16)}`).toBe("xy");
    }
  });

  it("downgrades a model quote that carries a bidi control", () => {
    const source = "The release was approved by the board and shipped on time.";
    const result = validateSummariserOutput(answer("approved by \u202Ethe board and shipped"), {
      sources: { [ID]: source },
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.items[0]?.kind).toBe("inference");
    expect(result.items[0]?.quote).toBeUndefined();
  });
});

describe("a quote never crosses a line or block boundary of the evidence text", () => {
  const SOURCE = "Intro paragraph ends right here\nSecond paragraph begins right now";

  it("keeps a line break as a hard boundary in the comparison form", () => {
    expect(normaliseForQuoteMatch("a  b \t c\n\n  d\r\ne")).toBe("a b c\nd\ne");
    expect(normaliseForQuoteMatch("  a \u2028 b  ")).toBe("a\nb");
    expect(normaliseForQuoteMatch("a\u00A0\u2003b")).toBe("a b");
  });

  it("verifies a quote inside one line, whatever its inner whitespace", () => {
    expect(quoteInSource(SOURCE, "paragraph  ends\tright   here")).toBe(true);
    expect(quoteInSource(SOURCE, "Second paragraph begins right now")).toBe(true);
  });

  it("refuses a quote that joins the end of one line to the start of the next", () => {
    expect(quoteInSource(SOURCE, "paragraph ends right here Second paragraph begins")).toBe(false);
    expect(quoteInSource(SOURCE, "ends right here\nSecond paragraph begins")).toBe(false);
    expect(quoteInSource(SOURCE, "ends right here\r\n\r\nSecond paragraph begins")).toBe(false);
  });

  it("downgrades a model quote that crosses a block boundary", () => {
    for (const quote of [
      "paragraph ends right here Second paragraph begins",
      "ends right here\nSecond paragraph begins",
    ]) {
      const result = validateSummariserOutput(answer(quote), { sources: { [ID]: SOURCE } });
      if (!result.ok) throw new Error("expected ok");
      expect(result.items[0]?.kind, quote).toBe("inference");
      expect(result.items[0]?.quote, quote).toBeUndefined();
    }
  });

  it("makes the extractive double quote inside one line, and still find items", () => {
    const text =
      "Short title\nThe actual body sentence has plenty of words in it today.\nSecond line goes on for a while too.";
    const input = `<<<SRC id=${ID} nonce=${NONCE}>>>\n${text}\n<<<END nonce=${NONCE}>>>\nSource IDs: ${ID}`;
    const summary = JSON.parse(extractiveSummary(input)) as { items: { quote: string }[] };
    expect(summary.items.length).toBeGreaterThan(0);
    const lines = text.split("\n");
    for (const item of summary.items) {
      expect(
        lines.some((line) => line.includes(item.quote)),
        item.quote,
      ).toBe(true);
    }
  });
});

describe("a stored quote is made of the source's own code points", () => {
  // The source spells "paypal" with a Cyrillic a (U+0430); a Latin quote is a different string.
  const SOURCE = "Please verify your p\u0430ypal account before the end of this month.";

  it("does not verify a look-alike quote spelled with other code points", () => {
    const result = validateSummariserOutput(answer("verify your paypal account before the end"), {
      sources: { [ID]: SOURCE },
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.items[0]?.kind).toBe("inference");
    expect(result.items[0]?.quote).toBeUndefined();
  });

  it("stores exactly the source's own text when the quote is the source's", () => {
    const quote = "verify your p\u0430ypal account before the end";
    const result = validateSummariserOutput(answer(quote), { sources: { [ID]: SOURCE } });
    if (!result.ok) throw new Error("expected ok");
    const stored = result.items[0]?.quote ?? "";
    expect(result.items[0]?.kind).toBe("source-fact");
    expect(stored).toBe(quote);
    const own = new Set(Array.from(evidenceText(SOURCE)));
    expect(Array.from(stored).every((ch) => own.has(ch))).toBe(true);
    expect(evidenceText(SOURCE).includes(stored)).toBe(true);
    expect(stored.length).toBeLessThanOrEqual(REPORT_ITEM_QUOTE_MAX_LENGTH);
  });
});
