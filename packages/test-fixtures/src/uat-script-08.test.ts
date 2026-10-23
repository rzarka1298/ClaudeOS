import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./gate-repo.js";
import { recordedStateProblems } from "./uat-script-state.js";

/**
 * Plan 08-23 Task 1 (T-08-55, D-26, D-46): keeps the Phase 8 live-Obsidian script honest. It reads
 * 08-UAT.md, checks its structure, tags, requirement coverage and safety stance, and proves every
 * command, script, spec title and product string it quotes still exists. The script is a private
 * planning artifact: a public clone has no `.planning/` and reports that once.
 *
 * The tag vocabulary is read from the runner's own source (`packages/e2e/src/uat-tags.ts`) so the
 * two cannot drift; test-fixtures may not import the e2e package (it is a leaf), so the arrays are
 * read as text. `spec-map-08.test.ts` in the e2e package compares the same tags with the runner's
 * item plan.
 */

const PLANNING_INDEX = join(REPO_ROOT, ".planning", "ROADMAP.md");
const PHASES = join(REPO_ROOT, ".planning", "phases");
const planned = existsSync(PLANNING_INDEX);

function phaseDir(): string | undefined {
  if (!existsSync(PHASES)) return undefined;
  const name = readdirSync(PHASES).find((entry) => entry.startsWith("08-"));
  return name === undefined ? undefined : join(PHASES, name);
}

const dir = phaseDir();
const scriptPath = dir === undefined ? "" : join(dir, "08-UAT.md");
const text = planned && existsSync(scriptPath) ? readFileSync(scriptPath, "utf8") : "";

interface UatTest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly expected: string;
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
      expected: (body.split(/^expected: \|?/m)[1] ?? "").split(/^result: /m)[0] as string,
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

const flat = (value: string): string => value.replace(/\s+/g, " ");

const run = planned ? describe : describe.skip;
const TOTAL = 39;
const AUTO_LOOK = [17];
const OWNER = [34, 35, 36, 37, 38, 39];

describe("guard (Test 1)", () => {
  it("finds the phase directory and the script whenever the planning index exists", () => {
    if (!planned) {
      // A public clone has no .planning/: the script is not available here.
      expect(existsSync(PLANNING_INDEX)).toBe(false);
      return;
    }
    expect(dir, "the phase directory").toBeDefined();
    expect(existsSync(scriptPath), "08-UAT.md").toBe(true);
  });
});

