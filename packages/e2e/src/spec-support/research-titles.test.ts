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
  "research-core": [1, 2, 3, 4, 5, 6, 7, 8, 22],
  "research-hostile": [9, 10],
  "research-lifecycle": [11, 12, 13, 14, 21],
  "research-views": [15, 16, 17, 18, 19, 20, 23],
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

describe("every Phase 7 item that names a spec file has a title in it", () => {
  it("covers the items of the classification table that carry a spec (all but item 24)", () => {
    const planned = Object.values(PLANNED)
      .flat()
      .sort((a, b) => a - b);
    const plan = specMapForPhase("07")?.itemPlan ?? [];
    const withSpec = plan.filter((entry) => entry.specFile !== null).map((entry) => entry.number);
    expect(planned).toEqual(withSpec);
    expect(withSpec).toHaveLength(23);
  });
});
