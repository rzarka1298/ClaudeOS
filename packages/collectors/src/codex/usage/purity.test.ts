import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as barrel from "./index.js";

/**
 * D-14: the Codex usage collectors are pure. This folder imports `@ccc/domain`
 * and nothing from Node, so the service (not this folder) owns every process
 * start, file read and clock read. The scan reads the TypeScript source, not
 * the compiled output, because the package index re-exports the sub-barrel.
 *
 * Forbidden module names are joined at runtime so no import-shaped literal in
 * this file can trip the repository's grep backstop.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE_BUILTINS = ["fs", "child_process", "net", "http", "https", "os", "path", "dgram", "tls"];
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];
const OPAQUE_LOAD = /\b(import|require)\s*\(\s*[^"'\s)]/;
const FORBIDDEN_GLOBALS: readonly RegExp[] = [
  new RegExp(["Date", "now"].join("\\.") + "\\s*\\("),
  new RegExp(["new", "Date\\s*\\(\\s*\\)"].join("\\s+")),
  new RegExp(["process", "env"].join("\\.")),
  /\bfetch\s*\(/,
  /\bsetTimeout\s*\(/,
  /\bsetInterval\s*\(/,
  /\bBuffer\b/,
  /\bprocess\./,
];

function sourceFiles(): { name: string; source: string }[] {
  return readdirSync(HERE)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ name, source: readFileSync(join(HERE, name), "utf8") }));
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

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("Test 8: the Codex usage folder is pure (D-14)", () => {
  const files = sourceFiles();

  it("scans the real source files (non-vacuous)", () => {
    expect(files.map((f) => f.name).sort()).toEqual(["guard.ts", "index.ts", "rate-limits.ts"]);
    expect(files.flatMap((f) => specifiersOf(f.source))).toContain("@ccc/domain");
  });

  it("imports only @ccc/domain and sibling files, never a Node module", () => {
    const offenders = files.flatMap(({ name, source }) =>
      specifiersOf(source)
        .filter(
          (specifier) =>
            specifier !== "@ccc/domain" && !specifier.startsWith("./") && specifier !== "zod",
        )
        .map((specifier) => `${name}: ${specifier}`),
    );
    expect(offenders).toEqual([]);
    const nodeUses = files.flatMap(({ name, source }) =>
      specifiersOf(source)
        .filter(
          (specifier) =>
            specifier.startsWith("node:") ||
            NODE_BUILTINS.includes(specifier.replace(/^node:/, "")),
        )
        .map((specifier) => `${name}: ${specifier}`),
    );
    expect(nodeUses).toEqual([]);
  });

  it("never loads a module through a non-literal import or require", () => {
    expect(files.filter((f) => OPAQUE_LOAD.test(f.source)).map((f) => f.name)).toEqual([]);
  });

  it("reads no clock, environment, network or timer of its own", () => {
    const offenders = files.flatMap(({ name, source }) =>
      FORBIDDEN_GLOBALS.filter((pattern) => pattern.test(codeOnly(source))).map(
        (pattern) => `${name}: ${pattern.source}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("exports exactly the public functions through the sub-barrel", () => {
    expect(Object.keys(barrel).sort()).toEqual([
      "GUARD_EXIT",
      "ageFreshness",
      "buildCodexHeadroom",
      "evaluateGuard",
      "normalizeRateLimitsReply",
      "normalizeRolloutRateLimits",
    ]);
  });
});
