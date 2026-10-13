import { describe, expect, it } from "vitest";
import { type AutoOutcome, applyAutoResults } from "./apply-auto-results.js";
import { parseUatScript } from "./uat-tags.js";

const RUN_ID = "0a1b2c3d";
const DATE = "2026-10-11";

function script(summaryExtra: string[]): string {
  return [
    "---",
    "status: complete",
    "phase: 06-demo",
    "---",
    "",
    "## Current Test",
    "",
    "[testing complete]",
    "",
    "# Demo UAT",
    "",
    "Agents never mark a result in this file (D-46).",
    "",
    "## Tests",
    "",
    "### 1. Banner look",
    "tags: U-1",
    "run: auto+look",
    "via: spy, shot",
    "spec: packages/e2e/specs/notification-look.e2e.ts::[06-UAT#01]",
    "expected: |",
    "  The banner appears.",
    "  result: this indented line is expected text, not a result",
    'result: pass — banner from Obsidian, title "Approval needed"',
    "",
    "### 2. Click the banner",
    "run: owner",
    "owner-why: banner-click",
    "auto-part: the retained handler opens Approvals",
    "expected: |",
    "  Click the banner.",
    "result: pass",
    "",
    "### 3. Deny",
    "run: auto",
    "via: dom, store",
    "spec: packages/e2e/specs/approvals-core.e2e.ts::[06-UAT#03]",
    "auto-result: fail @ deadbeef 2026-10-01",
    "expected: |",
    "  Deny the request.",
    "result: pass",
    "",
    "### 4. Ten thousand tasks",
    "run: auto",
    "via: dom, proc",
    "spec: packages/e2e/specs/tasks-scale.e2e.ts::[06-UAT#04]",
    "expected: |",
    "  Stays responsive.",
    "result: [pending]",
    "",
    "### 5. Decision",
    "run: owner",
    "owner-why: decision",
    "expected: |",
    "  Acknowledge the risk.",
    "result: [pending]",
    "",
    "## Summary",
    "",
    "total: 5",
    "passed: 3",
    "issues: 0",
    "pending: 2",
    "skipped: 0",
    "blocked: 0",
    ...summaryExtra,
    "",
    "## Gaps",
    "",
    "Script defects only.",
    "",
  ].join("\n");
}

const WITH_COUNTS = script(["auto-passed: 0", "auto-failed: 0", "owner-pending: 0"]);
const WITHOUT_COUNTS = script([]);

const OUTCOMES: AutoOutcome[] = [
  { item: 1, status: "inconclusive (look pending)" },
  { item: 3, status: "pass" },
  { item: 4, status: "skipped-profile" },
];

const TARGET = /^(auto-result|auto-passed|auto-failed|owner-pending): /;

function untouched(text: string): string[] {
  return text.split("\n").filter((line) => !TARGET.test(line));
}

function apply(text: string, outcomes: AutoOutcome[] = OUTCOMES) {
  return applyAutoResults({ text, outcomes, runId: RUN_ID, date: DATE });
}

