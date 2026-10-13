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

describe("expiry and lifecycle titles, and the whole approvals set (Task 3 Test 3)", () => {
  it("holds exactly [06-UAT#09] in approvals-expiry", () => {
    expect(numbersOf(titlesOf("approvals-expiry"))).toEqual([9]);
  });

  it("holds exactly [06-UAT#13], [06-UAT#24] and [06-UAT#10], in that order, in approvals-lifecycle", () => {
    expect(numbersOf(titlesOf("approvals-lifecycle"))).toEqual([13, 24, 10]);
  });

  it("covers items 2 to 10, 13 and 24 once each across the three files: eleven titles", () => {
    const all = [
      ...numbersOf(titlesOf("approvals-core")),
      ...numbersOf(titlesOf("approvals-expiry")),
      ...numbersOf(titlesOf("approvals-lifecycle")),
    ];
    expect(all).toHaveLength(11);
    expect([...all].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 24]);
  });

  it("starts a service of the expiry kind in the expiry spec only", () => {
    for (const name of ["approvals-core", "approvals-lifecycle"]) {
      const source = readFileSync(join(SPECS, `${name}.e2e.ts`), "utf8");
      expect(source).not.toMatch(/startApprovalsEnvironment\(\s*["']expiry["']/);
      expect(source).not.toMatch(/kind:\s*["']expiry["']/);
    }
    const expiry = readFileSync(join(SPECS, "approvals-expiry.e2e.ts"), "utf8");
    expect(expiry).toMatch(/startApprovalsEnvironment\(\s*["']expiry["']/);
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
