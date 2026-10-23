import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import { specMapForPhase } from "../spec-map.js";
import { extractSpecTitles } from "../tag-lint.js";

/**
 * Title mapping for the Phase 8 Settings specs (plan 08-22, D-27, AUTOMATED-UAT tagging
 * convention): `settings-core.e2e.ts` holds [08-UAT#09] to [08-UAT#18] and [08-UAT#34] and
 * `settings-integrations.e2e.ts` holds [08-UAT#19] to [08-UAT#21], once each, and the Phase 8
 * item plan maps each to its file. The specs cannot run in CI, so this is how their shape is
 * guarded.
 */

const CORE_SPEC = "packages/e2e/specs/settings-core.e2e.ts";

function titlesOf(spec: string): string[] {
  const full = join(REPO_ROOT, spec);
  if (!existsSync(full)) return [];
  return extractSpecTitles(spec, readFileSync(full, "utf8"), "08").map((entry) => entry.title);
}

function numbersOf(list: readonly string[]): number[] {
  return list.map((title) => Number(/^\[08-UAT#(\d{2})\]/.exec(title)?.[1]));
}

describe("settings core spec titles", () => {
  it("holds [08-UAT#09] so far (Task 2 adds 10 to 18 and 34), once", () => {
    expect(numbersOf(titlesOf(CORE_SPEC))).toEqual([9]);
  });

  it("holds no title for any other item", () => {
    expect(
      titlesOf(CORE_SPEC).filter((title) => !/^\[08-UAT#(09|1[0-8]|34)\] /.test(title)),
    ).toEqual([]);
  });

  it("maps items 9 to 18 and 34 of the Phase 8 item plan to this spec file", () => {
    const plan = specMapForPhase("08")?.itemPlan ?? [];
    for (const number of [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 34]) {
      expect(plan.find((entry) => entry.number === number)?.specFile, `item ${number}`).toBe(
        CORE_SPEC,
      );
    }
    const mine = plan.filter((entry) => entry.specFile === CORE_SPEC).map((e) => e.number);
    expect(mine.sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 34]);
  });
});