run("front matter and results (Test 2)", () => {
  const tests = parseTests(text);
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  // Agents ship the script with every result pending (status: testing). The merge gate adds the
  // runner's auto-result lines and the ratified passes; only the owner's sitting, recorded by the
  // orchestrator, moves it to complete (uat-script-state.ts holds the rules).
  const complete = /^status: complete$/m.test(front);
  const untouched = !complete && !/^auto-result:/m.test(text);

  it("has the GSD front matter, the phase name and a Current Test block", () => {
    expect(front).toMatch(/^status: (testing|complete)$/m);
    expect(front).toMatch(/^phase: 08-slice-proof-settings-health$/m);
    expect(front).toMatch(/^started: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
    expect(front).toMatch(/^updated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
    const current = section(text, "Current Test");
    if (complete) {
      expect(current).toMatch(/\[testing complete\]/);
    } else {
      expect(current).toMatch(/number: 1\b/);
      expect(current).toMatch(/awaiting: user response/);
    }
  });

  it("lists the 08-NN summaries it is built from, and each one exists", () => {
    const source = /^source: \[(.*)\]$/m.exec(front)?.[1] ?? "";
    const names = source
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    expect(names.length).toBeGreaterThan(0);
    for (let plan = 1; plan <= 22; plan += 1) {
      const name = `08-${String(plan).padStart(2, "0")}-SUMMARY.md`;
      expect(names, name).toContain(name);
    }
    for (const name of names) {
      expect(name, name).toMatch(/^08-[A-Za-z0-9]+-SUMMARY\.md$/);
      expect(existsSync(join(dir as string, name)), name).toBe(true);
    }
  });

  it("numbers 39 tests consecutively, each with an expected block and exactly one result", () => {
    expect(tests.map((test) => test.number)).toEqual(
      Array.from({ length: TOTAL }, (_, i) => i + 1),
    );
    for (const test of tests) {
      expect(test.title.length, `test ${test.number}`).toBeGreaterThan(3);
      expect(test.body, `test ${test.number}`).toMatch(/^expected: /m);
      expect(test.expected.trim().length, `test ${test.number} expected`).toBeGreaterThan(40);
      const results = test.body.match(/^result: .*$/gm) ?? [];
      expect(results.length, `test ${test.number}`).toBe(1);
      if (untouched) expect(results[0], `test ${test.number}`).toBe("result: [pending]");
    }
  });

  it("holds no result value but pending, no automated result and no owner note (D-46)", () => {
    const results = text.match(/^\s*result:.*$/gm) ?? [];
    expect(results.length).toBe(TOTAL);
    // The script as agents ship it: nothing recorded at all. Once the runner has written its
    // auto-result lines, the next test takes over.
    if (untouched) {
      for (const line of results) expect(line.trim()).toBe("result: [pending]");
      expect(text).not.toMatch(/^(reported|severity|reason|blocked_by):/m);
    }
  });

  it("records only what the merge gate may record: the runner's lines, ratified passes, then the owner's results (D-46)", () => {
    expect(recordedStateProblems(text, { total: TOTAL, ownerItems: OWNER })).toEqual([]);
  });

  it("keeps the Summary counts consistent with the results (the audit reads total:)", () => {
    const summary = section(text, "Summary");
    expect(summary).toMatch(new RegExp(`^total: ${TOTAL}$`, "m"));
    const count = (key: string) => Number(new RegExp(`^${key}: (\\d+)$`, "m").exec(summary)?.[1]);
    const keys = ["passed", "issues", "pending", "skipped", "blocked"];
    for (const key of keys) expect(Number.isInteger(count(key)), key).toBe(true);
    expect(keys.reduce((sum, key) => sum + count(key), 0)).toBe(TOTAL);
    if (untouched) {
      expect(count("pending")).toBe(TOTAL);
      expect(count("auto-passed")).toBe(0);
      expect(count("auto-failed")).toBe(0);
      expect(count("owner-pending")).toBe(OWNER.length);
    }
  });

  it("has a Gaps block that records nothing the owner has not said", () => {
    expect(section(text, "Gaps")).toMatch(/\S/);
    if (untouched) expect(section(text, "Gaps")).toMatch(/None recorded yet\./);
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
    expect(ownerWhy).toContain("settings-dialog");
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
        expect(test.tags.has("auto-part"), `item ${test.number} auto-part`).toBe(false);
      }
    }
  });

  it("points every spec tag at a real file that holds the item's own title prefix", () => {
    for (const test of tests) {
      const runClass = test.tags.get("run");
      const spec = test.tags.get("spec");
      const prefix = `[08-UAT#${String(test.number).padStart(2, "0")}]`;
      if (spec === undefined) {
        // Only owner items 37 (real launchd), 38 (real data) and 39 (the verdict) have no spec.
        expect(runClass, `item ${test.number}`).toBe("owner");
        expect([37, 38, 39], `item ${test.number}`).toContain(test.number);
        expect(test.tags.has("auto-part"), `item ${test.number} auto-part`).toBe(false);
        continue;
      }
      const match =
        /^(packages\/e2e\/specs\/[a-z0-9][a-z0-9-]*\.e2e\.ts)::(\[08-UAT#\d{2}\])$/.exec(spec);
      expect(match, `item ${test.number} spec`).not.toBeNull();
      expect(match?.[2], `item ${test.number} prefix`).toBe(prefix);
      const file = join(REPO_ROOT, match?.[1] as string);
      expect(existsSync(file), `item ${test.number} ${match?.[1]}`).toBe(true);
      expect(readFileSync(file, "utf8"), `item ${test.number} title`).toContain(prefix);
      if (runClass === "owner") {
        expect(test.tags.get("auto-part"), `item ${test.number} auto-part`).toBeTruthy();
      }
    }
  });

  it("has 32 auto, 1 auto+look and 6 owner items, and the Tally line says so", () => {
    const count = (name: string) => tests.filter((test) => test.tags.get("run") === name).length;
    expect(count("auto")).toBe(32);
    expect(count("auto+look")).toBe(1);
    expect(count("owner")).toBe(6);
    expect(text).toMatch(/^Tally by tag: auto 32 · auto\+look 1 · owner 6 · total 39$/m);
    expect(
      tests.filter((test) => test.tags.get("run") === "auto+look").map((t) => t.number),
    ).toEqual(AUTO_LOOK);
    expect(tests.filter((test) => test.tags.get("run") === "owner").map((t) => t.number)).toEqual(
      OWNER,
    );
  });

  it("gives the six owner items the reasons the plan names", () => {
    const why = (n: number) => tests.find((test) => test.number === n)?.tags.get("owner-why");
    expect([34, 35].map(why)).toEqual(["settings-dialog", "settings-dialog"]);
    expect([36, 37, 38].map(why)).toEqual(["real-session", "real-session", "real-session"]);
    expect(why(39)).toBe("decision");
  });

  it("points no automated item at the owner's real runtime, store, vault or Keychain (SLICE-02)", () => {
    for (const test of tests.filter((t) => t.tags.get("run") !== "owner")) {
      const where = `item ${test.number}`;
      expect(test.body, where).not.toMatch(/\/Users\//);
      expect(test.body, where).not.toMatch(/(^|[^A-Za-z])\.claude-command-center/);
      expect(test.body, where).not.toMatch(/launchctl|service:install|dev:service/);
      expect(test.body, where).not.toMatch(/\bYour (real|own) (vault|store|key|keychain)/i);
    }
  });
});

run("coverage (Test 4)", () => {
  const tests = parseTests(text);
  const expectedOf = (n: number): string =>
    flat(tests.find((test) => test.number === n)?.expected ?? "");

  it("cites every phase requirement in some expected block", () => {
    for (const id of ["SLICE-01", "SLICE-02", "DIAG-01", "DIAG-02", "DIAG-03", "DIAG-04"]) {
      const cited = tests.filter((test) => test.expected.includes(id));
      expect(cited.length, id).toBeGreaterThan(0);
    }
  });

  it("makes item 38 the slice on real data: a project, a launch, a session, a task and the report", () => {
    const item = expectedOf(38);
    for (const part of [
      /real registered project/,
      /real launch/,
      /real Claude Code session/,
      /real managed task/,
      /real cited report/,
      /Phase 7 item 22/,
      /None of it may be a fixture/,
    ]) {
      expect(item, String(part)).toMatch(part);
    }
    expect(item).toContain("SLICE-01");
    expect(item).toContain("SC1");
  });

  it("makes item 39 the milestone verdict with the exceptions and the decisions", () => {
    const item = expectedOf(39);
    expect(item).toContain("Is this dashboard what you reach for instead of the underlying tools?");
    for (const id of ["OD-7", "OD-8", "OD-1", "OD-6", "SLICE-02", "SC5"]) {
      expect(item, id).toContain(id);
    }
    expect(item).toContain("08-UAT-AUDIT.md");
  });

  it("walks the keychain, launchd and save-sheet checks as owner items, never as automated ones", () => {
    expect(expectedOf(36)).toMatch(/Keychain dialog/);
    expect(expectedOf(37)).toMatch(/launchctl bootout/);
    expect(expectedOf(37)).toMatch(/KeepAlive/);
    expect(expectedOf(35)).toMatch(/save sheet/);
    expect(expectedOf(34)).toMatch(/Reduced motion/);
  });

  it("states the two decided expected texts: item 24's second vault and item 33's closed scope", () => {
    expect(expectedOf(24)).toMatch(/second throwaway vault/);
    expect(expectedOf(24)).toMatch(/never the vault that is open/);
    const thirty = expectedOf(33);
    expect(thirty).not.toMatch(/a path inside the vault is refused/);
    expect(thirty).toMatch(/export\.test\.ts/);
    expect(thirty).toMatch(/item 35/);
  });

  it("aligns the expected texts with the merged specs (08-22 contract note)", () => {
    expect(expectedOf(10)).toContain("Registered {name}.");
    expect(expectedOf(10)).not.toContain("Project registered.");
    expect(expectedOf(11)).toContain("set-up-launchers");
    expect(expectedOf(12)).toContain("…/…");
    expect(expectedOf(12)).toContain("~/…");
    // Item 20 switches analysis off before the delete: with it on the service recounts at once.
    expect(expectedOf(20)).toMatch(/turn Transcript analysis off before/i);
    expect(expectedOf(34)).toMatch(/settingsHost\.settings/);
    expect(expectedOf(17)).toMatch(/\{section\}-\{light\|dark\}/);
    expect(expectedOf(17)).toMatch(/overview-\{light\|dark\}/);
  });

  it("quotes product text that the merged copy modules still hold", () => {
    const roots = ["plugin", "domain", "service"].map((pkg) =>
      join(REPO_ROOT, "packages", pkg, "src"),
    );
    const files: string[] = [];
    const walk = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== "test-support") walk(path);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          files.push(path);
        }
      }
    };
    for (const root of roots) walk(root);
    const sources = files
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    // [item number, a phrase the item quotes verbatim, the phrase as the module writes it].
    const anchors: [number, string, string?][] = [
      [2, "Google Calendar and Gmail: not part of this version."],
      [3, "Nothing is due today."],
      [3, "Next open task"],
      [3, "Most recent open task"],
      [4, "No reports yet"],
      [4, "Open report"],
      [5, "No automation failures."],
      [7, "Service disconnected"],
      [10, "Registered {name}.", "`Registered ${"],
      [14, "No always-allow control exists."],
      [22, "Nothing is failing."],
      [23, "The plugin can't reach the companion service."],
      [23, "Can't be checked while the companion service isn't running."],
      [24, "isn't the one the companion service manages"],
      [24, "Some managed folders are missing"],
      [25, "No event has arrived since the companion service started."],
      [27, "Manual trigger only in this version. Nothing runs on a timer."],
      [28, "The saved app can't be found on this Mac."],
      [30, "Checked just now."],
      [33, "Bundle saved."],
      [35, "A file with that name already exists. Choose a new name. Nothing was written."],
      [35, "That location is inside your vault. Choose a folder outside the vault."],
    ];
    for (const [number, phrase, written] of anchors) {
      expect(expectedOf(number), `item ${number}: ${phrase}`).toContain(phrase);
      expect(sources, `copy source: ${phrase}`).toContain(written ?? phrase);
    }
  });
});

