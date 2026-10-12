import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import { UAT_ITEM_PLAN } from "../spec-map.js";
import { extractSpecTitles } from "../tag-lint.js";

/**
 * Title mapping for the tasks specs (05.2-07, D-09, E2E-04): every Phase 6 UAT item the runner
 * asserts has exactly one title that starts [06-UAT#NN], in the spec file the classification
 * table names. The spec files cannot run in CI, so this is how their shape is guarded.
 */

const SPEC_DIR = "packages/e2e/specs";

/** The planned title numbers of each tasks spec. */
const PLANNED = {
  "tasks-core": [14, 15, 16, 17],
  "tasks-views": [18, 19],
  "tasks-scale": [21],
} as const;
type SpecName = keyof typeof PLANNED;

function titlesOf(name: SpecName): string[] {
  const path = `${SPEC_DIR}/${name}.e2e.ts`;
  const full = join(REPO_ROOT, path);
  if (!existsSync(full)) return [];
  return extractSpecTitles(path, readFileSync(full, "utf8"), "06").map((entry) => entry.title);
}

function numbersOf(titles: readonly string[]): number[] {
  return titles.map((title) => Number(/^\[06-UAT#(\d{2})\]/.exec(title)?.[1]));
}

describe("tasks-core titles (Test 4)", () => {
  const titles = titlesOf("tasks-core");
  const numbers = numbersOf(titles);

  it("has a title starting [06-UAT#14]", () => {
    expect(titles.some((title) => title.startsWith("[06-UAT#14]"))).toBe(true);
  });

  it("only holds titles of the planned set, each at most once", () => {
    for (const number of numbers) expect(PLANNED["tasks-core"]).toContain(number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("holds exactly 14, 15, 16 and 17, once each (Task 2 Test 5)", () => {
    expect([...numbers].sort()).toEqual([...PLANNED["tasks-core"]]);
  });
});

describe("tasks-views, tasks-scale and the whole tasks set (Task 3 Test 6)", () => {
  it("tasks-views holds exactly 18 and 19, once each", () => {
    expect(numbersOf(titlesOf("tasks-views")).sort()).toEqual([...PLANNED["tasks-views"]]);
  });

  it("tasks-scale holds exactly 21", () => {
    expect(numbersOf(titlesOf("tasks-scale"))).toEqual([...PLANNED["tasks-scale"]]);
  });

  it("the whole tasks set equals 14 to 19 and 21 once each", () => {
    const all = (Object.keys(PLANNED) as SpecName[]).flatMap((name) =>
      numbersOf(titlesOf(name)),
    );
    expect(all.sort()).toEqual([14, 15, 16, 17, 18, 19, 21]);
  });
});

describe("the classification table agrees with the planned sets", () => {
  it("maps each planned item to its spec file", () => {
    for (const name of Object.keys(PLANNED) as SpecName[]) {
      for (const number of PLANNED[name]) {
        const item = UAT_ITEM_PLAN.find((entry) => entry.number === number);
        expect(item?.specFile).toBe(`${SPEC_DIR}/${name}.e2e.ts`);
      }
    }
  });
});
