import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-14: the Codex record parsers are PURE. File reads, sqlite and processes
 * belong to the service. This scans the TypeScript source of every non-test
 * file in this folder for a Node specifier or a forbidden global.
 *
 * Forbidden names are assembled at runtime so no literal of them in this file
 * can itself trip the repository's grep backstop.
 */

const FOLDER = dirname(fileURLToPath(import.meta.url));

const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/** Dynamic import or require with a non-literal argument cannot be checked, so it is refused. */
const OPAQUE_LOAD = /\b(import|require)\s*\(\s*[^"'\s)]/;

/** Forbidden globals: process, Buffer, network, timers and a clock read. */
const FORBIDDEN_GLOBALS: readonly { name: string; pattern: RegExp }[] = [
  { name: "process", pattern: new RegExp(`\\b${"proc"}${"ess"}\\b`) },
  { name: "Buffer", pattern: new RegExp(`\\b${"Buf"}${"fer"}\\b`) },
  { name: "fetch", pattern: new RegExp(`\\b${"fe"}${"tch"}\\s*\\(`) },
  { name: "XMLHttpRequest", pattern: /\bXMLHttpRequest\b/ },
  { name: "WebSocket", pattern: /\bWebSocket\b/ },
  { name: "timers", pattern: /\b(setTimeout|setInterval|setImmediate)\s*\(/ },
  { name: "Date.now", pattern: /\bDate\s*\.\s*now\s*\(/ },
  { name: "new Date()", pattern: /\bnew\s+Date\s*\(\s*\)/ },
  { name: "performance.now", pattern: /\bperformance\s*\.\s*now\s*\(/ },
  { name: "globalThis", pattern: /\bglobalThis\b/ },
];

/** Specifiers a pure parser may import: relative files and the shared domain package. */
function allowedSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier === "@ccc/domain";
}

function sourceFiles(): { name: string; source: string }[] {
  return readdirSync(FOLDER)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
    .map((name) => ({ name, source: readFileSync(join(FOLDER, name), "utf8") }));
}

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  const code = stripComments(source);
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      if (match[1] !== undefined) found.push(match[1]);
    }
  }
  return found;
}

/** Strips comments so a word in prose cannot trip a scan meant for code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("Test 7: the Codex record parsers are pure", () => {
  const files = sourceFiles();

  it("scans the real source files (non-vacuous)", () => {
    expect(files.map((f) => f.name)).toEqual(
      expect.arrayContaining(["capabilities.ts", "rollout.ts", "shape.ts"]),
    );
    expect(files.some((f) => f.name.endsWith(".test.ts"))).toBe(false);
    expect(files.flatMap((f) => specifiersOf(f.source)).length).toBeGreaterThan(0);
  });

  it("imports only relative files and the domain package, never a Node builtin", () => {
    const offenders = files.flatMap(({ name, source }) =>
      specifiersOf(source)
        .filter((specifier) => !allowedSpecifier(specifier))
        .map((specifier) => `${name}: ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it("never loads a module through a non-literal import or require", () => {
    expect(files.filter((f) => OPAQUE_LOAD.test(f.source)).map((f) => f.name)).toEqual([]);
  });

  it("uses no forbidden global", () => {
    const offenders = files.flatMap(({ name, source }) => {
      const code = stripComments(source);
      return FORBIDDEN_GLOBALS.filter(({ pattern }) => pattern.test(code)).map(
        ({ name: global }) => `${name}: ${global}`,
      );
    });
    expect(offenders).toEqual([]);
  });

  it("the scan itself detects a planted violation", () => {
    const planted = 'import { readFileSync } from "node:fs";\nconst t = Date.now();';
    expect(specifiersOf(planted).filter((s) => !allowedSpecifier(s))).toEqual(["node:fs"]);
    expect(FORBIDDEN_GLOBALS.some(({ pattern }) => pattern.test(planted))).toBe(true);
  });
});
