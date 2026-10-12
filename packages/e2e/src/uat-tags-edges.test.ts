import { describe, expect, it } from "vitest";
import { applyAutoResults } from "./apply-auto-results.js";
import { parseUatScript, TAG_CODES } from "./uat-tags.js";

/** Wave 2 review LOW-7: a CRLF script parses, and a repeated item number is flagged. */

const LINES = [
  "---",
  "status: complete",
  "---",
  "",
  "## Tests",
  "",
  "### 1. First",
  "run: auto",
  "via: dom",
  "spec: packages/e2e/specs/x.e2e.ts::[06-UAT#01]",
  "expected: |",
  "  Works.",
  "result: [pending]",
  "",
  "### 2. Second",
  "run: owner",
  "owner-why: banner-click",
  "expected: |",
  "  Click.",
  "result: [pending]",
  "",
  "## Summary",
  "",
  "total: 2",
  "auto-passed: 0",
  "auto-failed: 0",
  "owner-pending: 0",
  "",
];

describe("parseUatScript line endings (LOW-7)", () => {
  it("parses a CRLF script exactly like the LF one", () => {
    const lf = parseUatScript(LINES.join("\n"));
    const crlf = parseUatScript(LINES.join("\r\n"));
    expect(crlf.items.length).toBe(2);
    expect(crlf.items.map((item) => [item.number, item.runClass, item.title])).toEqual(
      lf.items.map((item) => [item.number, item.runClass, item.title]),
    );
    expect(crlf.items[0]?.spec).toBe(lf.items[0]?.spec);
    expect(crlf.findings).toEqual(lf.findings);
    expect(crlf.summary).toEqual(lf.summary);
  });

  it("applyAutoResults keeps CRLF endings on every line, including inserted ones", () => {
    const text = LINES.join("\r\n");
    const out = applyAutoResults({
      text,
      outcomes: [{ item: 1, status: "pass" }],
      runId: "0a1b2c3d",
      date: "2026-10-11",
    });
    expect(out).toContain("auto-result: pass @ 0a1b2c3d 2026-10-11\r\n");
    expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(out).toContain("auto-passed: 1\r\n");
  });
});

describe("duplicate item numbers (LOW-7)", () => {
  const duplicated = [...LINES.slice(0, 14), ...LINES.slice(6, 14), ...LINES.slice(14)].join("\n");

  it("flags a repeated '### N.' heading", () => {
    const parsed = parseUatScript(duplicated);
    const found = parsed.findings.filter((entry) => entry.code === TAG_CODES.itemDuplicate);
    expect(found).toHaveLength(1);
    expect(found[0]?.item).toBe(1);
  });

  it("applyAutoResults refuses to write an outcome onto a duplicated item", () => {
    expect(() =>
      applyAutoResults({
        text: duplicated,
        outcomes: [{ item: 1, status: "pass" }],
        runId: "0a1b2c3d",
        date: "2026-10-11",
      }),
    ).toThrow(/more than once/i);
  });
});
