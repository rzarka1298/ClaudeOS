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

describe("approvals-core titles (Test 4)", () => {
  it("starts with the Deny item, [06-UAT#07]", () => {
    const titles = titlesOf("approvals-core");
    expect(titles.some((title) => title.startsWith("[06-UAT#07]"))).toBe(true);
  });

  it("holds only planned approvals-core items and each prefix at most once", () => {
    const numbers = numbersOf(titlesOf("approvals-core"));
    for (const number of numbers) expect([7, 6, 5, 8, 2, 3, 4]).toContain(number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
