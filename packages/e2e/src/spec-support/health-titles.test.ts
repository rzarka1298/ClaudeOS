import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import { specMapForPhase } from "../spec-map.js";
import { extractSpecTitles } from "../tag-lint.js";

/**
 * Title mapping for the Phase 8 health specs (plan 08-20, D-27, AUTOMATED-UAT tagging convention):
 * `health-drills.e2e.ts` holds [08-UAT#22] to [08-UAT#30] and [08-UAT#36], `bundle-export.e2e.ts`
 * holds [08-UAT#31] to [08-UAT#33] and [08-UAT#35], once each, and the Phase 8 item plan maps each
 * to its file. The specs cannot run in CI, so this is how their shape is guarded.
 */

const HEALTH_SPEC = "packages/e2e/specs/health-drills.e2e.ts";
const HEALTH_ITEMS = [22] as const;

function titlesOf(spec: string): string[] {
  const full = join(REPO_ROOT, spec);
  if (!existsSync(full)) return [];
  return extractSpecTitles(spec, readFileSync(full, "utf8"), "08").map((entry) => entry.title);
}

function numbersOf(list: readonly string[]): number[] {
  return list.map((title) => Number(/^\[08-UAT#(\d{2})\]/.exec(title)?.[1]));
}

describe("health drills spec titles", () => {
  it("holds [08-UAT#22] so far (Task 2 adds 23 to 30 and 36), once each", () => {
    expect(numbersOf(titlesOf(HEALTH_SPEC)).sort((a, b) => a - b)).toEqual([...HEALTH_ITEMS]);
  });

  it("maps items 22 to 30 and 36 of the Phase 8 item plan to this spec file", () => {
    const plan = specMapForPhase("08")?.itemPlan ?? [];
    for (const number of [22, 23, 24, 25, 26, 27, 28, 29, 30, 36]) {
      expect(plan.find((entry) => entry.number === number)?.specFile, `item ${number}`).toBe(
        HEALTH_SPEC,
      );
    }
    const mine = plan.filter((entry) => entry.specFile === HEALTH_SPEC).map((e) => e.number);
    expect(mine.sort((a, b) => a - b)).toEqual([22, 23, 24, 25, 26, 27, 28, 29, 30, 36]);
  });
});
