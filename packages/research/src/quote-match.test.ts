// The whole-word edge rule of the one quote predicate (07-FIX3A, F1). A quote may not start or
// stop inside a token: not between two letters (astral letters included, which are surrogate
// pairs in a UTF-16 string), not across an apostrophe, a hyphen, a period or a comma that joins
// two word characters, and not between a sign and the digit it belongs to. Cutting inside a token
// can drop a negation ("won't" to "won") or a sign ("-40" to "40").
//
// Source is pure ASCII: every special character is a \u escape.
import { describe, expect, it } from "vitest";
import { cutAtWord, isSubstantialQuote, quoteInSource } from "./quote-match.js";
import { normaliseForMatch } from "./text-canon.js";

// MATHEMATICAL ITALIC SMALL A: a letter outside the BMP, so two UTF-16 units.
const ASTRAL_A = "\u{1D44E}";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("whole-word edges are code-point aware", () => {
  it("does not verify a quote that starts at an astral letter inside a word", () => {
    const source = `un${ASTRAL_A}pproved after completing all required safety checks`;
    expect(
      quoteInSource(source, `${ASTRAL_A}pproved after completing all required safety checks`),
    ).toBe(false);
    expect(quoteInSource(source, source)).toBe(true);
  });

  it("does not verify a quote that stops at an astral letter inside a word", () => {
    const source = `all required checks pass${ASTRAL_A}ed before release`;
    expect(quoteInSource(source, `all required checks pass${ASTRAL_A}`)).toBe(false);
    expect(
      quoteInSource(`all required checks passed${ASTRAL_A}`, "all required checks passed"),
    ).toBe(false);
  });

  it("does not start a quote after an astral letter that precedes the first character", () => {
    const source = `the cache${ASTRAL_A}s stale entries are never served again`;
    expect(quoteInSource(source, "s stale entries are never served again")).toBe(false);
  });

  it("verifies a quote on astral-letter word boundaries", () => {
    const source = `note: ${ASTRAL_A}pproved after completing all required safety checks, then shipped`;
    expect(
      quoteInSource(source, `${ASTRAL_A}pproved after completing all required safety checks`),
    ).toBe(true);
  });
});

describe("a quote may not cut a token across a joiner", () => {
  const CASES: ReadonlyArray<readonly [name: string, source: string, quote: string]> = [
    [
      "an apostrophe at the end",
      "we confirm that the vendor won't fix this bug",
      "we confirm that the vendor won",
    ],
    [
      "a typographic apostrophe at the end",
      "we confirm that the vendor won\u2019t fix this bug",
      "we confirm that the vendor won",
    ],
    [
      "a hyphen at the start",
      "this build is non-compliant with the policy",
      "compliant with the policy",
    ],
    [
      "a non-breaking hyphen at the start",
      "this build is non\u2010compliant with the policy",
      "compliant with the policy",
    ],
    [
      "a period inside a version at the end",
      "support ends after version 2.4.1 or later",
      "support ends after version 2",
    ],
    [
      "a second period inside a version at the end",
      "support ends after version 2.4.1 or later",
      "support ends after version 2.4",
    ],
    [
      "a comma inside a number at the end",
      "the monthly plan costs about 1,000 dollars",
      "the monthly plan costs about 1",
    ],
    [
      "a comma inside a number at the start",
      "the plan costs 1,000 dollars per month today",
      "000 dollars per month today",
    ],
    [
      "a hyphenated word at the end",
      "we confirm that the rate-limit is not raised",
      "we confirm that the rate",
    ],
    [
      "an apostrophe at the start",
      "they said that it isn't allowed here at all today",
      "t allowed here at all today",
    ],
    [
      "a joiner that ends the quote and continues the token",
      "the config path is set to v2.4.1 here",
      "the config path is set to v2.",
    ],
  ];
  for (const [name, source, quote] of CASES) {
    it(`refuses a quote cut at ${name}`, () => {
      // The quote is substantial, so a refusal can only come from the edge rule.
      expect(isSubstantialQuote(normaliseForMatch(quote)), quote).toBe(true);
      expect(quoteInSource(source, quote), quote).toBe(false);
    });
  }

  it("still verifies the whole token, and quotes that stop at ordinary punctuation", () => {
    const whole: ReadonlyArray<readonly [string, string]> = [
      [
        "we confirm that the vendor won't fix this bug",
        "we confirm that the vendor won't fix this bug",
      ],
      [
        "this build is non-compliant with the policy",
        "this build is non-compliant with the policy",
      ],
      ["support ends after version 2.4.1 or later", "support ends after version 2.4.1"],
      ["It works. The vendor fixed this release quickly.", "The vendor fixed this release quickly"],
      ["see release, the vendor fixed this release, then left", "the vendor fixed this release"],
      ["the vendor fixed this release. Next item", "the vendor fixed this release."],
    ];
    for (const [source, quote] of whole) expect(quoteInSource(source, quote), quote).toBe(true);
  });
});

describe("a sign belongs to the number after it", () => {
  const CASES: ReadonlyArray<readonly [name: string, source: string, quote: string]> = [
    ["a minus sign", "winter lows reach -40 degrees at night here", "40 degrees at night here"],
    [
      "a true minus sign",
      "winter lows reach \u221240 degrees at night here",
      "40 degrees at night here",
    ],
    [
      "a plus sign",
      "growth was +5 percent growth overall this year",
      "5 percent growth overall this year",
    ],
  ];
  for (const [name, source, quote] of CASES) {
    it(`refuses a quote that drops ${name}`, () => {
      expect(isSubstantialQuote(normaliseForMatch(quote)), quote).toBe(true);
      expect(quoteInSource(source, quote), quote).toBe(false);
    });
  }

  it("verifies a quote that keeps the sign", () => {
    expect(
      quoteInSource("winter lows reach -40 degrees at night here", "-40 degrees at night here"),
    ).toBe(true);
    expect(
      quoteInSource(
        "winter lows reach \u221240 degrees at night here",
        "\u221240 degrees at night here",
      ),
    ).toBe(true);
    expect(
      quoteInSource(
        "growth was +5 percent growth overall this year",
        "+5 percent growth overall this year",
      ),
    ).toBe(true);
  });
});

describe("cutAtWord never splits a surrogate pair", () => {
  it("cuts a long run of astral letters on a code point", () => {
    const run = ASTRAL_A.repeat(10);
    for (let limit = 1; limit < 20; limit += 1) {
      const cut = cutAtWord(run, limit);
      expect(cut.length).toBeLessThanOrEqual(limit);
      expect(LONE_SURROGATE.test(cut), `limit ${limit}`).toBe(false);
    }
  });

  it("still cuts at the last space inside the limit", () => {
    expect(cutAtWord("alpha beta gamma", 12)).toBe("alpha beta");
    expect(cutAtWord("alpha", 12)).toBe("alpha");
  });
});
