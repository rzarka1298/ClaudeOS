import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintTagsCommand } from "./lint-command.js";
import { REPO_ROOT } from "./repo-paths.js";
import { specMapForPhase } from "./spec-map.js";
import { SPEC_FILES_09, UAT_ITEM_PLAN_09, UAT_PHASE_PREFIX_09 } from "./spec-map-09.js";
import { checkMapAgainstScript, extractSpecTitles } from "./tag-lint.js";
import { classifyResult } from "./uat-audit.js";
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

/** `pass —`, `fail —` or `accepted —` then the measured values; `[pending]` until the owner or runner records. */
const RESULT_FORM = /^(pass|fail|accepted) — \S/;

/**
 * The recording state of a script, valid at any point from untouched to fully recorded: each result
 * is `[pending]` or a recognised verb in the house form, the Summary total equals the item count,
 * and the front matter says `testing` exactly while something is pending (the audit's own rule).
 */
function recordingProblems(script: ReturnType<typeof parseUatScript>): string[] {
  const problems: string[] = [];
  let pending = 0;
  for (const item of script.items) {
    const value = item.resultValue ?? "";
    if (item.resultLines !== 1)
      problems.push(`item ${item.number} has ${item.resultLines} result lines`);
    else if (value.startsWith("[pending]")) pending += 1;
    else if (classifyResult(value) === "unrecognised" || !RESULT_FORM.test(value)) {
      problems.push(
        `item ${item.number} has a result in neither the pending nor the recorded form`,
      );
    }
  }
  if (script.summary.total !== String(script.items.length))
    problems.push("the Summary total is wrong");
  const status = script.frontMatter.status ?? "";
  if (pending > 0 && status !== "testing")
    problems.push("results are pending but status is not testing");
  if (pending === 0 && status !== "complete")
    problems.push("every result is recorded but status is not complete");
  return problems;
}

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

  it("validates the current recording state, whatever has been recorded so far", () => {
    expect(recordingProblems(parsed)).toEqual([]);
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

  it("uses only the USERNAME placeholder for home paths and validates the recording state", () => {
    expect(recordingProblems(parsed)).toEqual([]);
    expect(text).not.toMatch(/\/Users\/(?!USERNAME\b)[A-Za-z0-9._$<>-]/);
  });
});

