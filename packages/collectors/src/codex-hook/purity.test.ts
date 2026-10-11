import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../test-support/run-compiled.js";

/**
 * The Codex hook's purity over the COMPILED output (D-19, T-05.1-21): what an
 * installer copies is `dist/codex-hook/*.js` plus the two shared modules it
 * imports, so those are what must be pure. `tsc -b` also emits `*.test.js`
 * there; the installer and this scan both exclude them.
 *
 * Import shapes are RegExp objects and the forbidden module name is joined at
 * runtime, so no import-shaped literal in this file can itself trip the
 * repository's grep backstop.
 */

/** Every static, side-effect, dynamic-import and require specifier in a compiled file. */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/** A dynamic import or require whose argument is not a string literal cannot be checked, so it is refused. */
const OPAQUE_LOAD = /\b(import|require)\s*\(\s*[^"'\s)]/;

/** The child-process module, spelled so no literal of it appears in this file. */
const CHILD_PROCESS_MODULE = ["child", "process"].join("_");

/** The only shared modules the Codex hook may reach beyond its own folder. */
const PERMITTED_SHARED = ["../hook/deliver.js", "../hook/limits.js"];

/** Any way to write to the terminal Codex is attached to. */
const TERMINAL_WRITES = /\bprocess\s*\.\s*(stdout|stderr)\b|\bconsole\s*\./;

function compiledFiles(subdir: string): { name: string; source: string }[] {
  const dir = join(PACKAGE_ROOT, "dist", subdir);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".js") && !name.endsWith(".test.js"))
    .map((name) => ({ name, source: readFileSync(join(dir, name), "utf8") }));
}

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) found.push(match[1]);
    }
  }
  return found;
}

/** Offending `file: specifier` pairs: not `node:*`, not `./`, not a permitted shared module. */
function impureSpecifiers(
  files: { name: string; source: string }[],
  relativePrefixes: readonly string[],
  exactAllowed: readonly string[] = [],
): string[] {
  return files.flatMap(({ name, source }) =>
    specifiersOf(source)
      .filter(
        (specifier) =>
          !specifier.startsWith("node:") &&
          !relativePrefixes.some((prefix) => specifier.startsWith(prefix)) &&
          !exactAllowed.includes(specifier),
      )
      .map((specifier) => `${name}: ${specifier}`),
  );
}

describe("Test 1: the compiled Codex hook is dependency-free and cannot spawn", () => {
  const codexFiles = compiledFiles("codex-hook");

  it("scans the real compiled Codex hook files (non-vacuous)", () => {
    expect(codexFiles.map((f) => f.name).sort()).toEqual(["entry.js", "limits.js", "minimize.js"]);
    expect(codexFiles.some((f) => f.name.endsWith(".test.js"))).toBe(false);
    const specifiers = codexFiles.flatMap((f) => specifiersOf(f.source));
    expect(specifiers).toContain("node:crypto");
    expect(specifiers).toContain("../hook/deliver.js");
    expect(specifiers).toContain("../hook/limits.js");
  });

  it("imports only node: builtins, ./ files and the two permitted shared modules", () => {
    expect(impureSpecifiers(codexFiles, ["./"], PERMITTED_SHARED)).toEqual([]);
  });

  it("reaches no ../ module other than the two permitted ones, and imports no package", () => {
    const parents = codexFiles
      .flatMap((f) => specifiersOf(f.source))
      .filter((specifier) => specifier.startsWith("../"));
    expect(parents.length).toBeGreaterThan(0);
    for (const specifier of parents) expect(PERMITTED_SHARED).toContain(specifier);
    const packages = codexFiles
      .flatMap((f) => specifiersOf(f.source))
      .filter((s) => s.startsWith("@") || !(s.startsWith("node:") || s.startsWith(".")));
    expect(packages).toEqual([]);
  });

  it("never loads a module through a non-literal import or require", () => {
    expect(codexFiles.filter((f) => OPAQUE_LOAD.test(f.source)).map((f) => f.name)).toEqual([]);
  });

  it("never names the child-process module, with or without the node: prefix", () => {
    const offenders = codexFiles
      .filter(({ source }) =>
        specifiersOf(source).some(
          (specifier) => specifier.replace(/^node:/, "") === CHILD_PROCESS_MODULE,
        ),
      )
      .map((f) => f.name);
    expect(offenders).toEqual([]);
    expect(
      codexFiles.filter((f) => f.source.includes(CHILD_PROCESS_MODULE)).map((f) => f.name),
    ).toEqual([]);
  });

  it("never touches stdout, stderr or the console", () => {
    expect(codexFiles.filter((f) => TERMINAL_WRITES.test(f.source)).map((f) => f.name)).toEqual([]);
  });
});

describe("Test 2: the shared modules the Codex hook reaches are pure too", () => {
  const hookFiles = compiledFiles("hook");

  it('every compiled non-test file under dist/hook imports only "node:" builtins and "./" files', () => {
    expect(hookFiles.map((f) => f.name)).toEqual(
      expect.arrayContaining(["deliver.js", "limits.js"]),
    );
    expect(impureSpecifiers(hookFiles, ["./"])).toEqual([]);
    expect(hookFiles.filter((f) => OPAQUE_LOAD.test(f.source)).map((f) => f.name)).toEqual([]);
    expect(
      hookFiles.filter((f) => f.source.includes(CHILD_PROCESS_MODULE)).map((f) => f.name),
    ).toEqual([]);
  });
});

describe("Test 5: the Claude hook installation is isolated from the Codex hook", () => {
  const repoRoot = resolve(PACKAGE_ROOT, "..", "..");

  it("the file list the Claude installer copies from dist/hook is exactly the four Claude files", () => {
    const dir = join(PACKAGE_ROOT, "dist", "hook");
    const entries = readdirSync(dir);
    // Mirrors copyHookFiles: every `.js` that is not a `.test.js`, non-recursive.
    const copied = entries
      .filter((name) => name.endsWith(".js") && !name.endsWith(".test.js"))
      .sort();
    expect(copied).toEqual(["deliver.js", "entry.js", "limits.js", "minimize.js"]);
    expect(entries.some((name) => name.toLowerCase().includes("codex"))).toBe(false);
    expect(entries.filter((name) => statSync(join(dir, name)).isDirectory())).toEqual([]);
  });

  it("no Codex hook file name appears in dist/hook, and the folders do not overlap", () => {
    const codexNames = compiledFiles("codex-hook").map((f) => f.name);
    const claudeNames = new Set(compiledFiles("hook").map((f) => f.name));
    // entry.js, limits.js and minimize.js exist in both folders: they are different files.
    for (const name of codexNames) {
      const codex = readFileSync(join(PACKAGE_ROOT, "dist", "codex-hook", name), "utf8");
      if (claudeNames.has(name)) {
        const claude = readFileSync(join(PACKAGE_ROOT, "dist", "hook", name), "utf8");
        expect(codex, name).not.toBe(claude);
      }
    }
    expect(compiledFiles("hook").some((f) => f.source.includes("codex-hooks.ndjson"))).toBe(false);
  });

  it("the Claude installer script copies only dist/hook and dist/statusline, never a Codex folder", () => {
    const lib = readFileSync(join(repoRoot, "scripts", "claude-hooks", "lib.mjs"), "utf8");
    expect(lib).toMatch(/copyHookFiles\(join\(COLLECTORS_DIST, "hook"\)/);
    expect(lib).toMatch(/copyHookFiles\(join\(COLLECTORS_DIST, "statusline"\)/);
    expect(lib).not.toMatch(/codex-hook/i);
  });
});
