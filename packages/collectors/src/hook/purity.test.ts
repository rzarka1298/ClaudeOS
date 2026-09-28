import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../test-support/run-compiled.js";

/**
 * D-10 and PR-08 over the COMPILED output, not the TypeScript source: what
 * the installer copies is `dist/hook/*.js`, so that is what must be pure.
 * `tsc -b` also emits `*.test.js` there; the installer and this scan both
 * exclude them.
 *
 * Import shapes are RegExp objects and the forbidden module name is joined
 * at runtime, so no import-shaped literal in this file can itself trip the
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

/** Offending `file: specifier` pairs for specifiers outside `node:*` and the allowed relative prefixes. */
function impureSpecifiers(
  files: { name: string; source: string }[],
  relativePrefixes: readonly string[],
): string[] {
  return files.flatMap(({ name, source }) =>
    specifiersOf(source)
      .filter(
        (specifier) =>
          !specifier.startsWith("node:") &&
          !relativePrefixes.some((prefix) => specifier.startsWith(prefix)),
      )
      .map((specifier) => `${name}: ${specifier}`),
  );
}

describe("Test 8: the compiled hook is dependency-free and cannot spawn", () => {
  const hookFiles = compiledFiles("hook");

  it("scans the real compiled hook files (non-vacuous)", () => {
    expect(hookFiles.map((f) => f.name).sort()).toEqual(
      expect.arrayContaining(["deliver.js", "entry.js", "limits.js", "minimize.js"]),
    );
    expect(hookFiles.some((f) => f.name.endsWith(".test.js"))).toBe(false);
    expect(hookFiles.flatMap((f) => specifiersOf(f.source))).toContain("node:http");
  });

  it('imports only "node:" builtins and "./" files', () => {
    expect(impureSpecifiers(hookFiles, ["./"])).toEqual([]);
  });

  it("never loads a module through a non-literal import or require", () => {
    const offenders = hookFiles.filter((f) => OPAQUE_LOAD.test(f.source)).map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it("never names the child-process module, with or without the node: prefix", () => {
    const offenders = hookFiles
      .filter(({ source }) =>
        specifiersOf(source).some(
          (specifier) => specifier.replace(/^node:/, "") === CHILD_PROCESS_MODULE,
        ),
      )
      .map((f) => f.name);
    expect(offenders).toEqual([]);
    const mentions = hookFiles.filter((f) => f.source.includes(CHILD_PROCESS_MODULE));
    expect(mentions.map((f) => f.name)).toEqual([]);
  });
});
