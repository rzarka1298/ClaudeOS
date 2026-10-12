import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UAT_PHASE_PREFIX } from "../spec-map.js";
import { extractSpecTitles } from "../tag-lint.js";

const SPECS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "specs");
const PLANNED_CROSS = [25, 23, 12, 20, 22];

function titlesOf(name: string): string[] {
  const file = join(SPECS, `${name}.e2e.ts`);
  if (!existsSync(file)) return [];
  return extractSpecTitles(name, readFileSync(file, "utf8"), UAT_PHASE_PREFIX).map(
    (entry) => entry.title,
  );
}

const itemOf = (title: string): number => Number(/^\[06-UAT#(\d{2})\]/.exec(title)?.[1]);

describe("cross-cutting spec titles (Test 5)", () => {
  const titles = titlesOf("cross-cutting");

  it("holds a title starting [06-UAT#25]", () => {
    expect(titles.some((title) => title.startsWith("[06-UAT#25]"))).toBe(true);
  });

  it("holds exactly [06-UAT#25], #23, #12, #20 and #22, once each", () => {
    expect(titles.map(itemOf).sort((a, b) => a - b)).toEqual([12, 20, 22, 23, 25]);
  });

  it("holds only planned items, each at most once", () => {
    const items = titles.map(itemOf);
    expect(new Set(items).size).toBe(items.length);
    for (const item of items) expect(PLANNED_CROSS).toContain(item);
  });
});
