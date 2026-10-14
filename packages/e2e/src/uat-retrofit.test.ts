import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintTagsCommand } from "./lint-command.js";
import { REPO_ROOT } from "./repo-paths.js";
import { UAT_ITEM_PLAN, UAT_PHASE_PREFIX } from "./spec-map.js";
import { SPIKE_DECISIONS } from "./spike-decisions.js";
import { checkMapAgainstScript } from "./tag-lint.js";
import { parseUatScript } from "./uat-tags.js";

/**
 * Plan 05.2-10 Task 1 (D-09, E2E-06, T-05.2-42): pins the tag convention applied to the 26
 * Phase 6 items, proves the owner's 26 recorded result lines did not move, and keeps the
 * script consistent with the spec map and the real spec files. The script is a private planning
 * artifact: a public clone has no `.planning/` and these tests skip.
 */

/**
 * SHA-256 of the 26 `result:` lines (each line as written, joined with a line feed), taken from
 * the committed script BEFORE the retrofit edit. Any change to an owner's result changes this.
 */
export const RESULT_LINES_SHA256 =
  "634f136269a3fc7ccd0997db549578bf7a01204c11a64008d05eeaf252c129f8";

const PLANNING_INDEX = join(REPO_ROOT, ".planning", "ROADMAP.md");
const PHASES = join(REPO_ROOT, ".planning", "phases");
const SPECS_DIR = join(REPO_ROOT, "packages", "e2e", "specs");
const planned = existsSync(PLANNING_INDEX);

function scriptPath(): string {
  const name = readdirSync(PHASES).find((entry) => entry.startsWith("06-"));
  return join(PHASES, name ?? "06-missing", "06-UAT.md");
}

const run = planned ? describe : describe.skip;

function load() {
  const text = readFileSync(scriptPath(), "utf8");
  return { text, parsed: parseUatScript(text) };
}

run("the retrofit matches the spec map (Test 1)", () => {
  const { parsed } = planned ? load() : { parsed: parseUatScript("") };

  it("parses 26 items with the planned counts per class", () => {
    expect(parsed.items).toHaveLength(26);
    const count = (runClass: string) =>
      parsed.items.filter((item) => item.runClass === runClass).length;
    const planned = (runClass: string) =>
      UAT_ITEM_PLAN.filter((item) => item.runClass === runClass).length;
    expect(count("auto")).toBe(planned("auto"));
    expect(count("auto+look")).toBe(planned("auto+look"));
    expect(count("owner")).toBe(planned("owner"));
    // D-09 with its 2026-10-13 amendments: 16 auto, 2 auto+look and 8 owner.
    expect(count("auto")).toBe(16);
    expect(count("auto+look") + count("owner")).toBe(10);
  });

  it("gives every item the run, via, owner-why, auto-part and spec line the map holds", () => {
    for (const entry of UAT_ITEM_PLAN) {
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
      const prefix = `[${UAT_PHASE_PREFIX}-UAT#${String(entry.number).padStart(2, "0")}]`;
      expect(item?.spec ?? null, `spec ${entry.number}`).toBe(
        entry.specFile === null ? null : `${entry.specFile}::${prefix}`,
      );
    }
  });

  it("names the plain item numbers D-09 lists", () => {
    const numbers = (runClass: string) =>
      parsed.items.filter((item) => item.runClass === runClass).map((item) => item.number);
    expect(numbers("auto")).toEqual([5, 6, 7, 8, 10, 11, 14, 15, 16, 17, 18, 19, 21, 23, 24, 25]);
    expect(numbers("auto+look")).toEqual([20, 22]);
    expect(numbers("owner")).toEqual([1, 2, 3, 4, 9, 12, 13, 26]);
  });
});

