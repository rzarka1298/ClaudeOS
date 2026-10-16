import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageError } from "./cli-args.js";
import { lintTagsCommand } from "./lint-command.js";
import { REPO_ROOT } from "./repo-paths.js";
import {
  requireSpecMapForPhase,
  SPEC_FILES,
  specMapForPhase,
  UAT_ITEM_PLAN,
  UAT_PHASE_PREFIX,
} from "./spec-map.js";
import { checkMapAgainstScript } from "./tag-lint.js";
import { parseUatScript } from "./uat-tags.js";

/**
 * Plan 07-17 Task 1 (D-28, research Pitfall 13): the spec map is keyed by the phase in the tagged
 * script's front matter. Phase 6 keeps its plan exactly (pinned by a hash taken before the change)
 * and Phase 7 holds the 24 items of 07-UAT.md. The script is a private planning artifact: a public
 * clone has no `.planning/` and the script-reading tests skip.
 */

/** SHA-256 of JSON.stringify({ UAT_PHASE_PREFIX, SPEC_FILES, UAT_ITEM_PLAN }) before the change. */
const PHASE_6_PLAN_SHA256 = "2f2014f0ae780346e026e01c73647abeeadc646c02ba557783b8061eaf8313e4";

const PLANNING_INDEX = join(REPO_ROOT, ".planning", "ROADMAP.md");
const PHASES = join(REPO_ROOT, ".planning", "phases");
const SPECS_DIR = join(REPO_ROOT, "packages", "e2e", "specs");
const planned = existsSync(PLANNING_INDEX);
const run = planned ? describe : describe.skip;

function scriptPath(): string {
  const name = readdirSync(PHASES).find((entry) => entry.startsWith("07-"));
  return join(PHASES, name ?? "07-missing", "07-UAT.md");
}

const file = (name: string) => `packages/e2e/specs/${name}.e2e.ts`;

describe("the phase registry (Test 1)", () => {
  it("returns exactly the existing Phase 6 plan, unchanged", () => {
    const map = specMapForPhase("06");
    expect(map?.itemPlan).toBe(UAT_ITEM_PLAN);
    expect(map?.specFiles).toBe(SPEC_FILES);
    expect(
      createHash("sha256")
        .update(JSON.stringify({ UAT_PHASE_PREFIX, SPEC_FILES, UAT_ITEM_PLAN }))
        .digest("hex"),
    ).toBe(PHASE_6_PLAN_SHA256);
  });

  it("returns a Phase 7 plan of 24 items numbered 1 to 24", () => {
    const map = specMapForPhase("07");
    expect(map?.itemPlan.map((item) => item.number)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
  });

  it("classifies 19 auto, 2 auto+look and 3 owner exactly as 07-UAT.md lists them", () => {
    const plan = specMapForPhase("07")?.itemPlan ?? [];
    const numbers = (runClass: string) =>
      plan.filter((item) => item.runClass === runClass).map((item) => item.number);
    expect(numbers("auto")).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 18, 19, 20, 21,
    ]);
    expect(numbers("auto+look")).toEqual([15, 16]);
    expect(numbers("owner")).toEqual([22, 23, 24]);
  });

  it("names the four research spec files, in this order", () => {
    expect(specMapForPhase("07")?.specFiles).toEqual([
      file("research-core"),
      file("research-hostile"),
      file("research-lifecycle"),
      file("research-views"),
    ]);
  });

  it("assigns items to the files the plan states", () => {
    const plan = specMapForPhase("07")?.itemPlan ?? [];
    const fileOf = (n: number) => plan[n - 1]?.specFile;
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 22])
      expect(fileOf(n), `item ${n}`).toBe(file("research-core"));
    for (const n of [9, 10]) expect(fileOf(n), `item ${n}`).toBe(file("research-hostile"));
    for (const n of [11, 12, 13, 14, 21])
      expect(fileOf(n), `item ${n}`).toBe(file("research-lifecycle"));
    for (const n of [15, 16, 17, 18, 19, 20, 23])
      expect(fileOf(n), `item ${n}`).toBe(file("research-views"));
    expect(fileOf(24)).toBeNull();
  });

  it("keeps owner items owner items, each with an owner-why, and gives 22 and 23 their automated partial", () => {
    const plan = specMapForPhase("07")?.itemPlan ?? [];
    expect(plan.filter((item) => item.runClass === "owner").map((item) => item.ownerWhy)).toEqual([
      "real-session",
      "perception",
      "decision",
    ]);
    expect(plan[21]?.autoPart).toContain("empty key account");
    expect(plan[22]?.autoPart).toContain("measure");
    expect(plan[23]?.autoPart).toBeNull();
    expect(plan[23]?.specFile).toBeNull();
  });

  it("flags no Phase 7 item as full-profile", () => {
    const plan = specMapForPhase("07")?.itemPlan ?? [];
    expect(plan.filter((item) => item.profile === "full")).toEqual([]);
  });

  it("treats an unknown phase as a usage error, and null from the lookup", () => {
    expect(specMapForPhase("99")).toBeNull();
    expect(() => requireSpecMapForPhase("99")).toThrow(UsageError);
    expect(() => requireSpecMapForPhase("99")).toThrow(/phase/i);
    expect(requireSpecMapForPhase("06").itemPlan).toBe(UAT_ITEM_PLAN);
  });

  it("does not echo the phase value it was asked about", () => {
    const hostile = "99-<script>";
    try {
      requireSpecMapForPhase(hostile);
      throw new Error("expected a usage error");
    } catch (error) {
      expect((error as Error).message).not.toContain("script");
    }
  });
});

run("the Phase 7 plan matches 07-UAT.md (Test 1)", () => {
  const parsed = planned ? parseUatScript(readFileSync(scriptPath(), "utf8")) : parseUatScript("");

  it("parses 24 items", () => {
    expect(parsed.items).toHaveLength(24);
    expect(parsed.frontMatter.phase).toMatch(/^07-/);
  });

  it("gives every item the run, via, owner-why, auto-part and spec line the plan holds", () => {
    const plan = specMapForPhase("07")?.itemPlan ?? [];
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
      const prefix = `[07-UAT#${String(entry.number).padStart(2, "0")}]`;
      expect(item?.spec ?? null, `spec ${entry.number}`).toBe(
        entry.specFile === null ? null : `${entry.specFile}::${prefix}`,
      );
    }
  });

  it("agrees with the classification check of the lint library", () => {
    expect(checkMapAgainstScript(parsed.items, specMapForPhase("07")?.itemPlan ?? [])).toEqual([]);
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
