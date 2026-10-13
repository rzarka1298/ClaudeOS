import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static guard over every e2e source file (05.2-03, D-02, D-05, T-05.2-11): nothing in the
 * runner may touch the owner's service, launchd job, real runtime directory, Claude settings,
 * or reach the shell. The scanner is a small pure function (source text and relative file name
 * in, findings out) so the test can prove its own rules discriminate against in-memory samples.
 * It is comment-aware, like the repository's own backstop, and the allow lists are exact
 * relative paths, never substring matches. This file is not scanned: it holds the bad samples.
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Finding {
  rule: string;
  file: string;
  line: number;
  text: string;
}

const GUARD_MODULE = "src/isolation-guards.ts";
const GUARD_MODULE_TEST = "src/isolation-guards.test.ts";
const REGION_CAPTURE_FILES = [
  "src/screenshots.ts",
  "src/screenshots.test.ts",
  "specs/notification-look.e2e.ts",
];
/**
 * Files that read the repository's own project skill under the repository root (never the owner's
 * home folder) to pin the shared ratification wording (05.2-10). Exact paths only.
 */
const REPO_SKILL_READERS = ["src/docs-wording.test.ts"];

/**
 * Files that name the owner's live socket path only to REFUSE it: the isolation guards, the
 * environment check and the vault plugin-data writer, each with its test. Exact paths only.
 */
const LIVE_SOCKET_REFUSAL_FILES = [
  GUARD_MODULE,
  GUARD_MODULE_TEST,
  "src/uat-env.ts",
  "src/uat-env.test.ts",
  "src/vault-plugin-data.ts",
  "src/vault-plugin-data.test.ts",
];

interface LineRule {
  id: string;
  pattern: RegExp;
  allowedFiles?: readonly string[];
}

