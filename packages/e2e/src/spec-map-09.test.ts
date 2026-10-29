import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintTagsCommand } from "./lint-command.js";
import { REPO_ROOT } from "./repo-paths.js";
import { specMapForPhase } from "./spec-map.js";
import { SPEC_FILES_09, UAT_ITEM_PLAN_09, UAT_PHASE_PREFIX_09 } from "./spec-map-09.js";
import { checkMapAgainstScript, extractSpecTitles } from "./tag-lint.js";
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

run("the Phase 9 plan matches 09-UAT.md (Tasks 1 to 3, Test 1)", () => {
  const parsed = planned ? parseUatScript(readFileSync(scriptPath(), "utf8")) : parseUatScript("");

  it("parses as many items as the plan holds, numbered from 1", () => {
    expect(parsed.frontMatter.phase).toMatch(/^09-/);
    expect(parsed.items.map((item) => item.number)).toEqual(
      UAT_ITEM_PLAN_09.map((item) => item.number),
    );
    expect(UAT_ITEM_PLAN_09.map((item) => item.number)).toEqual(
      Array.from({ length: UAT_ITEM_PLAN_09.length }, (_, index) => index + 1),
    );
  });

  it("gives every item the run, via, owner-why, auto-part and spec line the plan holds", () => {
    for (const entry of UAT_ITEM_PLAN_09) {
      const item = parsed.items.find((candidate) => candidate.number === entry.number);
      expect(item, `item ${entry.number}`).toBeDefined();
      expect(item?.runValue, `run ${entry.number}`).toBe(entry.runClass);
      expect(item?.ownerWhy, `owner-why ${entry.number}`).toBe(entry.ownerWhy);
      expect(item?.autoPart !== null, `auto-part ${entry.number}`).toBe(entry.autoPart !== null);
      if (entry.runClass !== "owner") {
        expect([...(item?.via ?? [])].sort(), `via ${entry.number}`).toEqual([...entry.via].sort());
      } else {
        expect(item?.via, `via ${entry.number}`).toEqual([]);
      }
      const prefix = `[09-UAT#${String(entry.number).padStart(2, "0")}]`;
      expect(item?.spec ?? null, `spec ${entry.number}`).toBe(
        entry.specFile === null ? null : `${entry.specFile}::${prefix}`,
      );
    }
  });

  it("agrees with the classification check of the lint library", () => {
    expect(checkMapAgainstScript(parsed.items, UAT_ITEM_PLAN_09)).toEqual([]);
  });

  it("raises none of the tag-format findings over the real script", () => {
    const result = lintTagsCommand({
      scriptPath: scriptPath(),
      specsDir: join(REPO_ROOT, "packages", "e2e", "specs"),
      readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
      listFiles: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
    });
    const formatFindings = result.lines.filter((line) =>
      /^(RUN_INVALID|VIA_INVALID|SPEC_INVALID|OWNER_WHY_INVALID|MAP_MISMATCH|MAP_ITEM_)/.test(line),
    );
    expect(formatFindings).toEqual([]);
  });

  it("leaves every result [pending] and the Summary total equal to the item count", () => {
    for (const item of parsed.items) {
      expect(item.resultValue, `result ${item.number}`).toBe("[pending]");
    }
    expect(parsed.summary.total).toBe(String(parsed.items.length));
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

describe("every hardening spec title belongs to an automated Phase 9 item (Task 2, Test 2)", () => {
  const source = existsSync(join(REPO_ROOT, SPEC))
    ? readFileSync(join(REPO_ROOT, SPEC), "utf8")
    : "";
  const titles = extractSpecTitles(SPEC, source, "09").map((entry) => entry.title);
  const automatedNumbers = UAT_ITEM_PLAN_09.filter((item) => item.runClass !== "owner").map(
    (item) => item.number,
  );

  it("holds exactly one title per automated item, in item order, each with the prefix", () => {
    const numbers = titles.map((title) => Number(/^\[09-UAT#(\d{2})\] /.exec(title)?.[1]));
    expect(numbers).toEqual(automatedNumbers);
    expect(automatedNumbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("maps every automated item to the hardening spec and no owner item to a spec", () => {
    for (const item of UAT_ITEM_PLAN_09) {
      expect(item.specFile, `item ${item.number}`).toBe(item.runClass === "owner" ? null : SPEC);
    }
  });
});
