import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import { specMapForPhase } from "../spec-map.js";
import { extractSpecTitles } from "../tag-lint.js";

/**
 * Title mapping for the Overview slice spec (plan 08-19, D-27, AUTOMATED-UAT tagging convention):
 * every Phase 8 item 1 to 8 has exactly one title that starts [08-UAT#NN] in
 * `overview-slice.e2e.ts`, and the Phase 8 item plan maps each to that file. The spec cannot run
 * in CI, so this is how its shape is guarded.
 */

const SPEC = "packages/e2e/specs/overview-slice.e2e.ts";

/** All eight slice items (Task 1 added item 1, Task 2 items 2 to 8). */
const ALL_ITEMS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

function titles(): string[] {
  const full = join(REPO_ROOT, SPEC);
  if (!existsSync(full)) return [];
  return extractSpecTitles(SPEC, readFileSync(full, "utf8"), "08").map((entry) => entry.title);
}

function numbersOf(list: readonly string[]): number[] {
  return list.map((title) => Number(/^\[08-UAT#(\d{2})\]/.exec(title)?.[1]));
}

describe("overview slice spec titles", () => {
  it("holds exactly the titles [08-UAT#01] to [08-UAT#08], once each", () => {
    expect(numbersOf(titles()).sort((a, b) => a - b)).toEqual([...ALL_ITEMS]);
  });

  it("holds no title for any other item", () => {
    expect(titles().filter((title) => !/^\[08-UAT#0[1-8]\] /.test(title))).toEqual([]);
  });

  it("maps every item 1 to 8 of the Phase 8 item plan to this spec file", () => {
    const plan = specMapForPhase("08")?.itemPlan ?? [];
    for (const number of ALL_ITEMS) {
      expect(plan.find((entry) => entry.number === number)?.specFile, `item ${number}`).toBe(SPEC);
    }
  });

  it("maps no other item to this spec file", () => {
    const plan = specMapForPhase("08")?.itemPlan ?? [];
    const mine = plan.filter((entry) => entry.specFile === SPEC).map((entry) => entry.number);
    expect(mine.sort((a, b) => a - b)).toEqual([...ALL_ITEMS]);
  });
});