run("lint clean over the real script and specs (Test 2)", () => {
  it("reports no finding from the tag lint command's library function", () => {
    const result = lintTagsCommand({
      scriptPath: scriptPath(),
      specsDir: SPECS_DIR,
      readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
      listFiles: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
    });
    expect(result.lines.filter((line) => /^[A-Z_]+/.test(line))).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("agrees with the classification table and names only existing spec files", () => {
    const { parsed } = load();
    expect(checkMapAgainstScript(parsed.items, UAT_ITEM_PLAN)).toEqual([]);
    for (const item of parsed.items) {
      if (item.spec === null) continue;
      const file = item.spec.split("::")[0] as string;
      expect(existsSync(join(REPO_ROOT, file)), file).toBe(true);
    }
  });
});

run("the owner's results are untouched (Test 3)", () => {
  it("holds 26 result lines whose hash equals the one recorded before the edit", () => {
    const { text } = load();
    const lines = text.split(/\r?\n/).filter((line) => /^\s*result:/.test(line));
    expect(lines).toHaveLength(26);
    const digest = createHash("sha256").update(lines.join("\n")).digest("hex");
    expect(digest).toBe(RESULT_LINES_SHA256);
  });
});

run("summary, intro and auto-result lines (Test 4)", () => {
  it("keeps total 26 and the old five keys summing to 26, with the ratified run's 18 auto passes recorded", () => {
    const { parsed } = load();
    const summary = parsed.summary;
    expect(summary.total).toBe("26");
    const keys = ["passed", "issues", "pending", "skipped", "blocked"];
    expect(keys.reduce((sum, key) => sum + Number(summary[key]), 0)).toBe(26);
    // Run 98a03adf (ratified): 18 auto items passed, none failed; the owner items carry their own results.
    expect(summary["auto-passed"]).toBe("18");
    for (const key of ["auto-failed", "owner-pending"]) {
      expect(summary[key], key).toBe("0");
    }
  });

  it("keeps the stance sentences and states that the runner writes only auto-result lines", () => {
    const { text } = load();
    const intro = text.slice(text.indexOf("# Phase 6")).split("\n\n").slice(0, 3).join("\n\n");
    expect(intro).toMatch(/Agents\s+never\s+mark/);
    expect(intro).toMatch(/real\s+operational\s+store/);
    expect(intro).toMatch(/writes\s+only\s+auto-result\s+lines/);
    expect(intro).toMatch(/ratif/);
    expect(intro).toMatch(/owner-tagged/);
  });

  it("holds an auto-result line from the ratified run on every auto and auto+look item, and none on an owner item", () => {
    const { text, parsed } = load();
    expect(text.match(/^auto-result:/gm)).toHaveLength(18);
    for (const item of parsed.items) {
      if (item.runValue === "owner") {
        expect(item.autoResult, `item ${item.number}`).toBeNull();
      } else {
        expect(item.autoResult, `item ${item.number}`).not.toBeNull();
      }
    }
    expect(text.match(/^auto-result: pass @ 98a03adf 2026-10-14$/gm)).toHaveLength(18);
  });
});

run("the banner downgrade is never silent (Test 6)", () => {
  it("keeps item 1 consistent with the recorded banner decision, in the map and the script", () => {
    const entry = UAT_ITEM_PLAN[0];
    const { parsed } = load();
    const item = parsed.items[0];
    expect(entry?.number).toBe(1);
    expect(item?.runValue).toBe(entry?.runClass);
    if (entry?.runClass === "owner") {
      // The downgrade: the banner appearance stays with the owner and the spy part is the auto-part.
      expect(entry.ownerWhy).toBe("banner-appearance");
      expect(entry.autoPart).not.toBeNull();
      expect(item?.ownerWhy).toBe("banner-appearance");
      expect(item?.autoPart).not.toBeNull();
    } else {
      expect(entry?.runClass).toBe("auto+look");
      expect([...(entry?.via ?? [])].sort()).toEqual(["shot", "spy"]);
    }
    // With the region capture on, the look item must be automated; with spy-only recorded, either
    // class is consistent, but only because the S1 re-run decides it (never a silent pass).
    if (SPIKE_DECISIONS.bannerAutomation === "spy-and-region") {
      expect(entry?.runClass).toBe("auto+look");
    }
  });
});
