import { describe, expect, it } from "vitest";
import { applyRatification } from "./apply-ratification.js";

/** Wave 3 IN-02: a CRLF script gets its result lines and counts written, endings kept. */

const LINES = [
  "---",
  "status: testing",
  "---",
  "",
  "## Tests",
  "",
  "### 1. Deny",
  "run: auto",
  "via: dom",
  "spec: packages/e2e/specs/x.e2e.ts::[06-UAT#01]",
  "auto-result: pass @ 0123abcd 2026-10-12",
  "expected: |",
  "  Deny.",
  "result: [pending]",
  "",
  "## Summary",
  "",
  "total: 1",
  "passed: 0",
  "issues: 0",
  "pending: 1",
  "skipped: 0",
  "blocked: 0",
  "",
];

describe("applyRatification line endings (IN-02)", () => {
  it("writes the same result line and counts for LF and CRLF", () => {
    const lf = applyRatification(LINES.join("\n"), "0123abcd");
    const crlf = applyRatification(LINES.join("\r\n"), "0123abcd");
    expect(lf.items).toEqual([1]);
    expect(crlf.items).toEqual([1]);
    expect(crlf.text).toBe(lf.text.replace(/\n/g, "\r\n"));
    expect(crlf.text).toContain("passed: 1\r\n");
    expect(crlf.text).toContain("pending: 0\r\n");
  });
});
