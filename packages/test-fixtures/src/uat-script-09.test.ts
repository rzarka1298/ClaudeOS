import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./gate-repo.js";

/**
 * Plan 09-23 Task 1 (T-09-48, D-17, D-26): keeps the Phase 9 live-Obsidian script honest. It reads
 * 09-UAT.md, checks its structure, tags, requirement coverage and safety stance, and proves every
 * command, script, spec title and product string it quotes still exists. The script is a private
 * planning artifact: a public clone has no `.planning/` and reports that once.
 *
 * The script as shipped holds 19 items, not the 10 the plan was written for: 8 automated (1 to 8) and
 * 11 owner items (9 to 19). Items 9 and 10 are the two D-17 owner items; items 11 to 19 are the
 * owner-only checks the wave reviews recorded (09-WAVE-REVIEWS.md). The tag vocabulary is read from
 * the runner's own source (`packages/e2e/src/uat-tags.ts`) so the two cannot drift; test-fixtures may
 * not import the e2e package (it is a leaf), so the arrays are read as text. `spec-map-09.test.ts` in
 * the e2e package compares the same tags with the runner's item plan.
 */

const PLANNING_INDEX = join(REPO_ROOT, ".planning", "ROADMAP.md");
const PHASES = join(REPO_ROOT, ".planning", "phases");
const planned = existsSync(PLANNING_INDEX);

function phaseDir(): string | undefined {
  if (!existsSync(PHASES)) return undefined;
  const name = readdirSync(PHASES).find((entry) => entry.startsWith("09-"));
  return name === undefined ? undefined : join(PHASES, name);
}

const dir = phaseDir();
const scriptPath = dir === undefined ? "" : join(dir, "09-UAT.md");
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
const TOTAL = 19;
const AUTO = [1, 2, 3, 4, 5, 6, 7, 8];
const OWNER = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
const REQUIREMENTS = ["SESS-06", "SESS-19", "APPR-11", "APPR-12", "SVC-12", "DIAG-06"];

describe("guard (Test 1)", () => {
  it("finds the phase directory and the script whenever the planning index exists", () => {
    if (!planned) {
      // A public clone has no .planning/: the script is not available here.
      expect(existsSync(PLANNING_INDEX)).toBe(false);
      return;
    }
    expect(dir, "the phase directory").toBeDefined();
    expect(existsSync(scriptPath), "09-UAT.md").toBe(true);
  });
});

