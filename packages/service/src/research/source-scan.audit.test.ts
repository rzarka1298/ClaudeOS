import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Test 6 (source scan): the research path and the untrusted boundary spawn nothing, run no
// command from content and never reach the executors or the approval minter (D-17, D-26,
// RSRCH-09, T-07-29). The scan is over every non-test source file; test-support folders are test
// code, as in the backstop rules.

const SERVICE_SRC = fileURLToPath(new URL("..", import.meta.url));
const FOLDERS = ["research", "untrusted"].map((name) => join(SERVICE_SRC, name));

function sourceFiles(folder: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "test-support")
        out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

const FILES = FOLDERS.flatMap(sourceFiles);

/** Module specifiers that can start another process, thread, context or program. */
const FORBIDDEN_MODULES = [
  "child_process",
  "node:child_process",
  "worker_threads",
  "node:worker_threads",
  "cluster",
  "node:cluster",
  "vm",
  "node:vm",
];

/** Words assembled at run time so this file does not contain a call it forbids. */
const PROCESS_CALLS = [
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
  "fork",
];
const CALL = new RegExp(`(?<![.\\w$])(?:${PROCESS_CALLS.join("|")})\\s*\\(`);

function importsOf(text: string): string[] {
  const specifiers: string[] = [];
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    specifiers.push(match[1] ?? "");
  }
  for (const match of text.matchAll(/require\s*\(\s*["']([^"']+)["']/g)) {
    specifiers.push(match[1] ?? "");
  }
  return specifiers;
}

describe("the research path source scan", () => {
  it("covers the research and untrusted folders", () => {
    expect(FILES.length).toBeGreaterThan(20);
    expect(FILES.some((file) => file.endsWith(join("research", "pipeline.ts")))).toBe(true);
    expect(FILES.some((file) => file.endsWith(join("untrusted", "index.ts")))).toBe(true);
  });

  it("imports no process, thread, cluster or vm module", () => {
    for (const file of FILES) {
      const hits = importsOf(readFileSync(file, "utf8")).filter((spec) =>
        FORBIDDEN_MODULES.includes(spec),
      );
      expect(hits, relative(SERVICE_SRC, file)).toEqual([]);
    }
  });

  it("calls no exec, spawn or fork function", () => {
    for (const file of FILES) {
      const text = readFileSync(file, "utf8");
      expect(CALL.test(text), relative(SERVICE_SRC, file)).toBe(false);
    }
  });

  it("evaluates nothing: no eval, no Function constructor, no dynamic import", () => {
    for (const file of FILES) {
      const text = readFileSync(file, "utf8");
      const where = relative(SERVICE_SRC, file);
      expect(/(?<![.\w$])eval\s*\(/.test(text), where).toBe(false);
      expect(/new\s+Function\s*\(/.test(text), where).toBe(false);
      expect(/(?<![.\w$])import\s*\(/.test(text), where).toBe(false);
    }
  });

  it("imports neither the executors nor the approval engine or minter", () => {
    for (const file of FILES) {
      const hits = importsOf(readFileSync(file, "utf8")).filter(
        (spec) =>
          /(^|\/)(executors|approval|approval-wiring)(\/|$)/.test(spec) ||
          spec.startsWith("@ccc/service/approval"),
      );
      expect(hits, relative(SERVICE_SRC, file)).toEqual([]);
    }
  });

  it("writes files only through the allowlist loader and the vault writers", () => {
    const writers = [
      "writeFileSync",
      "appendFileSync",
      "mkdirSync",
      "renameSync",
      "unlinkSync",
      "rmSync",
      "rmdirSync",
      "copyFileSync",
      "cpSync",
      "symlinkSync",
      "createWriteStream",
      "writeFile",
      "appendFile",
    ];
    const pattern = new RegExp(`(?<![.\\w$])(?:${writers.join("|")})\\b`);
    const allowed = new Set(["sources-config.ts"]);
    for (const file of FILES) {
      if (allowed.has(file.split("/").at(-1) ?? "")) continue;
      const text = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(pattern.test(text), relative(SERVICE_SRC, file)).toBe(false);
    }
  });
});
