import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintTagsCommand } from "./lint-command.js";
import { REPO_ROOT } from "./repo-paths.js";
import { SPEC_FILES, specMapForPhase, UAT_ITEM_PLAN, UAT_PHASE_PREFIX } from "./spec-map.js";
import { checkMapAgainstScript } from "./tag-lint.js";
import { parseUatScript } from "./uat-tags.js";

/**
 * Plan 08-05 Task 1 (D-27): the Phase 8 item plan registered in PHASE_SPEC_MAPS holds the 39 items
 * of the draft 08-UAT.md (auto 32, auto+look 1, owner 6) and equals the script's tags. Phase 6 keeps
 * its pinned plan and Phase 7 stays at 24 items. The script is a private planning artifact: a public
 * clone has no `.planning/` and the script-reading tests skip.
 */

/** SHA-256 of JSON.stringify({ UAT_PHASE_PREFIX, SPEC_FILES, UAT_ITEM_PLAN }) before Phase 7. */
const PHASE_6_PLAN_SHA256 = "2f2014f0ae780346e026e01c73647abeeadc646c02ba557783b8061eaf8313e4";

const PLANNING_INDEX = join(REPO_ROOT, ".planning", "ROADMAP.md");
const PHASES = join(REPO_ROOT, ".planning", "phases");
const SPECS_DIR = join(REPO_ROOT, "packages", "e2e", "specs");
const planned = existsSync(PLANNING_INDEX);
const run = planned ? describe : describe.skip;

function scriptPath(): string {
  const name = readdirSync(PHASES).find((entry) => entry.startsWith("08-"));
  return join(PHASES, name ?? "08-missing", "08-UAT.md");
}

const file = (name: string) => `packages/e2e/specs/${name}.e2e.ts`;

describe("the Phase 8 registry", () => {
  it("returns a Phase 8 plan of 39 items numbered 1 to 39 (Test 1)", () => {
    const map = specMapForPhase("08");
    expect(map?.itemPlan.map((item) => item.number)).toEqual(
      Array.from({ length: 39 }, (_, index) => index + 1),
    );
  });

  it("classifies auto 32, auto+look 1 (item 17) and owner 6 (items 34 to 39) (Test 2)", () => {
    const plan = specMapForPhase("08")?.itemPlan ?? [];
    const numbers = (runClass: string) =>
      plan.filter((item) => item.runClass === runClass).map((item) => item.number);
    expect(numbers("auto")).toHaveLength(32);
    expect(numbers("auto")).toEqual(
      Array.from({ length: 33 }, (_, index) => index + 1).filter((n) => n !== 17),
    );
    expect(numbers("auto+look")).toEqual([17]);
    expect(numbers("owner")).toEqual([34, 35, 36, 37, 38, 39]);
  });

  it("gives owner items 34, 35 and 36 an auto-part and a spec; 37, 38 and 39 neither (Test 2)", () => {
    const plan = specMapForPhase("08")?.itemPlan ?? [];
    for (const n of [34, 35, 36]) {
      expect(plan[n - 1]?.autoPart, `auto-part ${n}`).not.toBeNull();
      expect(plan[n - 1]?.specFile, `spec ${n}`).not.toBeNull();
    }
    for (const n of [37, 38, 39]) {
      expect(plan[n - 1]?.autoPart, `auto-part ${n}`).toBeNull();
      expect(plan[n - 1]?.specFile, `spec ${n}`).toBeNull();
    }
    expect(plan.filter((item) => item.runClass === "owner").map((item) => item.ownerWhy)).toEqual([
      "settings-dialog",
      "settings-dialog",
      "real-session",
      "real-session",
      "real-session",
      "decision",
    ]);
  });

  it("names exactly the five spec files, in this order (Test 3)", () => {
    expect(specMapForPhase("08")?.specFiles).toEqual([
      file("overview-slice"),
      file("settings-core"),
      file("settings-integrations"),
      file("health-drills"),
      file("bundle-export"),
    ]);
  });

  it("assigns items to the files the plan states", () => {
    const plan = specMapForPhase("08")?.itemPlan ?? [];
    const fileOf = (n: number) => plan[n - 1]?.specFile;
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, index) => from + index);
    for (const n of range(1, 8)) expect(fileOf(n), `item ${n}`).toBe(file("overview-slice"));
    for (const n of [...range(9, 18), 34])
      expect(fileOf(n), `item ${n}`).toBe(file("settings-core"));
    for (const n of range(19, 21))
      expect(fileOf(n), `item ${n}`).toBe(file("settings-integrations"));
    for (const n of [...range(22, 30), 36])
      expect(fileOf(n), `item ${n}`).toBe(file("health-drills"));
    for (const n of [...range(31, 33), 35])
      expect(fileOf(n), `item ${n}`).toBe(file("bundle-export"));
  });

  it("flags no Phase 8 item as full-profile", () => {
    const plan = specMapForPhase("08")?.itemPlan ?? [];
    expect(plan.filter((item) => item.profile === "full")).toEqual([]);
  });

  it("keeps the Phase 6 plan hash and the 24-item Phase 7 plan (Test 4)", () => {
    const six = specMapForPhase("06");
    expect(six?.itemPlan).toBe(UAT_ITEM_PLAN);
    expect(six?.specFiles).toBe(SPEC_FILES);
    expect(
      createHash("sha256")
        .update(JSON.stringify({ UAT_PHASE_PREFIX, SPEC_FILES, UAT_ITEM_PLAN }))
        .digest("hex"),
    ).toBe(PHASE_6_PLAN_SHA256);
    expect(specMapForPhase("07")?.itemPlan).toHaveLength(24);
  });
});