run(
  "the owner steps are safe to follow and honest about keys (FIX11, findings 3 and 5 to 11)",
  () => {
    const text = planned ? readFileSync(scriptPath(), "utf8") : "";
    const block = (number: number): string => {
      const start = text.indexOf(`### ${number}. `);
      const next = text.indexOf("\n### ", start + 1);
      const end = next === -1 ? text.indexOf("\n## ", start + 1) : next;
      return text.slice(start, end === -1 ? undefined : end);
    };
    const section = (heading: string): string => {
      const start = text.indexOf(`\n## ${heading}`);
      const next = text.indexOf("\n## ", start + 1);
      return text.slice(start, next === -1 ? undefined : next);
    };
    const SAVED = "/tmp/ccc-keychains-before.txt";

    it("tells the owner how to word each result (Setup)", () => {
      expect(section("Setup")).toMatch(/`pass —`, `fail —` or `accepted —`/);
    });

    it("never claims a key survives a re-install: every install creates a new key and fingerprint (finding 3)", () => {
      for (const number of [9, 13, 15, 16, 19]) {
        expect(block(number), `item ${number}`).not.toMatch(
          /fingerprint is unchanged|unchanged unless/i,
        );
      }
      expect(block(16)).toMatch(/new (Key )?fingerprint/i);
      expect(block(16)).toMatch(/re-install[^\n]*(new|different)|(new|different)[^\n]*re-install/i);
      expect(block(9)).not.toMatch(/for items 14 to 16/);
      for (const number of [15, 19]) {
        expect(block(number), `item ${number}`).toMatch(/immediately before/i);
      }
      expect(block(19)).toMatch(/no install in between|without an install/i);
    });

    it("guards every search-list change on a saved list that holds the login keychain (finding 5)", () => {
      const lines = text.split("\n").filter((line) => /list-keychains -d user -s /.test(line));
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const line of lines) {
        expect(line, line).toContain(`[ -s ${SAVED} ]`);
        expect(line, line).toContain(`grep -q login.keychain ${SAVED}`);
        expect(line, line).toContain("STOP: saved list missing");
        expect(line, line).not.toMatch(/\bexit\b/);
      }
    });

    it("spells out the restore and delete commands in Teardown and keeps the saved list until it matches (finding 5)", () => {
      const teardown = section("Teardown");
      expect(teardown).toContain("security delete-keychain /tmp/ccc-shadow.keychain-db");
      expect(teardown).toMatch(/list-keychains -d user -s/);
      expect(teardown).toMatch(
        new RegExp(
          `if diff .*${SAVED.replace(/[./]/g, "\\$&")}.*; then rm -f ${SAVED.replace(/[./]/g, "\\$&")}`,
        ),
      );
    });

    it("checks the custody script's test item by the service it prints, without hiding errors (finding 6)", () => {
      const item = block(12);
      expect(item).toMatch(/service: com\.claude-command-c[a-z]+\.uat-/);
      expect(item).toMatch(/security find-generic-password -a <account> -s <service>/);
      expect(item).toMatch(/exits? (with )?44/);
      expect(item).not.toContain("dump-keychain");
      expect(item).not.toContain("2>/dev/null");
      expect(item).toMatch(/left over|leftover/i);
      const script = readFileSync(join(REPO_ROOT, "scripts/presence/test-custody.sh"), "utf8");
      expect(script).toMatch(/echo "service: \$\{SERVICE\}"/);
      expect(script).toMatch(/echo "account: \$\{ACCOUNT\}"/);
    });

    it("names the button to press on a Keychain sheet, the same in items 13 and 18 (finding 7)", () => {
      for (const number of [13, 18]) {
        expect(block(number), `item ${number}`).toMatch(/press Deny/);
        expect(block(number), `item ${number}`).toMatch(/never (choose )?Always Allow/i);
      }
    });

    it("reads a modification time as an exact instant, and counts log lines before a restart (findings 8 and 9)", () => {
      expect(block(11)).toContain("stat -f '%Sm' -t '%FT%T'");
      const fourteen = block(14);
      expect(fourteen).toMatch(/wc -l </);
      expect(fourteen).toMatch(/tail -n \+/);
    });

    it("lists every item that touches the installed setup in the preamble (finding 10)", () => {
      const preamble = text.slice(0, text.indexOf("## Setup"));
      expect(preamble).toMatch(/13 to 16/);
      expect(preamble).toMatch(/16 \(step 5/);
      expect(preamble).toMatch(/14 \(b\)/);
    });
  },
);

describe("recordingProblems accepts every stage of the sitting (FIX11 finding 2)", () => {
  const script = (status: string, results: string[]) =>
    parseUatScript(
      [
        "---",
        `status: ${status}`,
        "phase: 09-x",
        "---",
        "",
        "## Tests",
        "",
        ...results.flatMap((result, index) => [
          `### ${index + 1}. Item`,
          "run: owner",
          "owner-why: real-session",
          `result: ${result}`,
          "",
        ]),
        "## Summary",
        "",
        `total: ${results.length}`,
        "",
      ].join("\n"),
    );

  it("accepts untouched, partly recorded and fully recorded scripts with the matching status", () => {
    expect(recordingProblems(script("testing", ["[pending]", "[pending]"]))).toEqual([]);
    expect(recordingProblems(script("testing", ["pass — owner: ok", "[pending]"]))).toEqual([]);
    expect(
      recordingProblems(script("complete", ["pass — owner: ok", "accepted — not walked: none"])),
    ).toEqual([]);
  });

  it("rejects an unrecognised verb, a bare verb, and a status that disagrees with the results", () => {
    expect(recordingProblems(script("testing", ["done", "[pending]"])).join(" ")).toMatch(
      /neither/,
    );
    expect(recordingProblems(script("testing", ["pass", "[pending]"])).join(" ")).toMatch(
      /neither/,
    );
    expect(recordingProblems(script("complete", ["pass — ok", "[pending]"])).join(" ")).toMatch(
      /not testing|status/,
    );
    expect(recordingProblems(script("testing", ["pass — ok"])).join(" ")).toMatch(/not complete/);
  });
});