run("setup and safety (Test 5)", () => {
  const setup = section(text, "Setup");
  const teardown = section(text, "Teardown");

  it("states the stance in the first paragraphs", () => {
    const intro = text.slice(text.indexOf("# Phase 8")).split("\n\n").slice(0, 4).join("\n\n");
    expect(intro).toMatch(/Agents\s+never\s+mark/);
    expect(intro).toMatch(/real\s+operational\s+store/);
    expect(intro).toMatch(/OD-6/);
    expect(intro).toMatch(/Phase\s+7\s+items\s+22\s+to\s+24/);
    expect(intro).not.toMatch(/draft/i);
  });

  it("sets up its own runtime directory, throwaway vault, socket override and key script", () => {
    expect(setup).toContain("/Users/USERNAME/");
    expect(setup).toMatch(/CCC_RUNTIME_DIR=\/Users\/USERNAME\/\.ccc-uat-phase8\b/);
    expect(setup).toMatch(/chmod 700 \/Users\/USERNAME\/\.ccc-uat-phase8\b/);
    for (const name of [
      "socketPathOverride",
      "Set up managed vault",
      "scripts/research-key-setup.mjs",
      "--check",
      "pnpm run dev:service",
      "ccc-uat-phase8-vault",
      "cp packages/plugin/main.js",
      "operational-copy.db",
    ]) {
      expect(setup, name).toContain(name);
    }
    expect(setup).not.toMatch(/Plan 08-23 writes/);
  });

  it("shares one environment with Phase 7's owner items instead of a second one (OD-6)", () => {
    expect(setup).toMatch(/Phase 7 items 22 to 24/);
    expect(setup).toMatch(/ccc-uat-phase7/);
    expect(setup).toMatch(/Phase 7 item 22[^.]*first/);
  });

  it("starts the foreground service with the real transport: no test override variable at all", () => {
    let seen = 0;
    for (const line of text.split("\n")) {
      if (!/pnpm run dev:service/.test(line)) continue;
      seen += 1;
      expect(line, line).not.toMatch(
        /CCC_ENABLE_TEST_OVERRIDES|CCC_RESEARCH_|CCC_APPROVAL_|CCC_CODEX_/,
      );
      expect(line, line).toMatch(/CCC_RUNTIME_DIR=\/Users\/USERNAME\//);
    }
    expect(seen).toBeGreaterThan(0);
    // No command in the script sets a test-only variable of any phase.
    expect(text).not.toMatch(
      /(CCC_ENABLE_TEST_OVERRIDES|CCC_RESEARCH_\w+|CCC_CODEX_\w+|CCC_CLAUDE_\w+)=/,
    );
    expect(text).not.toMatch(
      /^\s*`?(export )?CCC_(ENABLE_TEST_OVERRIDES|RESEARCH_|APPROVAL_|CODEX_)/m,
    );
  });

  it("reads the key from standard input only and never puts a key on a command line", () => {
    expect(setup).toMatch(/standard input/);
    for (const line of text.split("\n")) {
      if (!/research-key-setup/.test(line)) continue;
      expect(line, line).not.toMatch(/sk-|--key\b|ANTHROPIC_API_KEY=|echo /);
    }
    expect(text).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it("installs Claude Code hooks only through the owner-run script, into the sitting's runtime, and removes them", () => {
    for (const name of [
      "scripts/claude-hooks/install.sh",
      "--dry-run",
      "--runtime-dir /Users/USERNAME/.ccc-uat-phase8",
      "scripts/claude-hooks/status.sh",
    ]) {
      expect(setup, name).toContain(name);
    }
    expect(teardown).toContain(
      "scripts/claude-hooks/uninstall.sh --runtime-dir /Users/USERNAME/.ccc-uat-phase8",
    );
    // The app never installs hooks (D-08); the owner runs the script for item 38 only.
    expect(setup).toMatch(/item 38 only/);
    // The hooks come out before the runtime folder they point at is removed.
    expect(teardown.indexOf("claude-hooks/uninstall.sh")).toBeLessThan(teardown.indexOf("rm -rf"));
  });

  it("restores the launchd service from the main checkout and removes what the run created", () => {
    for (const name of [
      "pnpm run service:install",
      "rm -rf /Users/USERNAME/.ccc-uat-phase8",
      "ccc-uat-phase8-vault",
      "socketPathOverride",
      "Ctrl-C",
    ]) {
      expect(teardown, name).toContain(name);
    }
    expect(teardown).toMatch(/cd \/Users\/USERNAME\/ClaudeOS && pnpm run service:install/);
    // Item 37 is walked against the restored service, so the restore comes before it.
    const item37 = flat(parseTests(text).find((test) => test.number === 37)?.expected ?? "");
    expect(item37).toMatch(/Teardown steps? 1/);
  });

  it("reads the operational store only from a read-only copy", () => {
    expect(text).toMatch(/cp \/Users\/USERNAME\/\.ccc-uat-phase8\/operational\.db /);
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
      // The Keychain service name `com.claude-command-center` and the launchd label are fine; the
      // runtime folder is not.
      expect(line, line).not.toMatch(/(^|[^A-Za-z.-])\.claude-command-center/);
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
    expect(checked).toBeGreaterThanOrEqual(3);
    const turbo = JSON.parse(readFileSync(join(REPO_ROOT, "turbo.json"), "utf8")) as {
      tasks: Record<string, unknown>;
    };
    for (const match of text.matchAll(/turbo run ([a-z:]+)/g)) {
      expect(turbo.tasks[match[1] as string], match[0]).toBeDefined();
    }
    for (const match of text.matchAll(/\bscripts\/[A-Za-z0-9_./-]+\.(?:sh|mjs)\b/g)) {
      expect(existsSync(join(REPO_ROOT, match[0])), match[0]).toBe(true);
    }
    // Each owner script prints or documents its flags; the script quotes only those.
    const keyScript = readFileSync(join(REPO_ROOT, "scripts", "research-key-setup.mjs"), "utf8");
    for (const line of text.split("\n")) {
      if (line.includes("research-key-setup.mjs")) {
        for (const flag of line.match(/--[a-z][a-z-]*/g) ?? [])
          expect(keyScript, flag).toContain(flag);
      }
      const hook = /scripts\/claude-hooks\/(install|status|uninstall)\.sh/.exec(line);
      if (hook !== null) {
        const source = readFileSync(
          join(REPO_ROOT, "scripts", "claude-hooks", `${hook[1]}.mjs`),
          "utf8",
        );
        for (const flag of line.match(/--[a-z][a-z-]*/g) ?? [])
          expect(source, `${hook[1]} ${flag}`).toContain(flag);
      }
    }
    // The launchd label the item quotes is the one the install script registers.
    const installer = readFileSync(join(REPO_ROOT, "scripts", "launchagent", "install.sh"), "utf8");
    const label = /LABEL="([^"]+)"/.exec(installer)?.[1] as string;
    expect(label).toBeTruthy();
    for (const line of text.split("\n")) {
      if (/launchctl/.test(line) && /gui\//.test(line)) expect(line, line).toContain(label);
    }
  });
});
