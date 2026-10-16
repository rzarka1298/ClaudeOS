import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./gate-repo.js";

/**
 * Plan 07-18 Task 1 (D-28, D-46, T-07-46, T-07-47): keeps the Phase 7 live-Obsidian script honest.
 * It reads 07-UAT.md, checks its structure, tags, requirement coverage and safety stance, and
 * proves every command, script and spec title it quotes exists. The script is a private planning
 * artifact: a public clone has no `.planning/` and reports that once.
 *
 * The tag vocabulary is read from the runner's own source (`packages/e2e/src/uat-tags.ts`) so the
 * two cannot drift; test-fixtures may not import the e2e package (it is a leaf), so the arrays are
 * read as text.
 */

const PLANNING_INDEX = join(REPO_ROOT, ".planning", "ROADMAP.md");
const PHASES = join(REPO_ROOT, ".planning", "phases");
const planned = existsSync(PLANNING_INDEX);

function phaseDir(): string | undefined {
  if (!existsSync(PHASES)) return undefined;
  const name = readdirSync(PHASES).find((entry) => entry.startsWith("07-"));
  return name === undefined ? undefined : join(PHASES, name);
}

const dir = phaseDir();
const scriptPath = dir === undefined ? "" : join(dir, "07-UAT.md");
const text = planned && existsSync(scriptPath) ? readFileSync(scriptPath, "utf8") : "";

interface UatTest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly tags: ReadonlyMap<string, string>;
}