const LINE_RULES: LineRule[] = [
  {
    id: "owner-service-lifecycle-script",
    pattern:
      /dev:service|service:install|service:uninstall|service:restart|launchagent\/(install|uninstall|restart)/i,
  },
  { id: "launchctl", pattern: /launchctl|Library\/LaunchAgents/i },
  {
    id: "owner-runtime-or-claude-path",
    pattern: /\.claude-command-center|["'`/]\.claude(["'`/]|$)/,
    allowedFiles: [...LIVE_SOCKET_REFUSAL_FILES, ...REPO_SKILL_READERS],
  },
  { id: "open-command", pattern: /(spawn|execFile)\w*\(\s*["'`]open["'`]/ },
  { id: "shell-option", pattern: /(^|[^A-Za-z0-9_.])["']?shell["']?\s*:\s*(?!false\b)(?=\S)/ },
  { id: "exec-call", pattern: /(^|[^A-Za-z0-9_.])(exec|execSync)\(/ },
  { id: "dynamic-child-process", pattern: /import\(\s*["'`](node:)?child_process/ },
  {
    id: "better-sqlite3",
    pattern: /from\s*["']better-sqlite3["']|require\(\s*["']better-sqlite3["']/,
  },
  { id: "obsidian-import", pattern: /from\s*["']obsidian["']|require\(\s*["']obsidian["']\s*\)/ },
  {
    id: "region-capture",
    pattern: /screencapture|captureRegion/,
    allowedFiles: REGION_CAPTURE_FILES,
  },
];

const isCommentLine = (line: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(line);

/** Scans one file's text. `file` is the path relative to packages/e2e, forward slashes. */
function scanSource(text: string, file: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");
  lines.forEach((raw, index) => {
    if (isCommentLine(raw)) return;
    for (const rule of LINE_RULES) {
      if (rule.allowedFiles?.includes(file)) continue;
      if (rule.pattern.test(raw)) {
        findings.push({ rule: rule.id, file, line: index + 1, text: raw.trim() });
      }
    }
  });

  const code = lines.filter((line) => !isCommentLine(line)).join("\n");
  // obsidian:// handed to a process spawn: any file that imports child_process and names the scheme.
  if (/node:child_process/.test(code) && /obsidian:\/\//.test(code)) {
    findings.push({
      rule: "obsidian-protocol-spawn",
      file,
      line: 0,
      text: "obsidian:// with child_process",
    });
  }
  // Every sqlite3 spawn carries the read-only flag and names a copy.
  if (/(spawn|execFile)\w*\(\s*["'`]sqlite3["'`]/.test(code)) {
    if (!/-readonly/.test(code) || !/copy/i.test(code)) {
      findings.push({ rule: "sqlite3-not-readonly-copy", file, line: 0, text: "sqlite3 spawn" });
    }
  }
  return findings;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

function scannedFiles(): string[] {
  const files: string[] = [];
  for (const folder of ["src", "specs", "smoke"]) {
    try {
      walk(join(PACKAGE_DIR, folder), files);
    } catch {
      // a folder that does not exist yet
    }
  }
  for (const config of ["wdio.conf.ts", "wdio.smoke.conf.ts"])
    files.push(join(PACKAGE_DIR, config));
  return files
    .map((file) => relative(PACKAGE_DIR, file).split("\\").join("/"))
    .filter((file) => file !== "src/static-guard.test.ts");
}

describe("static guard over every e2e source file (Test 6)", () => {
  const files = scannedFiles();

  it("scans the sandbox modules and both wdio configuration files", () => {
    for (const expected of [
      "src/sandbox.ts",
      "src/sweep.ts",
      "src/isolation-guards.ts",
      "wdio.conf.ts",
      "wdio.smoke.conf.ts",
    ]) {
      expect(files).toContain(expected);
    }
  });

  it("finds nothing that could touch the owner's service, launchd job, Claude settings or a shell", () => {
    const findings = files.flatMap((file) =>
      scanSource(readFileSync(join(PACKAGE_DIR, file), "utf8"), file),
    );
    expect(findings).toEqual([]);
  });
});

describe("the scanner discriminates (Test 6)", () => {
  const BAD: Array<[string, string, string]> = [
    ["owner-service-lifecycle-script", `run("pnpm", ["run", "dev:service"]);`, "src/x.ts"],
    ["owner-service-lifecycle-script", `const s = "service:install";`, "src/x.ts"],
    ["launchctl", `execFile("launchctl", ["kickstart"]);`, "src/x.ts"],
    ["launchctl", `const p = "Library/LaunchAgents/x";`, "src/x.ts"],
    ["owner-runtime-or-claude-path", `const d = join(home, ".claude-command-center");`, "src/x.ts"],
    ["owner-runtime-or-claude-path", `const d = join(home, ".claude");`, "src/x.ts"],
    ["open-command", `spawn("open", ["-a", "Obsidian"]);`, "src/x.ts"],
    [
      "obsidian-protocol-spawn",
      `import { spawn } from "node:child_process";\nspawn("x", ["obsidian://open"]);`,
      "src/x.ts",
    ],
    ["shell-option", `spawn("x", [], { shell: true });`, "src/x.ts"],
    ["shell-option", `spawn("x", [], { shell: "/bin/sh" });`, "src/x.ts"],
    ["exec-call", `exec("ls");`, "src/x.ts"],
    ["exec-call", `execSync("ls");`, "src/x.ts"],
    ["dynamic-child-process", `const cp = await import("node:child_process");`, "src/x.ts"],
    ["better-sqlite3", ['import Database from "better', '-sqlite3";'].join(""), "src/x.ts"],
    ["obsidian-import", ['import { Plugin } from "obs', 'idian";'].join(""), "src/x.ts"],
    ["sqlite3-not-readonly-copy", `execFile("sqlite3", [dbPath, "select 1"]);`, "src/x.ts"],
    ["region-capture", `execFile("screencapture", ["-x"]);`, "src/x.ts"],
    ["region-capture", `await captureRegion(1, 2, 3, 4);`, "specs/other.e2e.ts"],
  ];

  for (const [rule, sample, file] of BAD) {
    it(`flags ${rule}: ${sample.split("\n").pop()?.slice(0, 50)}`, () => {
      expect(scanSource(sample, file).map((finding) => finding.rule)).toContain(rule);
    });
  }

  it("accepts clean samples, comments, a shell:false option and a RegExp exec", () => {
    const clean = [
      `// launchctl is banned here, see the guard`,
      ` * dev:service and .claude-command-center appear only in this comment`,
      `spawn("node", [entry], { shell: false });`,
      `const m = /a/.exec(text);`,
      `execFile("sqlite3", ["-readonly", copyOfDb, "select 1"]);`,
      `execFile("ps", ["-axo", "pid="]);`,
    ].join("\n");
    expect(scanSource(clean, "src/x.ts")).toEqual([]);
  });

  it("honours exact-path allow lists and never substring matches", () => {
    const real = `const d = join(home, ".claude-command-center");`;
    expect(scanSource(real, GUARD_MODULE)).toEqual([]);
    expect(scanSource(real, `${GUARD_MODULE}.bak`).length).toBeGreaterThan(0);
    expect(scanSource(real, `other/${GUARD_MODULE}`).length).toBeGreaterThan(0);
    expect(scanSource(`captureRegion(1)`, "src/screenshots.ts")).toEqual([]);
    expect(scanSource(`captureRegion(1)`, "src/screenshots.ts.old").length).toBeGreaterThan(0);
  });

  it("allows an sqlite3 spawn that is read-only and names a copy", () => {
    const ok = `const copy = copyOfDb();\nexecFile("sqlite3", ["-readonly", copy, "select 1"]);`;
    expect(scanSource(ok, "src/x.ts")).toEqual([]);
  });
});
