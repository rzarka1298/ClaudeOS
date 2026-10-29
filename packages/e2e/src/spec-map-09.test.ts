import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./repo-paths.js";
import { specMapForPhase } from "./spec-map.js";
import { SPEC_FILES_09, UAT_ITEM_PLAN_09, UAT_PHASE_PREFIX_09 } from "./spec-map-09.js";
import { extractSpecTitles } from "./tag-lint.js";
import { parseUatScript } from "./uat-tags.js";

/**
 * Plan 09-21 (D-17): the Phase 9 item plan registered in PHASE_SPEC_MAPS equals the tags of the
 * draft 09-UAT.md, and the spec file holds one title per automated item. The script is a private
 * planning artifact: a public clone has no `.planning/` and the script-reading tests skip.
 */

const PLANNING_INDEX = join(REPO_ROOT, ".planning", "ROADMAP.md");
const PHASES = join(REPO_ROOT, ".planning", "phases");
const SPEC = "packages/e2e/specs/hardening.e2e.ts";
const planned = existsSync(PLANNING_INDEX);
const run = planned ? describe : describe.skip;

function scriptPath(): string {
  const name = readdirSync(PHASES).find((entry) => entry.startsWith("09-"));
  return join(PHASES, name ?? "09-missing", "09-UAT.md");
}

describe("the Phase 9 registry (Task 1, Test 1)", () => {
  it("registers prefix 09 with the hardening spec file", () => {
    expect(UAT_PHASE_PREFIX_09).toBe("09");
    expect(SPEC_FILES_09).toEqual([SPEC]);
    const map = specMapForPhase("09");
    expect(map?.prefix).toBe("09");
    expect(map?.itemPlan).toBe(UAT_ITEM_PLAN_09);
    expect(map?.specFiles).toBe(SPEC_FILES_09);
  });

  it("starts the plan with the quiet idle session, an automated DOM item on the standard profile", () => {
    expect(UAT_ITEM_PLAN_09[0]).toEqual({
      number: 1,
      runClass: "auto",
      via: ["dom"],
      ownerWhy: null,
      autoPart: null,
      specFile: SPEC,
      profile: "standard",
    });
  });
});

run("the Phase 9 plan matches 09-UAT.md (Task 1, Test 1)", () => {
  const parsed = planned ? parseUatScript(readFileSync(scriptPath(), "utf8")) : parseUatScript("");

  it("tags item 1 run: auto, via: dom, with its spec title", () => {
    const item = parsed.items.find((candidate) => candidate.number === 1);
    expect(parsed.frontMatter.phase).toMatch(/^09-/);
    expect(item?.runValue).toBe("auto");
    expect(item?.via).toEqual(["dom"]);
    expect(item?.spec).toBe(`${SPEC}::[09-UAT#01]`);
    const plan = UAT_ITEM_PLAN_09[0];
    expect(item?.runValue).toBe(plan?.runClass);
    expect(item?.via).toEqual(plan?.via);
  });
});

describe("the hardening spec text (Task 1, Test 3)", () => {
  const source = existsSync(join(REPO_ROOT, SPEC))
    ? readFileSync(join(REPO_ROOT, SPEC), "utf8")
    : "";

  it("holds a describe with the quiet idle item's title", () => {
    expect(source).toMatch(/\bdescribe\(\s*["'`]/);
    const titles = extractSpecTitles(SPEC, source, "09").map((entry) => entry.title);
    expect(titles).toContain(
      "[09-UAT#01] A quiet idle session reads Idle, is not counted as running, and a new event restores Running",
    );
  });
});