describe("applyAutoResults (Test 5)", () => {
  it("inserts or replaces exactly one auto-result line after the spec line", () => {
    const out = apply(WITH_COUNTS);
    const lines = out.split("\n");
    const specIndex = lines.findIndex((line) => line.startsWith("spec: packages/e2e/specs/notif"));
    expect(lines[specIndex + 1]).toBe(
      `auto-result: inconclusive (look pending) @ ${RUN_ID} ${DATE}`,
    );
    const parsed = parseUatScript(out);
    expect(parsed.items[2]?.autoResult).toBe(`pass @ ${RUN_ID} ${DATE}`);
    expect(out.match(/^auto-result: /gm)?.length).toBe(2);
    expect(parsed.findings).toEqual([]);
  });

  it("writes nothing for owner items and for items skipped by profile", () => {
    const parsed = parseUatScript(apply(WITH_COUNTS));
    expect(parsed.items[1]?.autoResult).toBeNull();
    expect(parsed.items[3]?.autoResult).toBeNull();
    expect(parsed.items[4]?.autoResult).toBeNull();
  });

  it("updates the three summary counts and leaves the old keys alone", () => {
    const out = apply(WITH_COUNTS);
    const parsed = parseUatScript(out);
    expect(parsed.summary["auto-passed"]).toBe("1");
    expect(parsed.summary["auto-failed"]).toBe("0");
    // Owner item 5 still has a pending result; item 2 has an owner result already.
    expect(parsed.summary["owner-pending"]).toBe("1");
    expect(parsed.summary.pending).toBe("2");
    expect(parsed.summary.passed).toBe("3");
    expect(out).toMatch(/^pending: 2$/m);
  });

  it("adds the three counts after the last summary key when they are missing", () => {
    const out = apply(WITHOUT_COUNTS);
    const lines = out.split("\n");
    const blocked = lines.indexOf("blocked: 0");
    expect(lines.slice(blocked + 1, blocked + 4)).toEqual([
      "auto-passed: 1",
      "auto-failed: 0",
      "owner-pending: 1",
    ]);
  });

  it("counts failures from the written results", () => {
    const out = apply(WITH_COUNTS, [{ item: 3, status: "fail" }]);
    const parsed = parseUatScript(out);
    expect(parsed.summary["auto-failed"]).toBe("1");
    expect(parsed.summary["auto-passed"]).toBe("0");
  });

  it("leaves every other line byte-identical, including all result lines", () => {
    for (const source of [WITH_COUNTS, WITHOUT_COUNTS]) {
      const out = apply(source);
      expect(untouched(out)).toEqual(untouched(source));
      const results = (text: string) => text.split("\n").filter((line) => /^\s*result:/.test(line));
      expect(results(out)).toEqual(results(source));
      expect(results(out).length).toBe(6);
    }
  });

  it("is a no-op the second time with the same input", () => {
    for (const source of [WITH_COUNTS, WITHOUT_COUNTS]) {
      const once = apply(source);
      expect(apply(once)).toBe(once);
    }
  });

  it("never writes the word pending in an auto-result, except the look-pending state", () => {
    const out = apply(WITH_COUNTS, [
      { item: 1, status: "inconclusive" },
      { item: 3, status: "inconclusive (look pending)" },
    ]);
    for (const line of out.split("\n").filter((entry) => entry.startsWith("auto-result: "))) {
      expect(line.replace("(look pending)", "")).not.toMatch(/pending/i);
      expect(line).not.toContain("[pending]");
    }
  });

  it("changes a script with no outcomes only in its summary counts", () => {
    const out = apply(WITHOUT_COUNTS, []);
    expect(untouched(out)).toEqual(untouched(WITHOUT_COUNTS));
    expect(out.match(/^auto-result: /gm)?.length).toBe(1);
  });
});

describe("applyAutoResults refusals (Test 6)", () => {
  it("throws a fixed message if the script has no item for an outcome", () => {
    expect(() => apply(WITH_COUNTS, [{ item: 9, status: "pass" }])).toThrowError(
      "The script has no item for an automated outcome.",
    );
  });

  it("throws a fixed message if an outcome targets an owner item", () => {
    expect(() => apply(WITH_COUNTS, [{ item: 2, status: "pass" }])).toThrowError(
      "An automated outcome cannot be written on an owner item.",
    );
    expect(() => apply(WITH_COUNTS, [{ item: 5, status: "pass" }])).toThrowError(
      "An automated outcome cannot be written on an owner item.",
    );
  });

  it("throws a fixed message for an invalid run id or date", () => {
    const message = "The run id or date is not in the expected form.";
    for (const [runId, date] of [
      ["xyz", DATE],
      ["0A1B2C3D", DATE],
      [RUN_ID, "11/10/2026"],
      [RUN_ID, "2026-10-1"],
    ] as const) {
      expect(() =>
        applyAutoResults({ text: WITH_COUNTS, outcomes: OUTCOMES, runId, date }),
      ).toThrowError(message);
    }
  });

  it("throws for a status that is not an allowed auto-result state", () => {
    const bad = { item: 3, status: "pending" } as unknown as AutoOutcome;
    expect(() => apply(WITH_COUNTS, [bad])).toThrowError(
      "The outcome status is not an allowed auto-result state.",
    );
  });

  it("throws if an automated item has no spec line to place its result after", () => {
    const text = WITH_COUNTS.replace(
      "spec: packages/e2e/specs/approvals-core.e2e.ts::[06-UAT#03]\n",
      "",
    ).replace("auto-result: fail @ deadbeef 2026-10-01\n", "");
    expect(() => apply(text, [{ item: 3, status: "pass" }])).toThrowError(
      "The item has no spec line to place its auto-result after.",
    );
  });

  it("does not echo script text in a refusal", () => {
    try {
      apply(WITH_COUNTS, [{ item: 9, status: "pass" }]);
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("Banner look");
    }
  });
});
