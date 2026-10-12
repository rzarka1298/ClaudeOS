import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyRatification } from "./apply-ratification.js";
import { parseUatScript } from "./uat-tags.js";

const RUN = "0a1b2c3d";

function script(): string {
  return [
    "---",
    "status: testing",
    "phase: 06-demo",
    "---",
    "",
    "## Tests",
    "",
    "### 1. Banner look",
    "run: auto+look",
    "via: spy, shot",
    "spec: packages/e2e/specs/notification-look.e2e.ts::[06-UAT#01]",
    `auto-result: pass @ ${RUN} 2026-10-11`,
    "expected: |",
    "  The banner appears.",
    "  result: [pending] (an indented line inside the expected block)",
    "result: [pending]",
    "",
    "### 2. Click the banner",
    "run: owner",
    "owner-why: banner-click",
    "expected: |",
    "  Click the banner.",
    "result: [pending]",
    "",
    "### 3. Deny",
    "run: auto",
    "via: dom, store",
    "spec: packages/e2e/specs/approvals-core.e2e.ts::[06-UAT#03]",
    "auto-result: pass @ deadbeef 2026-10-01",
    "expected: |",
    "  Deny the request.",
    "result: [pending]",
    "",
    "### 4. Recorded already",
    "run: auto",
    "via: dom",
    "spec: packages/e2e/specs/approvals-core.e2e.ts::[06-UAT#04]",
    `auto-result: pass @ ${RUN} 2026-10-11`,
    "expected: |",
    "  Done by the owner.",
    "result: pass - the owner walked it",
    "",
    "### 5. Failed",
    "run: auto",
    "via: dom",
    "spec: packages/e2e/specs/approvals-core.e2e.ts::[06-UAT#05]",
    `auto-result: fail @ ${RUN} 2026-10-11`,
    "expected: |",
    "  Fails.",
    "result: [pending]",
    "",
    "### 6. No auto result",
    "run: auto",
    "via: dom",
    "spec: packages/e2e/specs/approvals-core.e2e.ts::[06-UAT#06]",
    "expected: |",
    "  Never ran.",
    "result: [pending]",
    "",
    "### 7. Passing",
    "run: auto",
    "via: dom",
    "spec: packages/e2e/specs/approvals-core.e2e.ts::[06-UAT#07]",
    `auto-result: pass @ ${RUN} 2026-10-11`,
    "expected: |",
    "  Passes.",
    "result: [pending]",
    "",
    "## Summary",
    "",
    "total: 7",
    "passed: 1",
    "issues: 0",
    "pending: 6",
    "skipped: 0",
    "blocked: 0",
    "",
  ].join("\n");
}

describe("applyRatification (Test 6)", () => {
  it("writes pass - auto run only on pending result lines of items whose auto-result is a pass for the run", () => {
    const before = script();
    const { text, items } = applyRatification(before, RUN);
    expect(items).toEqual([1, 7]);
    const parsed = parseUatScript(text);
    expect(parsed.items.map((item) => item.resultValue)).toEqual([
      `pass - auto run ${RUN}`,
      "[pending]",
      "[pending]",
      "pass - the owner walked it",
      "[pending]",
      "[pending]",
      `pass - auto run ${RUN}`,
    ]);
  });

  it("leaves an owner item, a recorded result, another run id and an item without an auto-result alone", () => {
    const before = script();
    const { text } = applyRatification(before, RUN);
    const a = before.split("\n");
    const b = text.split("\n");
    const changed = a.flatMap((line, index) => (line === b[index] ? [] : [index]));
    const kinds = changed.map((index) => (b[index] as string).split(":")[0]);
    expect(kinds.sort()).toEqual(["passed", "pending", "result", "result"]);
    expect(b).toContain("result: pass - the owner walked it");
  });

  it("keeps the summary counts consistent", () => {
    const { text } = applyRatification(script(), RUN);
    expect(text).toContain("passed: 3");
    expect(text).toContain("pending: 4");
    expect(text).toContain("total: 7");
  });

  it("does not touch an indented result line inside the expected block", () => {
    const { text } = applyRatification(script(), RUN);
    expect(text).toContain("  result: [pending] (an indented line inside the expected block)");
  });

  it("is idempotent", () => {
    const once = applyRatification(script(), RUN);
    const twice = applyRatification(once.text, RUN);
    expect(twice.text).toBe(once.text);
    expect(twice.items).toEqual([]);
  });

  it("changes nothing for a run id that no auto-result names", () => {
    const before = script();
    const result = applyRatification(before, "ffffffff");
    expect(result.text).toBe(before);
    expect(result.items).toEqual([]);
  });

  it("is a no-op on the Phase 6 script with all 26 results already recorded", () => {
    const url = new URL(
      "../../../.planning/phases/06-approval-inbox-canonical-tasks/06-UAT.md",
      import.meta.url,
    );
    let phase6: string;
    try {
      phase6 = readFileSync(url, "utf8");
    } catch {
      return;
    }
    const result = applyRatification(phase6, RUN);
    expect(result.text).toBe(phase6);
    expect(result.items).toEqual([]);
  });

  it("refuses a malformed run id", () => {
    expect(() => applyRatification(script(), "nothex")).toThrow();
  });
});