function parseTests(source: string): UatTest[] {
  const parts = source.split(/^### (\d+)\. (.+)$/m);
  const tests: UatTest[] = [];
  for (let index = 1; index < parts.length; index += 3) {
    const body = (parts[index + 2] ?? "").split(/^## /m)[0] as string;
    const tags = new Map<string, string>();
    for (const line of body.split("\n")) {
      const match = /^([a-z][a-z-]*): (.*)$/.exec(line);
      if (match !== null && !tags.has(match[1] as string)) {
        tags.set(match[1] as string, (match[2] as string).trim());
      }
    }
    tests.push({
      number: Number(parts[index]),
      title: parts[index + 1] as string,
      body,
      tags,
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

/** The string members of `export const NAME = [ ... ] as const;` in the runner's tag module. */
function vocabulary(name: string): string[] {
  const source = readFileSync(join(REPO_ROOT, "packages", "e2e", "src", "uat-tags.ts"), "utf8");
  const match = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(source);
  if (match === null) throw new Error(`vocabulary ${name} not found`);
  return [...(match[1] as string).matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

const run = planned ? describe : describe.skip;
const TOTAL = 24;

describe("guard (Test 1)", () => {
  it("finds the phase directory and the script whenever the planning index exists", () => {
    if (!planned) {
      // A public clone has no .planning/: the script is not available here.
      expect(existsSync(PLANNING_INDEX)).toBe(false);
      return;
    }
    expect(dir, "the phase directory").toBeDefined();
    expect(existsSync(scriptPath), "07-UAT.md").toBe(true);
  });
});

run("front matter and results (Test 2)", () => {
  const tests = parseTests(text);
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";

  it("has the GSD front matter, the phase name and a Current Test block", () => {
    expect(front).toMatch(/^status: testing$/m);
    expect(front).toMatch(/^phase: 07-cited-research-report-provenance$/m);
    expect(front).toMatch(/^started: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
    expect(front).toMatch(/^updated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
    const current = section(text, "Current Test");
    expect(current).toMatch(/number: 1\b/);
    expect(current).toMatch(/awaiting: user response/);
  });

  it("lists the 07-NN summaries it is built from, and each one exists", () => {
    const source = /^source: \[(.*)\]$/m.exec(front)?.[1] ?? "";
    const names = source
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    expect(names.length).toBeGreaterThan(0);
    for (let plan = 1; plan <= 17; plan += 1) {
      expect(names, `07-${String(plan).padStart(2, "0")}`).toContain(
        `07-${String(plan).padStart(2, "0")}-SUMMARY.md`,
      );
    }
    for (const name of names) {
      expect(name, name).toMatch(/^07-[A-Za-z0-9]+-SUMMARY\.md$/);
      expect(existsSync(join(dir as string, name)), name).toBe(true);
    }
  });

  it("numbers 24 tests consecutively, each with an expected block and exactly one pending result", () => {
    expect(tests.map((test) => test.number)).toEqual(
      Array.from({ length: TOTAL }, (_, i) => i + 1),
    );
    for (const test of tests) {
      expect(test.title.length, `test ${test.number}`).toBeGreaterThan(3);
      expect(test.body, `test ${test.number}`).toMatch(/^expected: /m);
      const results = test.body.match(/^result: .*$/gm) ?? [];
      expect(results, `test ${test.number}`).toEqual(["result: [pending]"]);
    }
  });

  it("holds no result value but pending, no automated result and no owner note (D-46)", () => {
    const results = text.match(/^\s*result:.*$/gm) ?? [];
    expect(results.length).toBe(TOTAL);
    for (const line of results) expect(line.trim()).toBe("result: [pending]");
    // The runner writes auto-result lines at the merge gate; an agent never does.
    expect(text).not.toMatch(/^auto-result:/m);
    expect(text).not.toMatch(/^(reported|severity|reason|blocked_by):/m);
  });

  it("keeps the Summary counts consistent with the results", () => {
    const summary = section(text, "Summary");
    expect(summary).toMatch(new RegExp(`^total: ${TOTAL}$`, "m"));
    const count = (key: string) => Number(new RegExp(`^${key}: (\\d+)$`, "m").exec(summary)?.[1]);
    const keys = ["passed", "issues", "pending", "skipped", "blocked"];
    for (const key of keys) expect(Number.isInteger(count(key)), key).toBe(true);
    expect(keys.reduce((sum, key) => sum + count(key), 0)).toBe(TOTAL);
    expect(count("pending")).toBe(TOTAL);
    expect(count("auto-passed")).toBe(0);
    expect(count("auto-failed")).toBe(0);
    expect(count("owner-pending")).toBe(3);
  });
});

run("tags (Test 3)", () => {
  const tests = parseTests(text);
  const classes = vocabulary("RUN_CLASSES");
  const viaTokens = vocabulary("VIA_TOKENS");
  const ownerWhy = vocabulary("OWNER_WHY");

  it("reads the runner's vocabulary", () => {
    expect(classes).toEqual(["auto", "auto+look", "owner"]);
    expect(viaTokens.length).toBeGreaterThan(5);
    expect(ownerWhy).toContain("real-session");
  });

  it("tags every item with a run class, and the right extra tags for its class", () => {
    for (const test of tests) {
      const runClass = test.tags.get("run");
      expect(classes, `item ${test.number} run`).toContain(runClass);
      if (runClass === "owner") {
        expect(ownerWhy, `item ${test.number} owner-why`).toContain(test.tags.get("owner-why"));
        expect(test.tags.has("via"), `item ${test.number} via`).toBe(false);
      } else {
        const via = (test.tags.get("via") ?? "").split(",").map((token) => token.trim());
        expect(via.length, `item ${test.number} via`).toBeGreaterThan(0);
        for (const token of via) expect(viaTokens, `item ${test.number} via`).toContain(token);
        expect(test.tags.has("owner-why"), `item ${test.number} owner-why`).toBe(false);
      }
    }
  });

  it("points every spec tag at a real file that holds the item's own title prefix", () => {
    for (const test of tests) {
      const runClass = test.tags.get("run");
      const spec = test.tags.get("spec");
      const prefix = `[07-UAT#${String(test.number).padStart(2, "0")}]`;
      if (spec === undefined) {
        // Only the decision item has no spec at all.
        expect(runClass, `item ${test.number}`).toBe("owner");
        expect(test.tags.get("owner-why"), `item ${test.number}`).toBe("decision");
        continue;
      }
      const match =
        /^(packages\/e2e\/specs\/[a-z0-9][a-z0-9-]*\.e2e\.ts)::(\[07-UAT#\d{2}\])$/.exec(spec);
      expect(match, `item ${test.number} spec`).not.toBeNull();
      expect(match?.[2], `item ${test.number} prefix`).toBe(prefix);
      const file = join(REPO_ROOT, match?.[1] as string);
      expect(existsSync(file), `item ${test.number} ${match?.[1]}`).toBe(true);
      expect(readFileSync(file, "utf8"), `item ${test.number} title`).toContain(prefix);
    }
  });

  it("has 19 auto, 2 auto+look and 3 owner items, and the Tally line says so", () => {
    const count = (name: string) => tests.filter((test) => test.tags.get("run") === name).length;
    expect(count("auto")).toBe(19);
    expect(count("auto+look")).toBe(2);
    expect(count("owner")).toBe(3);
    expect(text).toMatch(/^Tally by tag: auto 19 · auto\+look 2 · owner 3 · total 24$/m);
    expect(
      tests.filter((test) => test.tags.get("run") === "auto+look").map((t) => t.number),
    ).toEqual([15, 16]);
    expect(tests.filter((test) => test.tags.get("run") === "owner").map((t) => t.number)).toEqual([
      22, 23, 24,
    ]);
  });
});

run("coverage (Test 4)", () => {
  const tests = parseTests(text);

  it("cites every phase requirement in some expected block", () => {
    const ids = [
      ...Array.from({ length: 10 }, (_, i) => `RSRCH-${String(i + 1).padStart(2, "0")}`),
      "ADR-09",
      "DIAG-05",
    ];
    for (const id of ids) {
      const cited = tests.filter((test) => (test.body.split(/^expected: /m)[1] ?? "").includes(id));
      expect(cited.length, id).toBeGreaterThan(0);
    }
  });

  it("involves the live summariser in exactly one item, the owner's item 22", () => {
    const live = tests.filter(
      (test) =>
        /\blive (summariser|sources)\b/i.test(test.title) ||
        /Anthropic (API key|console)/.test(test.body),
    );
    expect(live.map((test) => test.number)).toEqual([22]);
    expect(live[0]?.tags.get("run")).toBe("owner");
    expect(live[0]?.tags.get("owner-why")).toBe("real-session");
  });

  it("quotes product text that the merged copy modules still hold", () => {
    const sources = [
      join("packages", "plugin", "src", "view", "research-copy.ts"),
      join("packages", "vault-repo", "src", "source-note.ts"),
      join("packages", "domain", "src", "research.ts"),
      join("packages", "domain", "src", "session.ts"),
    ]
      .map((file) => readFileSync(join(REPO_ROOT, file), "utf8"))
      .join("\n")
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    // [item number, a phrase the item quotes verbatim].
    const anchors: [number, string][] = [
      [1, "Press Run now to fetch the configured sources and write your first cited report."],
      [2, "Starting a research run…"],
      [2, "Research run started."],
      [4, "Untrusted source content — data, not instructions."],
      [6, "Didn't respond in time"],
      [6, "were unavailable."],
      [7, "no source could be fetched"],
      [8, "The summariser isn't set up"],
      [11, "A run is already in progress. Showing it here."],
      [12, "Unknown run"],
      [12, "Unknown — ended without reporting"],
      [14, "The companion service isn't running."],
      [22, "The saved quote couldn't be checked against its source, so it isn't shown."],
    ];
    for (const [number, phrase] of anchors) {
      const item = tests.find((test) => test.number === number);
      expect(item?.body, `item ${number}: ${phrase}`).toContain(phrase);
      expect(sources, `copy source: ${phrase}`).toContain(phrase);
    }
  });
});

run("setup and safety (Test 5)", () => {
  const setup = section(text, "Setup");
  const teardown = section(text, "Teardown");

  it("states the stance in the first paragraph", () => {
    const intro = text.slice(text.indexOf("# Phase 7")).split("\n\n").slice(0, 3).join("\n\n");
    expect(intro).toMatch(/Agents\s+never\s+mark/);
    expect(intro).toMatch(/real\s+operational\s+store/);
  });

  it("sets up its own runtime directory, throwaway vault, socket override and key script", () => {
    expect(setup).toContain("/Users/USERNAME/");
    expect(setup).toMatch(/CCC_RUNTIME_DIR=\/Users\/USERNAME\/\.ccc-uat-phase7\b/);
    expect(setup).toMatch(/chmod 700 \/Users\/USERNAME\/\.ccc-uat-phase7\b/);
    for (const name of [
      "socketPathOverride",
      "Set up managed vault",
      "scripts/research-key-setup.mjs",
      "--check",
      "pnpm run dev:service",
      "ccc-uat-phase7-vault",
    ]) {
      expect(setup, name).toContain(name);
    }
  });

  it("starts the foreground service with the real transport: no test override variable at all", () => {
    for (const line of text.split("\n")) {
      if (!/pnpm run dev:service/.test(line)) continue;
      expect(line, line).not.toMatch(/CCC_ENABLE_TEST_OVERRIDES|CCC_RESEARCH_|CCC_APPROVAL_/);
      expect(line, line).toMatch(/CCC_RUNTIME_DIR=\/Users\/USERNAME\//);
    }
    // No command in the script sets a test-only variable of any phase.
    expect(text).not.toMatch(/^\s*`?(export )?CCC_(ENABLE_TEST_OVERRIDES|RESEARCH_|APPROVAL_)/m);
    expect(text).not.toMatch(/(CCC_ENABLE_TEST_OVERRIDES|CCC_RESEARCH_\w+)=/);
  });

  it("reads the key from standard input only and never puts a key on a command line", () => {
    expect(setup).toMatch(/standard input/);
    for (const line of text.split("\n")) {
      if (!/research-key-setup/.test(line)) continue;
      expect(line, line).not.toMatch(/sk-|--key\b|ANTHROPIC_API_KEY=|echo /);
    }
    expect(text).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it("restores the launchd service from the main checkout and removes what the run created", () => {
    for (const name of [
      "pnpm run service:install",
      "rm -rf /Users/USERNAME/.ccc-uat-phase7",
      "ccc-uat-phase7-vault",
      "socketPathOverride",
      "Ctrl-C",
    ]) {
      expect(teardown, name).toContain(name);
    }
    expect(teardown).toMatch(/cd \/Users\/USERNAME\/ClaudeOS && pnpm run service:install/);
  });

  it("reads the operational store only from a read-only copy", () => {
    expect(text).toMatch(/cp \/Users\/USERNAME\/\.ccc-uat-phase7\/operational\.db /);
    let reads = 0;
    for (const line of text.split("\n")) {
      if (!/sqlite3/.test(line)) continue;
      reads += 1;
      expect(line, line).toMatch(/-readonly/);
      expect(line, line).toMatch(/operational-copy\.db/);
      expect(line, line).not.toMatch(/operational\.db(?!-)/);
    }
    expect(reads).toBeGreaterThan(0);
    expect(text).not.toMatch(/sqlite3 [^\n]*\/operational\.db(?!-)/);
  });

  it("writes every home path with the USERNAME placeholder and no temporary-folder path", () => {
    for (const match of text.matchAll(/\/Users\/([^/\s`"')]+)/g)) {
      expect(match[1], match[0]).toBe("USERNAME");
    }
    expect(text).not.toMatch(/\/(private|var)\/(tmp|folders)\b/);
    expect(text).not.toMatch(/~\/(Obsidian|\.claude-command-center)/);
    for (const line of text.split("\n")) {
      // Nothing in the script points at the owner's real operational folder or vault.
      expect(line, line).not.toMatch(/\.claude-command-center/);
    }
  });

  it("holds no email address, key-shaped string or hash", () => {
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(text).not.toMatch(/\b(sk-|ghp_|gho_|xox[bap]-|AKIA)[A-Za-z0-9_-]{8,}/);
    expect(text).not.toMatch(/\b[0-9a-f]{40,}\b/);
  });

  it("names only pnpm scripts, repository scripts and flags that exist", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    let checked = 0;
    for (const match of text.matchAll(/pnpm run ([a-z][a-z0-9:-]*)/g)) {
      expect(pkg.scripts[match[1] as string], match[0]).toBeDefined();
      checked += 1;
    }
    expect(checked).toBeGreaterThan(2);
    for (const match of text.matchAll(/\bscripts\/[A-Za-z0-9_./-]+\.(?:sh|mjs)\b/g)) {
      expect(existsSync(join(REPO_ROOT, match[0])), match[0]).toBe(true);
    }
    // The key script prints its flags in --help; the script quotes only those.
    const keyScript = readFileSync(join(REPO_ROOT, "scripts", "research-key-setup.mjs"), "utf8");
    for (const line of text.split("\n")) {
      if (!line.includes("research-key-setup.mjs")) continue;
      for (const flag of line.match(/--[a-z][a-z-]*/g) ?? [])
        expect(keyScript, flag).toContain(flag);
    }
  });
});
