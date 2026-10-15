// The canonical content-hash input (plan 07-04 Task 2 Test 8, research Pattern 4). Hashing stays
// in the service; this module only fixes the string that is hashed, so the hash is recomputable
// from a raw note body.
import { describe, expect, it } from "vitest";
import { canonicalHashInput, normaliseForMatch } from "./text-canon.js";

describe("Test 8 (hash input): canonical form", () => {
  it("turns CRLF and lone CR into LF", () => {
    expect(canonicalHashInput("a\r\nb\rc")).toBe("a\nb\nc\n");
  });

  it("trims trailing whitespace on every line and keeps leading whitespace", () => {
    expect(canonicalHashInput("a  \n  b\t\t\nc \u00A0")).toBe("a\n  b\nc\n");
  });

  it("ends with exactly one newline however many trailing blank lines there were", () => {
    expect(canonicalHashInput("a")).toBe("a\n");
    expect(canonicalHashInput("a\n")).toBe("a\n");
    expect(canonicalHashInput("a\n\n\n")).toBe("a\n");
    expect(canonicalHashInput("a\r\n \r\n\t\r\n")).toBe("a\n");
  });

  it("keeps interior blank lines", () => {
    expect(canonicalHashInput("a\n\nb")).toBe("a\n\nb\n");
  });

  it("applies NFC", () => {
    expect(canonicalHashInput("e\u0301")).toBe("\u00E9\n");
    expect(canonicalHashInput("\u00E9")).toBe("\u00E9\n");
  });

  it("maps the empty string to a single newline", () => {
    expect(canonicalHashInput("")).toBe("\n");
  });

  it("is idempotent", () => {
    for (const input of ["", "a", "a  \r\n\r\nb\u0301 \r\n\r\n", "x\n\n\n", "  lead\ttrail\t\n"]) {
      const once = canonicalHashInput(input);
      expect(canonicalHashInput(once)).toBe(once);
    }
  });

  it("gives equal output for texts that differ only in line endings, trailing space or composition", () => {
    expect(canonicalHashInput("caf\u00E9 \r\nbar\r\n")).toBe(
      canonicalHashInput("cafe\u0301\nbar   \n\n"),
    );
  });
});

describe("normaliseForMatch (plan 07-07 hardening): what it folds", () => {
  it("collapses real whitespace only, never a byte order mark or a zero-width character", () => {
    expect(normaliseForMatch("a\uFEFFb")).toBe("a\uFEFFb");
    expect(normaliseForMatch("a\u200Bb")).toBe("a\u200Bb");
    expect(normaliseForMatch("a\u00ADb")).toBe("a\u00ADb");
    expect(normaliseForMatch("a\u3164b")).toBe("a\u3164b");
  });

  it("folds the Unicode space separators, line separators and the usual controls", () => {
    expect(
      normaliseForMatch("a\u00A0b\u1680c\u2000d\u200Ae\u2028f\u2029g\u202Fh\u205Fi\u3000j"),
    ).toBe("a b c d e f g h i j");
    expect(normaliseForMatch("a\tb\vc\fd\re\u0085f")).toBe("a b c d e f");
  });

  it("does not fold case, punctuation or look-alike letters", () => {
    expect(normaliseForMatch("A.b-C")).toBe("A.b-C");
    expect(normaliseForMatch("\u0430")).toBe("\u0430");
    expect(normaliseForMatch("\uFF21")).toBe("\uFF21");
  });
});
