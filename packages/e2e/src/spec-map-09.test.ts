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

describe("the Phase 9 owner items (Task 3, Tests 1 and 2)", () => {
  const owners = UAT_ITEM_PLAN_09.filter((item) => item.runClass === "owner");

  it("plans 8 automated items and owner items 9 to 19, each real-session except the decision at 18", () => {
    expect(UAT_ITEM_PLAN_09).toHaveLength(19);
    expect(UAT_ITEM_PLAN_09.filter((item) => item.runClass === "auto")).toHaveLength(8);
    expect(UAT_ITEM_PLAN_09.filter((item) => item.runClass === "auto+look")).toHaveLength(0);
    expect(owners.map((item) => item.number)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(owners.map((item) => item.ownerWhy)).toEqual([
      "real-session",
      "real-session",
      "real-session",
      "real-session",
      "real-session",
      "real-session",
      "real-session",
      "real-session",
      "real-session",
      "decision",
      "real-session",
    ]);
    for (const item of owners) {
      expect(item.specFile, `spec ${item.number}`).toBeNull();
      expect(item.autoPart, `auto-part ${item.number}`).toBeNull();
      expect(item.via, `via ${item.number}`).toEqual([]);
    }
  });
});

run("the Phase 9 owner items in 09-UAT.md (Task 3, Test 2)", () => {
  const text = planned ? readFileSync(scriptPath(), "utf8") : "";
  const parsed = parseUatScript(text);
  /** The whole block of one item, tags and expected text. */
  const block = (number: number): string => {
    const start = text.indexOf(`### ${number}. `);
    const next = text.indexOf("\n### ", start + 1);
    const end = next === -1 ? text.indexOf("\n## ", start + 1) : next;
    return text.slice(start, end === -1 ? undefined : end);
  };

  it("states the tally of the plan", () => {
    expect(text).toContain("Tally by tag: auto 8 · auto+look 0 · owner 11 · total 19");
    expect(parsed.items).toHaveLength(19);
  });

  it("tags items 9 to 19 run: owner with the plan's owner-why, and none has a spec", () => {
    for (const item of UAT_ITEM_PLAN_09.filter((entry) => entry.runClass === "owner")) {
      const read = parsed.items.find((candidate) => candidate.number === item.number);
      expect(read?.runValue, `run ${item.number}`).toBe("owner");
      expect(read?.ownerWhy, `owner-why ${item.number}`).toBe(item.ownerWhy);
      expect(read?.spec, `spec ${item.number}`).toBeNull();
    }
  });

  it("item 9 names try-prompt, Cancel giving refused, the gesture giving verified, and Available after Run checks again", () => {
    const item = block(9);
    expect(item).toContain("node scripts/presence/try-prompt.mjs");
    expect(item).toMatch(/Cancel[^\n]*refused/);
    expect(item).toMatch(/verified/);
    expect(item).toMatch(/Available/);
    expect(item).toContain("Run checks again");
  });

  it("item 10 names the install three times, no Bootstrap failed: 5, one job via launchctl print, and the service answering", () => {
    const item = block(10);
    expect(item).toContain("pnpm run service:install");
    expect(item).toMatch(/three times/);
    expect(item).toContain("Bootstrap failed: 5");
    expect(item).toContain("launchctl print");
    expect(item).toMatch(/Running/);
  });

  it("covers the other owner-only checks the wave reviews recorded", () => {
    expect(block(11)).toMatch(/one (Touch ID|prompt)/i);
    expect(block(11)).toContain("WARNING");
    expect(block(11)).toContain("service:uninstall");
    expect(block(12)).toContain("sh scripts/presence/test-custody.sh");
    expect(block(13)).toContain("pnpm run presence:build");
    expect(block(14)).toContain("presence-pin-adopted");
    expect(block(14)).toContain("presence-pin-marker-ignored");
    expect(block(14)).toMatch(/10 minutes|ten minutes/);
    expect(block(15)).toContain("presence-pin-changed");
    expect(block(16)).toMatch(/Unknown/);
    expect(block(16)).toMatch(/fingerprint/i);
    expect(block(17)).toMatch(/pending/);
    expect(block(17)).toMatch(/09-18/);
    expect(block(18)).toContain("attr_delete_prompts");
    expect(block(18)).toContain("verdict_sc2");
    expect(block(19)).toMatch(/shadow/i);
    expect(block(19)).toContain("list-keychains");
  });

  it("leaves every owner result [pending] and uses only the USERNAME placeholder for home paths", () => {
    for (const item of parsed.items)
      expect(item.resultValue, `result ${item.number}`).toBe("[pending]");
    expect(text).not.toMatch(/\/Users\/(?!USERNAME\b)[A-Za-z0-9._$<>-]/);
  });
});
