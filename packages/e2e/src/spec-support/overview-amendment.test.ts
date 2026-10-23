import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import { parsePreservedBlocks } from "../uat-audit.js";

/**
 * Plan 08-19 Task 3 (D-47, T-08-49): Phase 7's pending auto item 20 ("The Overview is unchanged")
 * became false when Phase 8 gave the Today and Technology cards live data. The amendment changes
 * that one item's heading and `expected` text and nothing else of 07-UAT.md, and is recorded in the
 * Amendments block of 08-UAT-AUDIT.md, which regeneration keeps. The files are private planning
 * artifacts: a public clone has no `.planning/` and these tests skip.
 */

const PLANNING_INDEX = join(REPO_ROOT, ".planning", "ROADMAP.md");
const PHASES = join(REPO_ROOT, ".planning", "phases");
const run = existsSync(PLANNING_INDEX) ? describe : describe.skip;

function phaseFile(prefix: string, name: string): string {
  const dir = readdirSync(PHASES).find((entry) => entry.startsWith(prefix));
  return join(PHASES, dir ?? `${prefix}missing`, name);
}

/**
 * SHA-256 of 07-UAT.md at the base of plan 08-19 (commit 38f6d5b1) after `normalise` below. The
 * digest was taken from that commit's copy in the red step, so it pins every line the amendment
 * may not touch.
 */
const BASE_DIGEST = "e11eee93595a1c54b18514ffddf9a399721c2a884493dbfc0cf4a6e5501c3265";

/**
 * 07-UAT.md without the lines the amendment may change or that other tools own: item 20's heading
 * and its `expected` block, every `result:` and `auto-result:` line (the owner's and the runner's)
 * and the front matter's `updated:` line. What is left must equal the base copy byte for byte.
 */
function normalise(text: string): string {
  const out: string[] = [];
  let inItem20 = false;
  let inExpected = false;
  let inFront = false;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (index === 0 && line === "---") {
      inFront = true;
      out.push(line);
      continue;
    }
    if (inFront) {
      if (line === "---") inFront = false;
      if (/^updated:/.test(line)) continue;
      out.push(line);
      continue;
    }
    const heading = /^### (\d+)\. /.exec(line);
    if (heading !== null) {
      inItem20 = heading[1] === "20";
      inExpected = false;
      if (inItem20) continue;
    } else if (/^## /.test(line)) {
      inItem20 = false;
      inExpected = false;
    }
    if (inItem20) {
      if (/^expected:/.test(line)) {
        inExpected = true;
        continue;
      }
      if (inExpected) {
        if (/^ {2}\S/.test(line)) continue;
        inExpected = false;
      }
    }
    if (/^(?:auto-)?result:/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** The block of one numbered item: from its `### N.` heading to the next heading. */
function itemBlock(text: string, number: number): string {
  const start = text.search(new RegExp(`^### ${number}\\. `, "m"));
  if (start < 0) return "";
  const rest = text.slice(start);
  const next = rest.slice(4).search(/^##+ /m);
  return next < 0 ? rest : rest.slice(0, next + 4);
}

const AMENDED_TITLE =
  "The Overview shows the live Today and technology cards (superseded by Phase 8 SLICE-01)";

run("07-UAT.md item 20 after the amendment (Test 2)", () => {
  const text = readFileSync(phaseFile("07-", "07-UAT.md"), "utf8");
  const item = itemBlock(text, 20);

  it("carries the amended heading and keeps its number", () => {
    expect(item.split("\n")[0]).toBe(`### 20. ${AMENDED_TITLE}`);
  });

  it("keeps its run class, via and spec tags", () => {
    expect(item).toMatch(/^run: auto$/m);
    expect(item).toMatch(/^via: dom$/m);
    expect(item).toMatch(/^spec: packages\/e2e\/specs\/research-views\.e2e\.ts::\[07-UAT#20\]$/m);
  });

  it("expects the live cards and no longer says the Overview is unchanged", () => {
    const expected = item.slice(item.indexOf("expected:"), item.indexOf("\nresult:"));
    expect(expected).toContain("Partial");
    expect(expected).toContain("Cached");
    expect(expected).toContain("not part of this version");
    expect(expected).toContain("SLICE-01");
    expect(expected).not.toMatch(/permission-required/);
    expect(expected).not.toMatch(/still unavailable/);
    expect(item).not.toMatch(/is unchanged/);
  });

  it("has exactly one result line, still pending unless the runner has written an auto-result", () => {
    const results = item.split("\n").filter((line) => /^result:/.test(line));
    expect(results).toHaveLength(1);
    if (!/^auto-result:/m.test(item)) expect(results[0]).toBe("result: [pending]");
  });

  it("changed no other line of the file (the base copy's digest)", () => {
    expect(createHash("sha256").update(normalise(text)).digest("hex")).toBe(BASE_DIGEST);
  });

  it("control: the digest does see a change to another item's text", () => {
    const touched = text.replace(
      "### 21. Logs and settings stay private",
      "### 21. Logs stay private",
    );
    expect(createHash("sha256").update(normalise(touched)).digest("hex")).not.toBe(BASE_DIGEST);
    const resulted = text.replace(/^result: \[pending\]$/m, "result: [ok]");
    expect(createHash("sha256").update(normalise(resulted)).digest("hex")).toBe(BASE_DIGEST);
  });

  it("is named by the same title in the spec case, behind the unchanged [07-UAT#20] prefix", () => {
    const spec = readFileSync(
      join(REPO_ROOT, "packages", "e2e", "specs", "research-views.e2e.ts"),
      "utf8",
    );
    expect(spec).toContain(`it("[07-UAT#20] ${AMENDED_TITLE}"`);
    expect(spec).not.toContain("The Overview is unchanged");
  });
});

run("08-UAT-AUDIT.md Amendments block (Test 3)", () => {
  const audit = readFileSync(phaseFile("08-", "08-UAT-AUDIT.md"), "utf8");

  it("records the item 20 change with the decision that allows it", () => {
    const region = parsePreservedBlocks(audit).ownerRegion ?? "";
    expect(region.startsWith("## Amendments")).toBe(true);
    expect(region).toContain("07-UAT");
    expect(region).toContain("item 20");
    expect(region).toContain("D-47");
    expect(region).toContain(AMENDED_TITLE);
    expect(region).not.toContain("_None recorded yet");
  });

  it("is inside the region regeneration keeps, ahead of the milestone statement", () => {
    const region = parsePreservedBlocks(audit).ownerRegion ?? "";
    expect(region.indexOf("D-47")).toBeLessThan(region.indexOf("## Milestone statement"));
    expect(region.endsWith("\n")).toBe(true);
  });
});
