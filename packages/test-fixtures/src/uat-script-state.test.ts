import { describe, expect, it } from "vitest";
import { recordedStateProblems } from "./uat-script-state.js";

/**
 * Plan 08-23 (T-08-55, D-46): the structure tests of the Phase 7 and Phase 8 UAT scripts must keep
 * passing through the merge gate, where the runner writes `auto-result:` lines, the ratification
 * turns passing automated results into `pass - auto run <id>`, and the owner records the rest. The
 * one thing they must still refuse is an owner result that the owner did not give: an owner item
 * is `[pending]` until the front matter says `status: complete`. This file proves the checker on
 * synthetic scripts, including the cases it must refuse.
 */

interface ItemSpec {
  readonly run: "auto" | "owner";
  readonly result?: string;
  readonly autoResult?: string;
}

function script(items: readonly ItemSpec[], summary: Record<string, number>, status = "testing") {
  const parts = [`---\nstatus: ${status}\nphase: 99-synthetic\n---\n`];
  items.forEach((item, index) => {
    parts.push(
      [
        `### ${index + 1}. Item ${index + 1}`,
        `run: ${item.run}`,
        ...(item.run === "owner" ? ["owner-why: decision"] : ["via: dom"]),
        ...(item.autoResult === undefined ? [] : [`auto-result: ${item.autoResult}`]),
        "expected: |",
        "  Something is expected here.",
        `result: ${item.result ?? "[pending]"}`,
        "",
      ].join("\n"),
    );
  });
  const lines = Object.entries(summary).map(([key, value]) => `${key}: ${value}`);
  parts.push(`## Summary\n\n${lines.join("\n")}\n\n## Gaps\n\nNone recorded yet.\n`);
  return parts.join("\n");
}

const OPTIONS = { total: 3, ownerItems: [3] } as const;
const PRE = {
  total: 3,
  passed: 0,
  issues: 0,
  pending: 3,
  skipped: 0,
  blocked: 0,
  "auto-passed": 0,
  "auto-failed": 0,
  "owner-pending": 1,
};
const PRE_ITEMS: ItemSpec[] = [{ run: "auto" }, { run: "auto" }, { run: "owner" }];

describe("recordedStateProblems", () => {
  it("accepts the script as agents ship it: every result pending, no automated result", () => {
    expect(recordedStateProblems(script(PRE_ITEMS, PRE), OPTIONS)).toEqual([]);
  });

  it("accepts the runner's auto-result lines and a ratified pass, with the counts that follow", () => {
    const text = script(
      [
        {
          run: "auto",
          result: "pass - auto run 1a2b3c4d",
          autoResult: "pass @ 1a2b3c4d 2026-10-23",
        },
        { run: "auto", autoResult: "inconclusive (look pending) @ 1a2b3c4d 2026-10-23" },
        { run: "owner" },
      ],
      { ...PRE, passed: 1, pending: 2, "auto-passed": 1 },
    );
    expect(recordedStateProblems(text, OPTIONS)).toEqual([]);
  });

  it("accepts the owner's results once the front matter says complete", () => {
    const text = script(
      [
        {
          run: "auto",
          result: "pass - auto run 1a2b3c4d",
          autoResult: "pass @ 1a2b3c4d 2026-10-23",
        },
        {
          run: "auto",
          result: "pass - auto run 1a2b3c4d",
          autoResult: "pass @ 1a2b3c4d 2026-10-23",
        },
        { run: "owner", result: "pass - the owner walked it" },
      ],
      { ...PRE, passed: 3, pending: 0, "auto-passed": 2, "owner-pending": 0 },
      "complete",
    );
    expect(recordedStateProblems(text, OPTIONS)).toEqual([]);
  });

  it("refuses an owner result before the script is complete, and an auto-result on an owner item", () => {
    const early = script(
      [{ run: "auto" }, { run: "auto" }, { run: "owner", result: "pass - done" }],
      { ...PRE, passed: 1, pending: 2, "owner-pending": 0 },
    );
    expect(recordedStateProblems(early, OPTIONS).join(" ")).toMatch(/item 3.*owner/i);
    const mislabelled = script(
      [
        { run: "auto" },
        { run: "auto" },
        { run: "owner", autoResult: "pass @ 1a2b3c4d 2026-10-23" },
      ],
      PRE,
    );
    expect(recordedStateProblems(mislabelled, OPTIONS).join(" ")).toMatch(/item 3.*auto-result/i);
  });

  it("refuses a ratified result that no automated pass of that run supports", () => {
    const noAuto = script(
      [{ run: "auto", result: "pass - auto run 1a2b3c4d" }, { run: "auto" }, { run: "owner" }],
      { ...PRE, passed: 1, pending: 2 },
    );
    expect(recordedStateProblems(noAuto, OPTIONS).join(" ")).toMatch(/item 1/);
    const otherRun = script(
      [
        {
          run: "auto",
          result: "pass - auto run 1a2b3c4d",
          autoResult: "pass @ ffffffff 2026-10-23",
        },
        { run: "auto" },
        { run: "owner" },
      ],
      { ...PRE, passed: 1, pending: 2, "auto-passed": 1 },
    );
    expect(recordedStateProblems(otherRun, OPTIONS).join(" ")).toMatch(/item 1/);
    const failed = script(
      [
        {
          run: "auto",
          result: "pass - auto run 1a2b3c4d",
          autoResult: "fail @ 1a2b3c4d 2026-10-23",
        },
        { run: "auto" },
        { run: "owner" },
      ],
      { ...PRE, passed: 1, pending: 2 },
    );
    expect(recordedStateProblems(failed, OPTIONS).join(" ")).toMatch(/item 1/);
  });

  it("refuses an auto-result line that is not in the runner's form", () => {
    const text = script(
      [{ run: "auto", autoResult: "pass at once" }, { run: "auto" }, { run: "owner" }],
      PRE,
    );
    expect(recordedStateProblems(text, OPTIONS).join(" ")).toMatch(/item 1.*auto-result/i);
  });

  it("refuses summary counts that disagree with the results, and a changed total", () => {
    const wrongPending = script(PRE_ITEMS, { ...PRE, pending: 2, passed: 1 });
    expect(recordedStateProblems(wrongPending, OPTIONS).join(" ")).toMatch(/pending/);
    const wrongTotal = script(PRE_ITEMS, { ...PRE, total: 4 });
    expect(recordedStateProblems(wrongTotal, OPTIONS).join(" ")).toMatch(/total/);
    const wrongOwner = script(PRE_ITEMS, { ...PRE, "owner-pending": 0 });
    expect(recordedStateProblems(wrongOwner, OPTIONS).join(" ")).toMatch(/owner-pending/);
    const autoCountsWithoutResults = script(PRE_ITEMS, { ...PRE, "auto-passed": 1 });
    expect(recordedStateProblems(autoCountsWithoutResults, OPTIONS).join(" ")).toMatch(
      /auto-passed/,
    );
  });

  it("refuses a result line that is missing or doubled", () => {
    const doubled = script(PRE_ITEMS, PRE).replace(
      "### 2. Item 2",
      "result: [pending]\n### 2. Item 2",
    );
    expect(recordedStateProblems(doubled, OPTIONS).join(" ")).toMatch(/item 1.*result/i);
  });
});
