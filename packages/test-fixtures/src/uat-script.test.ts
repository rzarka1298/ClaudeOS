import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./gate-repo.js";

/**
 * Plan 06-28 Task 2 (D-46, T-06-37, T-06-34, T-06-27, T-06-36): keeps the owner-run
 * live-Obsidian script honest. It reads 06-UAT.md, checks its structure, coverage and
 * safety stance, and proves every flag it quotes exists. The script is a private
 * planning artifact: a public clone has no `.planning/` and reports that once.
 */

const PLANNING_INDEX = join(REPO_ROOT, ".planning", "ROADMAP.md");
const PHASES = join(REPO_ROOT, ".planning", "phases");
const planned = existsSync(PLANNING_INDEX);

function phaseDir(): string | undefined {
  if (!existsSync(PHASES)) return undefined;
  const name = readdirSync(PHASES).find((entry) => entry.startsWith("06-"));
  return name === undefined ? undefined : join(PHASES, name);
}

const dir = phaseDir();
const scriptPath = dir === undefined ? "" : join(dir, "06-UAT.md");
const text = planned && existsSync(scriptPath) ? readFileSync(scriptPath, "utf8") : "";

interface UatTest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
}

function parseTests(source: string): UatTest[] {
  const parts = source.split(/^### (\d+)\. (.+)$/m);
  const tests: UatTest[] = [];
  for (let index = 1; index < parts.length; index += 3) {
    const body = (parts[index + 2] ?? "").split(/^## /m)[0] as string;
    const tagLine = /^tags: (.+)$/m.exec(body);
    tests.push({
      number: Number(parts[index]),
      title: parts[index + 1] as string,
      body,
      tags: tagLine === null ? [] : (tagLine[1] as string).split(/[,\s]+/).filter(Boolean),
    });
  }
  return tests;
}

function section(source: string, heading: string): string {
  const match = new RegExp(`^## ${heading}\\b.*$`, "m").exec(source);
  if (match === null) return "";
  const rest = source.slice(match.index + match[0].length);
  return rest.split(/^## /m)[0] as string;
}

const run = planned ? describe : describe.skip;

describe("guard (Test 1)", () => {
  it("finds the phase directory and the script whenever the planning index exists", () => {
    if (!planned) {
      // A public clone has no .planning/: the script is not available here.
      expect(existsSync(PLANNING_INDEX)).toBe(false);
      return;
    }
    expect(dir, "the phase directory").toBeDefined();
    expect(existsSync(scriptPath), "06-UAT.md").toBe(true);
  });
});

run("front matter and results (Test 2)", () => {
  const tests = parseTests(text);

  it("has the GSD front matter and a Current Test block", () => {
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
    expect(front).toMatch(/^status: testing$/m);
    expect(front).toMatch(/^phase: 06-approval-inbox-canonical-tasks$/m);
    expect(front).toMatch(/^source: \[.*06-\d\d-SUMMARY\.md.*\]$/m);
    expect(front).toMatch(/^started: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
    expect(front).toMatch(/^updated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
    const current = section(text, "Current Test");
    expect(current).toMatch(/number: 1\b/);
    expect(current).toMatch(/awaiting: user response/);
  });

  it("numbers 26 tests consecutively, each with an expected block and a pending result", () => {
    expect(tests.map((test) => test.number)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
    for (const test of tests) {
      expect(test.title.length, `test ${test.number}`).toBeGreaterThan(3);
      expect(test.body, `test ${test.number}`).toMatch(/^expected: /m);
      expect(test.body.match(/^result: .*$/gm), `test ${test.number}`).toEqual([
        "result: [pending]",
      ]);
    }
  });

  it("holds no result value other than pending anywhere", () => {
    const results = text.match(/^\s*result:.*$/gm) ?? [];
    expect(results.length).toBe(26);
    for (const line of results) expect(line.trim()).toBe("result: [pending]");
    expect(text).not.toMatch(/^(reported|severity|reason|blocked_by):/m);
  });

  it("counts every test as pending in the Summary block", () => {
    const summary = section(text, "Summary");
    expect(summary).toMatch(/^total: 26$/m);
    expect(summary).toMatch(/^pending: 26$/m);
    for (const key of ["passed", "issues", "skipped", "blocked"]) {
      expect(summary).toMatch(new RegExp(`^${key}: 0$`, "m"));
    }
  });
});

run("coverage (Tests 3 and 4)", () => {
  const tests = parseTests(text);
  const all = tests.map((test) => test.body).join("\n");

  it("cites every approval and task requirement in some expected block", () => {
    const ids = [
      ...["03", "04", "05", "06", "07", "08", "09", "10"].map((n) => `APPR-${n}`),
      ...["02", "03", "04", "05", "06", "07", "08", "09"].map((n) => `TASK-${n}`),
    ];
    for (const id of ids) expect(all, id).toContain(id);
    const ack = tests.find((test) => test.title.toLowerCase().includes("acknowledg"));
    expect(ack?.body).toContain("ADR-08");
    expect(ack?.body).toContain("D-47");
  });

  it("tags U-1 to U-7 once each and ties force-terminate to Phase 5 UAT-17 and D-60", () => {
    for (const label of ["U-1", "U-2", "U-3", "U-4", "U-5", "U-6", "U-7"]) {
      expect(tests.filter((test) => test.tags.includes(label)).length, label).toBe(1);
    }
    const force = tests.find((test) => test.title.toLowerCase().includes("force-terminate"));
    expect(force?.body).toContain("UAT-17");
    expect(force?.body).toContain("D-60");
  });
});

run("setup and teardown (Test 5)", () => {
  it("states the stance in the first paragraph", () => {
    const intro = text.slice(text.indexOf("# Phase 6")).split("\n\n").slice(0, 3).join("\n\n");
    expect(intro).toMatch(/Agents\s+never\s+mark/);
    expect(intro).toMatch(/real\s+operational\s+store/);
  });

  it("sets up its own runtime directory, vaults and test-only variables", () => {
    const setup = section(text, "Setup");
    expect(setup).toContain("/Users/USERNAME/");
    expect(setup).toMatch(/CCC_RUNTIME_DIR=\/Users\/USERNAME\//);
    for (const name of [
      "CCC_ENABLE_TEST_OVERRIDES=1",
      "CCC_APPROVAL_TEST_TTL_MS=",
      "CCC_APPROVAL_SWEEP_MS=",
      "socketPathOverride",
      "scripts/generate-task-fixture-vault.mjs",
      "--live-check",
      "--count 10000",
      "--dry-run",
    ]) {
      expect(setup, name).toContain(name);
    }
  });

  it("restores everything in Teardown", () => {
    const teardown = section(text, "Teardown");
    for (const name of [
      "pnpm run service:install",
      "unset CCC_ENABLE_TEST_OVERRIDES",
      "unset CCC_APPROVAL_TEST_TTL_MS",
      "unset CCC_APPROVAL_SWEEP_MS",
      "rm -rf",
      "scripts/claude-hooks/status.sh",
      "socketPathOverride",
    ]) {
      expect(teardown, name).toContain(name);
    }
  });
});

run("paths, names and privacy (Test 6)", () => {
  it("writes every home path with the USERNAME placeholder", () => {
    for (const match of text.matchAll(/\/Users\/([^/\s`"')]+)/g)) {
      expect(match[1], match[0]).toBe("USERNAME");
    }
    expect(text).not.toMatch(/\/(private|var)\/(tmp|folders)\b/);
  });

  it("holds no email address or token-shaped string", () => {
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(text).not.toMatch(/\b(sk-|ghp_|gho_|xox[bap]-|AKIA)[A-Za-z0-9_-]{8,}/);
    expect(text).not.toMatch(/\b[0-9a-f]{40,}\b/);
  });

  it("names only pnpm scripts and repository paths that exist", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const match of text.matchAll(/pnpm run ([a-z][a-z0-9:-]*)/g)) {
      expect(pkg.scripts[match[1] as string], match[0]).toBeDefined();
    }
    for (const match of text.matchAll(/\bscripts\/[A-Za-z0-9_./-]+\.(?:sh|mjs)\b/g)) {
      expect(existsSync(join(REPO_ROOT, match[0])), match[0]).toBe(true);
    }
  });
});

run("flag drift (Test 7)", () => {
  it("quotes only flags the fixture command prints in its help", () => {
    const help = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "scripts", "generate-task-fixture-vault.mjs"), "--help"],
      { encoding: "utf8" },
    );
    expect(help.status).toBe(0);
    let checked = 0;
    for (const line of text.split("\n")) {
      if (!line.includes("generate-task-fixture-vault.mjs")) continue;
      for (const flag of line.match(/--[a-z][a-z-]*/g) ?? []) {
        expect(help.stdout, flag).toContain(flag);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(3);
  });
});

run("store safety (Test 8)", () => {
  it("reads the operational store only from a read-only copy", () => {
    expect(text).toMatch(/cp .*operational\.db/);
    for (const line of text.split("\n")) {
      if (!/sqlite3/.test(line)) continue;
      expect(line, line).toMatch(/-readonly/);
      expect(line, line).not.toMatch(/operational\.db(?!-copy)/);
      expect(line, line).toMatch(/operational-copy\.db/);
    }
    expect(text).not.toMatch(/sqlite3 [^\n]*\/operational\.db/);
  });
});