run("front matter and results (Test 2)", () => {
  const tests = parseTests(text);
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  // Agents ship the script with every result pending (status: testing). The merge gate adds the
  // runner's auto-result lines and the ratified passes; the owner's sitting, recorded by the
  // orchestrator as stated, moves it to complete.
  const complete = /^status: complete$/m.test(front);
  const untouched = !complete && !/^auto-result:/m.test(text);

  it("has the GSD front matter, the phase name and a Current Test block", () => {
    expect(front).toMatch(/^status: (testing|complete)$/m);
    expect(front).toMatch(/^phase: 09-hardening-honest-session-state-and-trustworthy-approvals$/m);
    expect(front).toMatch(/^started: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
    expect(front).toMatch(/^updated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
    const current = section(text, "Current Test");
    expect(current).toMatch(complete ? /\[testing complete\]/ : /\[testing not started\]/);
  });

  it("lists the 09-NN summaries it is built from, and each one exists", () => {
    const source = /^source: \[(.*)\]$/m.exec(front)?.[1] ?? "";
    const names = source
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    expect(names.length).toBeGreaterThan(0);
    // 09-23 is the plan that finalises this script: its own summary is written after it.
    for (let plan = 1; plan <= 22; plan += 1) {
      const name = `09-${String(plan).padStart(2, "0")}-SUMMARY.md`;
      expect(names, name).toContain(name);
    }
    for (const name of names) {
      expect(name, name).toMatch(/^09-[A-Za-z0-9]+-SUMMARY\.md$/);
      expect(existsSync(join(dir as string, name)), name).toBe(true);
    }
  });

  it("numbers 19 tests consecutively, each with an expected block and exactly one result", () => {
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

  it("holds no result value but pending, no automated result and no owner note (D-26)", () => {
    const results = text.match(/^\s*result:.*$/gm) ?? [];
    expect(results.length).toBe(TOTAL);
    if (untouched) {
      for (const line of results) expect(line.trim()).toBe("result: [pending]");
      expect(text).not.toMatch(/^(reported|severity|reason|blocked_by):/m);
    }
  });

  it("records only what the merge gate may record: the runner's lines, ratified passes, then the owner's results", () => {
    const autoForm =
      /^(pass|fail|inconclusive|inconclusive \(look pending\)) @ ([0-9a-f]{8}) \d{4}-\d{2}-\d{2}$/;
    const ratifiedForm = /^pass - auto run ([0-9a-f]{8})$/;
    const ownerForm = /^(pass|fail|accepted) — \S/;
    for (const test of tests) {
      const where = `item ${test.number}`;
      const owner = OWNER.includes(test.number);
      const result = (/^result: (.*)$/m.exec(test.body)?.[1] ?? "").trim();
      const autos = test.body.match(/^auto-result: (.*)$/gm) ?? [];
      expect(autos.length, `${where} auto-result lines`).toBeLessThanOrEqual(1);
      if (owner) expect(autos, `${where}: an owner item never carries an auto-result`).toEqual([]);
      for (const line of autos) {
        expect(autoForm.test(line.replace(/^auto-result: /, "")), `${where} auto-result form`).toBe(
          true,
        );
      }
      if (result === "[pending]") continue;
      if (owner) {
        expect(ownerForm.test(result), `${where} owner result form`).toBe(true);
        // The owner's results are recorded only once the owner has sat (D-26): a partly recorded
        // owner item with a testing status is the orchestrator recording as stated.
      } else {
        expect(
          ratifiedForm.test(result) || ownerForm.test(result),
          `${where} ratified result form`,
        ).toBe(true);
      }
    }
    if (complete) {
      expect(
        tests.filter((test) => /^result: \[pending\]$/m.test(test.body)).length,
        "a complete script has nothing pending",
      ).toBe(0);
    }
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

  it("has no Gaps block that records anything the owner has not said", () => {
    // 09-UAT.md has no Gaps block until the owner's sitting records one; nothing may be pre-filled.
    const gaps = section(text, "Gaps");
    if (untouched) expect(gaps).toBe("");
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
    expect(ownerWhy).toContain("decision");
  });

  it("tags every item with a run class, and the right extra tags for its class", () => {
    for (const test of tests) {
      const runClass = test.tags.get("run");
      expect(classes, `item ${test.number} run`).toContain(runClass);
      if (runClass === "owner") {
        expect(ownerWhy, `item ${test.number} owner-why`).toContain(test.tags.get("owner-why"));
        expect(test.tags.has("via"), `item ${test.number} via`).toBe(false);
        expect(test.tags.has("spec"), `item ${test.number} spec`).toBe(false);
      } else {
        const via = (test.tags.get("via") ?? "").split(",").map((token) => token.trim());
        expect(via.length, `item ${test.number} via`).toBeGreaterThan(0);
        for (const token of via) expect(viaTokens, `item ${test.number} via`).toContain(token);
        expect(test.tags.has("owner-why"), `item ${test.number} owner-why`).toBe(false);
      }
    }
  });

  it("points every automated item's spec tag at a real file that holds the item's own title", () => {
    for (const test of tests.filter((t) => t.tags.get("run") !== "owner")) {
      const spec = test.tags.get("spec");
      const prefix = `[09-UAT#${String(test.number).padStart(2, "0")}]`;
      const match =
        /^(packages\/e2e\/specs\/[a-z0-9][a-z0-9-]*\.e2e\.ts)::(\[09-UAT#\d{2}\])$/.exec(
          spec ?? "",
        );
      expect(match, `item ${test.number} spec`).not.toBeNull();
      expect(match?.[2], `item ${test.number} prefix`).toBe(prefix);
      const file = join(REPO_ROOT, match?.[1] as string);
      expect(existsSync(file), `item ${test.number} ${match?.[1]}`).toBe(true);
      const source = readFileSync(file, "utf8");
      expect(source, `item ${test.number} title prefix`).toContain(prefix);
      // The case title is the prefix, a space and the item's own title, so a rename on either
      // side fails here (the runner matches on the prefix; a person reads the title).
      expect(source, `item ${test.number} title`).toContain(`${prefix} ${test.title}`);
    }
  });

  it("has 8 auto and 11 owner items, and the Tally line says so", () => {
    const count = (name: string) => tests.filter((test) => test.tags.get("run") === name).length;
    expect(count("auto")).toBe(8);
    expect(count("auto+look")).toBe(0);
    expect(count("owner")).toBe(11);
    expect(text).toMatch(/^Tally by tag: auto 8 · auto\+look 0 · owner 11 · total 19$/m);
    expect(tests.filter((test) => test.tags.get("run") === "auto").map((t) => t.number)).toEqual(
      AUTO,
    );
    expect(tests.filter((test) => test.tags.get("run") === "owner").map((t) => t.number)).toEqual(
      OWNER,
    );
  });

  it("gives the owner items their reasons: real session throughout, and a decision at item 18", () => {
    const why = (n: number) => tests.find((test) => test.number === n)?.tags.get("owner-why");
    for (const n of OWNER.filter((item) => item !== 18))
      expect(why(n), `item ${n}`).toBe("real-session");
    expect(why(18)).toBe("decision");
  });

  it("points no automated item at the owner's real runtime, store, vault, Keychain, helper or launchd (T-09-46)", () => {
    for (const test of tests.filter((t) => t.tags.get("run") !== "owner")) {
      const where = `item ${test.number}`;
      // Item 4 names the string "/Users/" it expects to be absent; a path under it is the leak.
      expect(test.body, where).not.toMatch(/\/Users\/[A-Za-z]/);
      expect(test.body, where).not.toMatch(/(^|[^A-Za-z])\.claude-command-center/);
      expect(test.body, where).not.toMatch(
        /launchctl|service:install|service:uninstall|dev:service/,
      );
      expect(test.body, where).not.toMatch(/\bYour (real|own) (vault|store|key|keychain)/i);
      expect(test.body, where).not.toMatch(/security (find|add|delete)-|ccc-presence|try-prompt/);
    }
  });
});

run("coverage (Test 4)", () => {
  const tests = parseTests(text);
  const expectedOf = (n: number): string =>
    flat(tests.find((test) => test.number === n)?.expected ?? "");

  it("cites every phase requirement in some expected block", () => {
    for (const id of REQUIREMENTS) {
      const cited = tests.filter((test) => test.expected.includes(id));
      expect(cited.length, id).toBeGreaterThan(0);
    }
  });

  it("walks the real helper, the real LaunchAgent and the real Keychain as owner items, never automated ones", () => {
    expect(expectedOf(9)).toContain("node scripts/presence/try-prompt.mjs");
    expect(expectedOf(9)).toMatch(/last line printed is `verified`/);
    expect(expectedOf(9)).toMatch(/last line is `refused`/);
    expect(expectedOf(10)).toContain("pnpm run service:install");
    expect(expectedOf(10)).toMatch(/three times in a row/);
    expect(expectedOf(10)).toContain("Bootstrap failed: 5");
    expect(expectedOf(10)).toContain("launchctl list | grep -c com.claude-command-center.service");
    expect(expectedOf(11)).toMatch(/Cancel/);
    expect(expectedOf(12)).toContain("sh scripts/presence/test-custody.sh");
    expect(expectedOf(13)).toContain("pnpm run presence:build");
    expect(expectedOf(14)).toContain("presence-pin-adopted");
    expect(expectedOf(15)).toContain("presence-pin-changed");
    expect(expectedOf(16)).toContain("launchctl bootout");
    expect(expectedOf(17)).toMatch(/accepted — not walked/);
    expect(expectedOf(18)).toContain("attr_delete_prompts");
    expect(expectedOf(18)).toContain("verdict_sc2");
    expect(expectedOf(19)).toContain("list-keychains");
  });

  it("makes item 18 the measurement that decides verdict_sc2, with the nonce the spike record holds", () => {
    const spike = readFileSync(join(dir as string, "09-PRESENCE-SPIKE.md"), "utf8");
    const nonce = /^nonce: ([0-9a-f]+)$/m.exec(spike)?.[1];
    expect(nonce, "nonce line in 09-PRESENCE-SPIKE.md").toBeDefined();
    expect(expectedOf(18)).toContain(`NONCE=${nonce}`);
    expect(spike).toMatch(/^verdict_sc2: (met|partially-met)$/m);
    expect(expectedOf(18)).toMatch(/partially-met to met/);
    expect(expectedOf(18)).toMatch(/throwaway spike item, never your real pin/);
  });

  it("states the automated items' decided expected texts", () => {
    expect(expectedOf(1)).toContain("sandbox `quiet` kind");
    expect(expectedOf(1)).toContain("1 quiet");
    expect(expectedOf(3)).toMatch(/600 pixels high/);
    expect(expectedOf(3)).toMatch(/clipboard is a spy/);
    expect(expectedOf(4)).toMatch(/no "\/Users\/"/);
    expect(expectedOf(5)).toMatch(/the run folder holds no presence helper at all/);
    expect(expectedOf(6)).toMatch(/no prompt was involved/);
    expect(expectedOf(8)).toMatch(/exactly one readable report/);
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
    const scriptFiles = ["scripts/launchagent/install.sh", "scripts/launchagent/uninstall.sh"];
    const sources = [
      ...files.map((file) => readFileSync(file, "utf8")),
      ...scriptFiles.map((file) => readFileSync(join(REPO_ROOT, file), "utf8")),
    ]
      .join("\n")
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    // [item number, a phrase the item quotes verbatim, the phrase as the module writes it].
    const anchors: [number, string, string?][] = [
      [1, "Idle — last event"],
      [2, "No events for"],
      [3, "Bundle copied."],
      [4, "Disconnected —"],
      [5, "Approval presence check"],
      [5, "This is a test service, which never starts the presence helper."],
      [6, "Send a test approval"],
      [6, "The command center"],
      [7, "Due today and overdue"],
      [9, "Key fingerprint"],
      [11, "WARNING: the previous presence helper could not remove its previous signing key"],
      [
        13,
        "The presence helper was rebuilt after its key was set up. Run the service install again.",
      ],
      [14, "presence-pin-adopted"],
      [14, "presence-pin-marker-ignored"],
      [15, "presence-pin-changed"],
      [
        15,
        "The stored key is not the one this service trusted. If you didn't reinstall, treat this as unexpected, and run the service install again to set it up.",
      ],
      [16, "The presence helper isn't built. Run the service install again."],
      [16, "The presence helper has no key yet. Run the service install again to set it up."],
      [16, "The companion service isn't running."],
      [17, "The command center, confirmed with your Touch ID or password"],
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
  const tests = parseTests(text);

  it("states the stance in the first paragraphs", () => {
    const intro = text.slice(text.indexOf("# Phase 9")).split("\n\n").slice(0, 4).join("\n\n");
    expect(intro).toMatch(/Agents\s+never\s+mark/);
    expect(intro).toMatch(/T-09-46/);
    expect(intro).toMatch(/real\s+approval-presence\s+Keychain\s+items/);
    expect(intro).not.toMatch(/draft/i);
  });

  it("names the main checkout, the build step, the install, and the order of the owner items", () => {
    expect(setup).toContain("/Users/USERNAME/ClaudeOS");
    expect(flat(setup)).toContain("main checkout");
    expect(setup).toContain("pnpm exec turbo run build");
    expect(setup).toContain("pnpm run service:install");
    expect(setup).toMatch(/Run checks again/);
    // Item 10 re-installs the LaunchAgent three times over the running service, so it is walked last.
    const order = /^\d+\.\s+Walk the owner items in this order: ([^\n]+)$/m.exec(setup)?.[1] ?? "";
    expect(order, "an order line in Setup").not.toBe("");
    const numbers = [...order.matchAll(/\b(\d{1,2})\b/g)].map((m) => Number(m[1]));
    expect([...numbers].sort((a, b) => a - b)).toEqual(OWNER);
    expect(numbers[numbers.length - 1]).toBe(10);
    expect(numbers[0]).toBe(9);
    expect(numbers.indexOf(16)).toBeLessThan(numbers.indexOf(17));
  });

  it("makes item 17 (c) unenrol for itself, because item 16 ends with a reinstall (FIX12 m2)", () => {
    // Item 16 finishes with `pnpm run service:install`, so it leaves an enrolled helper.
    const sixteen = flat(tests.find((test) => test.number === 16)?.expected ?? "");
    expect(sixteen).toMatch(/Finish with `pnpm run service:install`/);
    const seventeen = flat(tests.find((test) => test.number === 17)?.expected ?? "");
    expect(seventeen).toMatch(
      /\(c\) [^]*`~\/\.claude-command-center\/bin\/ccc-presence unenrol`[^]*Approve shows the presence-unavailable line/,
    );
    expect(seventeen).toMatch(/then run `pnpm run service:install` to restore/i);
    // The Setup order note no longer leans on item 16's state.
    expect(flat(setup)).not.toMatch(/item 17 \(c\) uses the unenrolled state/);
    expect(flat(setup)).toMatch(/item 17 \(c\) unenrols for itself/);
  });

  it("tells the owner to replace the main checkout path, keeping the placeholder form (FIX12 m3)", () => {
    expect(flat(text)).toMatch(
      /replace `\/Users\/USERNAME\/ClaudeOS` with your main checkout path/,
    );
    expect(flat(setup)).toMatch(/replace `\/Users\/USERNAME\/ClaudeOS` with your main checkout/);
  });

  it("checks the pin's icmt attribute only after an install, with no secret read (FIX12 m5)", () => {
    const eleven = flat(tests.find((test) => test.number === 11)?.expected ?? "");
    expect(eleven).toMatch(
      /\(c\) `pnpm run service:install` once more[^]*security find-generic-password -a approval-presence-pin -s com\.claude-command-center` \(attribute-only; never add `-w` or `-g`\)[^]*"icmt"/,
    );
  });

  it("names the three re-installs of item 10 and the restore checks", () => {
    const ten = flat(tests.find((test) => test.number === 10)?.expected ?? "");
    expect(ten).toMatch(/three times in a row/);
    expect(ten).toMatch(/launchctl print gui\/\$\(id -u\)\/com\.claude-command-center\.service/);
    expect(ten).toMatch(/prints `1`/);
    expect(teardown).toContain("pnpm run service:install");
    expect(teardown).toMatch(/Each step is safe to repeat/);
    expect(flat(teardown)).toMatch(/diff <\(security list-keychains -d user\)/);
    expect(flat(tests.find((test) => test.number === 19)?.expected ?? "")).toContain(
      'echo "list restored"',
    );
  });

  it("starts nothing the script does not name: no test override variable, no key on a command line", () => {
    expect(text).not.toMatch(
      /(CCC_ENABLE_TEST_OVERRIDES|CCC_RESEARCH_\w+|CCC_CODEX_\w+|CCC_CLAUDE_\w+)=/,
    );
    expect(text).not.toMatch(
      /^\s*`?(export )?CCC_(ENABLE_TEST_OVERRIDES|RESEARCH_|APPROVAL_|CODEX_)/m,
    );
    expect(text).not.toMatch(/ANTHROPIC_API_KEY|--key\b/);
    // Never reads a secret value: no `-w`/`-g` on a security read, no dump-keychain.
    expect(text).not.toMatch(/security find-generic-password[^\n]* -[wg]\b/);
    expect(text).not.toContain("dump-keychain");
  });

  it("writes every home path with the USERNAME placeholder and no temporary-folder path of the owner's", () => {
    for (const match of text.matchAll(/\/Users\/([^/\s`"')]+)/g)) {
      expect(match[1], match[0]).toBe("USERNAME");
    }
    expect(text).not.toMatch(/\/(private|var)\/(tmp|folders)\b/);
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
    expect(checked).toBeGreaterThanOrEqual(5);
    const turbo = JSON.parse(readFileSync(join(REPO_ROOT, "turbo.json"), "utf8")) as {
      tasks: Record<string, unknown>;
    };
    for (const match of text.matchAll(/turbo run ([a-z:]+)/g)) {
      expect(turbo.tasks[match[1] as string], match[0]).toBeDefined();
    }
    for (const match of text.matchAll(/\bscripts\/[A-Za-z0-9_./-]+\.(?:sh|mjs)\b/g)) {
      expect(existsSync(join(REPO_ROOT, match[0])), match[0]).toBe(true);
    }
    // Item 18 runs the spike tooling from the phase folder (`$D/spike/...`) with a flag it prints.
    expect(existsSync(join(dir as string, "spike", "run-custody-probes.sh"))).toBe(true);
    const probes = readFileSync(join(dir as string, "spike", "run-custody-probes.sh"), "utf8");
    for (const line of text.split("\n")) {
      if (line.includes("run-custody-probes.sh")) {
        for (const flag of line.match(/--[a-z][a-z-]*/g) ?? [])
          expect(probes, flag).toContain(flag);
      }
    }
    // The launchd label the items quote is the one the install script registers.
    const installer = readFileSync(join(REPO_ROOT, "scripts", "launchagent", "install.sh"), "utf8");
    const label = /LABEL="([^"]+)"/.exec(installer)?.[1] as string;
    expect(label).toBeTruthy();
    for (const line of text.split("\n")) {
      if (/launchctl/.test(line) && /gui\//.test(line)) expect(line, line).toContain(label);
    }
    // Subcommands the owner types against the helper exist in the helper's source.
    const helper = readFileSync(join(REPO_ROOT, "scripts", "presence", "ccc-presence.m"), "utf8");
    for (const sub of ["enrol", "unenrol", "check"]) {
      expect(text, sub).toMatch(new RegExp(`ccc-presence ${sub}\\b`));
      expect(helper, sub).toContain(`"${sub}"`);
    }
  });
});
