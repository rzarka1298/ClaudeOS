import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import { specMapForPhase } from "../spec-map.js";
import { extractSpecTitles } from "../tag-lint.js";

/**
 * Title mapping for the research specs (plan 07-17, D-28, AUTOMATED-UAT tagging convention): every
 * Phase 7 UAT item the runner asserts has exactly one title that starts [07-UAT#NN], in the spec
 * file the classification table names. The spec files cannot run in CI, so this is how their shape
 * is guarded.
 */

const SPEC_DIR = "packages/e2e/specs";

/** The planned title numbers of each research spec (grown task by task). */
const PLANNED = {
  "research-core": [2],
} as const;
type SpecName = keyof typeof PLANNED;

function titlesOf(name: SpecName): string[] {
  const path = `${SPEC_DIR}/${name}.e2e.ts`;
  const full = join(REPO_ROOT, path);
  if (!existsSync(full)) return [];
  return extractSpecTitles(path, readFileSync(full, "utf8"), "07").map((entry) => entry.title);
}

function numbersOf(titles: readonly string[]): number[] {
  return titles.map((title) => Number(/^\[07-UAT#(\d{2})\]/.exec(title)?.[1]));
}

describe("research spec titles", () => {
  for (const name of Object.keys(PLANNED) as SpecName[]) {
    it(`${name} holds exactly its planned items, once each`, () => {
      expect(numbersOf(titlesOf(name)).sort((a, b) => a - b)).toEqual([...PLANNED[name]]);
    });
  }

  it("maps each planned item to its spec file in the classification table", () => {
    const plan = specMapForPhase("07")?.itemPlan ?? [];
    for (const name of Object.keys(PLANNED) as SpecName[]) {
      for (const number of PLANNED[name]) {
        expect(plan.find((entry) => entry.number === number)?.specFile).toBe(
          `${SPEC_DIR}/${name}.e2e.ts`,
        );
      }
    }
  });
});
