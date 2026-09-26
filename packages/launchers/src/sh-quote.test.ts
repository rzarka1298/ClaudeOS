import { describe, expect, it } from "vitest";
import { shQuote, UnsafeScriptArgumentError } from "./sh-quote.js";

// NUL built at runtime, never as a literal escape (api.test.ts convention).
const NUL = String.fromCharCode(0);

function refusalOf(value: string): UnsafeScriptArgumentError {
  try {
    shQuote(value);
  } catch (err: unknown) {
    if (err instanceof UnsafeScriptArgumentError) return err;
    throw err;
  }
  throw new Error("shQuote accepted a value it must refuse");
}

describe("shQuote (POSIX 2.2.2 single quotes, D-17)", () => {
  it("wraps a plain value in single quotes", () => {
    expect(shQuote("abc")).toBe("'abc'");
  });

  it("quotes the empty string as an empty pair of single quotes", () => {
    expect(shQuote("")).toBe("''");
  });

  it("replaces each single quote with close-quote, escaped quote, reopen-quote", () => {
    expect(shQuote("it's")).toBe("'it'\\''s'");
    expect(shQuote("''")).toBe("''\\'''\\'''");
  });

  it("leaves every other shell metacharacter literal inside the quotes", () => {
    expect(shQuote("$(touch PWNED) `x` ; & | > < * ? ~ \\ ! #")).toBe(
      "'$(touch PWNED) `x` ; & | > < * ? ~ \\ ! #'",
    );
  });

  it("refuses a NUL byte with reason nul", () => {
    expect(refusalOf(`a${NUL}b`).reason).toBe("nul");
  });

  it("refuses a line feed and a carriage return with reason line-break", () => {
    expect(refusalOf("a\nb").reason).toBe("line-break");
    expect(refusalOf("a\rb").reason).toBe("line-break");
  });

  it("uses a constant message that never echoes the refused value", () => {
    const err = refusalOf("secret-value\nsecond-line");
    expect(err.message).toBe("value cannot be placed in a launch script");
    expect(err.message).not.toContain("secret-value");
    expect(err.name).toBe("UnsafeScriptArgumentError");
  });
});
