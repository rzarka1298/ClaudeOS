import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { itemNumberOf } from "../results.js";
import { UAT_PHASE_PREFIX } from "../spec-map.js";
import { extractSpecTitles } from "../tag-lint.js";

/**
 * The title mapping of the approvals specs (05.2-06, E2E-04, D-09): each file holds exactly its
 * planned `[06-UAT#NN]` titles, once each, and the three owner items appear only as auto-part
 * partials (T-05.2-25).
 */

const SPECS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "specs");

function titlesOf(name: string): string[] {
  const file = `${name}.e2e.ts`;
  const source = readFileSync(join(SPECS, file), "utf8");
  return extractSpecTitles(file, source, UAT_PHASE_PREFIX).map((entry) => entry.title);
}

function numbersOf(titles: readonly string[]): number[] {
  return titles.map((title) => itemNumberOf(title, UAT_PHASE_PREFIX) as number);
}

const CORE_PLANNED = [7, 6, 5, 8, 2, 3, 4];
const OWNER_PARTIALS = [2, 3, 4];

describe("approvals-core titles (Test 4)", () => {
  it("holds the Deny item, [06-UAT#07]", () => {
    const titles = titlesOf("approvals-core");
    expect(titles.some((title) => title.startsWith("[06-UAT#07]"))).toBe(true);
  });

  it("holds only planned approvals-core items and each prefix at most once", () => {
    const numbers = numbersOf(titlesOf("approvals-core"));
    for (const number of numbers) expect(CORE_PLANNED).toContain(number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe("approvals-core titles, complete (Task 2 Test 3)", () => {
  it("holds exactly the seven planned titles in the planned order, once each", () => {
    expect(numbersOf(titlesOf("approvals-core"))).toEqual(CORE_PLANNED);
  });

  it("ends the three owner-item titles with the words auto-part", () => {
    const titles = titlesOf("approvals-core");
    for (const title of titles) {
      const number = itemNumberOf(title, UAT_PHASE_PREFIX) as number;
      if (OWNER_PARTIALS.includes(number)) expect(title.endsWith("auto-part")).toBe(true);
      else expect(title.endsWith("auto-part")).toBe(false);
    }
  });
});