run("the Phase 8 plan matches 08-UAT.md (Test 1, Test 5)", () => {
  const parsed = planned ? parseUatScript(readFileSync(scriptPath(), "utf8")) : parseUatScript("");

  it("parses 39 items", () => {
    expect(parsed.items).toHaveLength(39);
    expect(parsed.frontMatter.phase).toMatch(/^08-/);
  });

  it("gives every item the run, via, owner-why, auto-part and spec line the plan holds", () => {
    const plan = specMapForPhase("08")?.itemPlan ?? [];
    expect(plan).toHaveLength(39);
    for (const entry of plan) {
      const item = parsed.items.find((candidate) => candidate.number === entry.number);
      expect(item, `item ${entry.number}`).toBeDefined();
      expect(item?.runValue, `run ${entry.number}`).toBe(entry.runClass);
      expect(item?.ownerWhy, `owner-why ${entry.number}`).toBe(entry.ownerWhy);
      expect(item?.autoPart !== null, `auto-part ${entry.number}`).toBe(entry.autoPart !== null);
      if (entry.autoPart !== null) expect(item?.autoPart).toBe(entry.autoPart);
      if (entry.runClass !== "owner") {
        expect([...(item?.via ?? [])].sort(), `via ${entry.number}`).toEqual([...entry.via].sort());
      } else {
        expect(item?.via, `via ${entry.number}`).toEqual([]);
      }
      const prefix = `[08-UAT#${String(entry.number).padStart(2, "0")}]`;
      expect(item?.spec ?? null, `spec ${entry.number}`).toBe(
        entry.specFile === null ? null : `${entry.specFile}::${prefix}`,
      );
    }
  });

  it("agrees with the classification check of the lint library", () => {
    expect(checkMapAgainstScript(parsed.items, specMapForPhase("08")?.itemPlan ?? [])).toEqual([]);
  });

  it("raises none of the tag-format findings over the real script", () => {
    const result = lintTagsCommand({
      scriptPath: scriptPath(),
      specsDir: SPECS_DIR,
      readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
      listFiles: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
    });
    const formatFindings = result.lines.filter((line) =>
      /^(RUN_INVALID|VIA_INVALID|SPEC_INVALID|OWNER_WHY_INVALID|MAP_MISMATCH|MAP_ITEM_)/.test(line),
    );
    expect(formatFindings).toEqual([]);
  });
});
