import { describe, expect, it } from "vitest";
import { applyAutoResults } from "./apply-auto-results.js";

/** Wave 2 review MEDIUM-5: the summary counts only the current run's auto-results. */

function item(number: number, extra: string[]): string[] {
  return [
    `### ${number}. Item ${number}`,
    "run: auto",
    "via: dom",
    `spec: packages/e2e/specs/x.e2e.ts::[06-UAT#${String(number).padStart(2, "0")}]`,
    ...extra,
    "expected: |",
    "  Something happens.",
    "result: [pending]",
    "",
  ];
}

const SCRIPT = [
  "---",
  "status: complete",
  "phase: 06-demo",
  "---",
  "",
  "## Tests",
  "",
  ...item(20, []),
  ...item(21, ["auto-result: pass @ aaaaaaaa 2026-10-01"]),
  ...item(22, ["auto-result: pass @ aaaaaaaa 2026-10-01"]),
  "## Summary",
  "",
  "total: 3",
  "auto-passed: 0",
  "auto-failed: 0",
  "owner-pending: 0",
  "",
].join("\n");

describe("applyAutoResults counts only the current run (MEDIUM-5)", () => {
  const RUN = "bbbbbbbb";

  it("an earlier run's pass on a skipped item does not count toward auto-passed", () => {
    const out = applyAutoResults({
      text: SCRIPT,
      outcomes: [
        { item: 20, status: "pass" },
        { item: 21, status: "skipped-profile" },
      ],
      runId: RUN,
      date: "2026-10-11",
    });
    expect(out).toContain("auto-passed: 1");
  });

  it("an item that received no outcome does not count either", () => {
    const out = applyAutoResults({
      text: SCRIPT,
      outcomes: [{ item: 20, status: "pass" }],
      runId: RUN,
      date: "2026-10-11",
    });
    expect(out).toContain("auto-passed: 1");
    expect(out).toContain("auto-failed: 0");
  });

  it("a stale failure from an earlier run does not count as a current failure", () => {
    const text = SCRIPT.replace(
      "auto-result: pass @ aaaaaaaa 2026-10-01",
      "auto-result: fail @ aaaaaaaa 2026-10-01",
    );
    expect(text).not.toBe(SCRIPT);
    const out = applyAutoResults({
      text,
      outcomes: [{ item: 20, status: "pass" }],
      runId: RUN,
      date: "2026-10-11",
    });
    expect(out).toContain("auto-failed: 0");
  });
});
