import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Plan 08-08 Task 3 (D-05, T-08-18, T-08-22; backstop rule 18's second leg): a source scan of the
 * diagnostics folder. The health probes are read-only and offline, so every non-test file here
 * imports only from a short allowlist, names no network primitive or process module, and calls no
 * file-system write. A probe reaches a process or the machine only through a port the composition
 * root hands it; the ports are typed functions, never a module.
 *
 * The scan is a line-and-regex scan of comment-stripped text (the backstop script is the
 * independent grep leg). A non-vacuity probe on synthetic strings proves each check fires.
 */

const FOLDER = dirname(fileURLToPath(import.meta.url));

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/[.](ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) && !/[.]test[.]/.test(name))
        out.push(full);
    }
  };
  walk(FOLDER);
  return out;
}

/** Removes block and line comments. Good enough for an import and identifier scan (it is not string-aware). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

interface ImportEdge {
  readonly specifier: string;
  readonly typeOnly: boolean;
  /** The imported names for a named import, when the statement lists them. */
  readonly names: readonly string[] | null;
}

/** Every module specifier the source imports, re-exports or loads dynamically. */
export function importsOf(source: string): ImportEdge[] {
  const text = withoutComments(source);
  const edges: ImportEdge[] = [];
  const statement = /\b(import|export)\s+(type\s+)?([^;'"`]*?)\bfrom\s*["'`]([^"'`]+)["'`]/g;
  for (const match of text.matchAll(statement)) {
    const clause = match[3] ?? "";
    const braces = /\{([^}]*)\}/.exec(clause);
    const names =
      braces === null
        ? null
        : (braces[1] ?? "")
            .split(",")
            .map(
              (part) =>
                part
                  .trim()
                  .replace(/^type\s+/, "")
                  .split(/\s+as\s+/)[0] ?? "",
            )
            .filter((part) => part.length > 0);
    edges.push({ specifier: match[4] ?? "", typeOnly: match[2] !== undefined, names });
  }
  for (const match of text.matchAll(/\bimport\s*["'`]([^"'`]+)["'`]/g)) {
    edges.push({ specifier: match[1] ?? "", typeOnly: false, names: null });
  }
  for (const match of text.matchAll(/\b(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    edges.push({ specifier: match[1] ?? "", typeOnly: false, names: null });
  }
  return edges;
}

/** Value imports from a service module the folder may use: the logger and the route toolkit. */
const ALLOWED_RELATIVE_VALUE_IMPORTS = new Set([
  "../vault-root.js",
  "../vault-root-policy.js",
  "../logging.js",
  "../route-kit.js",
]);
/** The file-system reads a probe may use. Nothing that creates, changes, removes or opens for writing. */
const ALLOWED_FS_NAMES = new Set(["access", "constants", "lstat", "realpath", "stat"]);
/** The one thing a probe may take from the vault repository: the read-only managed-tree plan. */
const ALLOWED_VAULT_REPO_NAMES = new Set(["planVaultSetup", "VaultSetupPlan"]);

/** The reasons an import edge is not allowed, empty when it is. */
export function importProblems(edge: ImportEdge): string[] {
  const { specifier } = edge;
  if (specifier === "@ccc/domain" || specifier.startsWith("@ccc/domain/")) return [];
  if (specifier === "node:crypto" || specifier === "node:path") return [];
  if (specifier === "node:fs/promises") {
    const bad = (edge.names ?? ["*"]).filter((name) => !ALLOWED_FS_NAMES.has(name));
    return bad.map((name) => `node:fs/promises name ${name} is not a read-only call`);
  }
  if (specifier === "@ccc/vault-repo") {
    const bad = (edge.names ?? ["*"]).filter((name) => !ALLOWED_VAULT_REPO_NAMES.has(name));
    return bad.map((name) => `@ccc/vault-repo name ${name} is more than the managed-tree plan`);
  }
  if (specifier.startsWith("./")) return [];
  if (specifier.startsWith("../")) {
    if (edge.typeOnly || ALLOWED_RELATIVE_VALUE_IMPORTS.has(specifier)) return [];
    return [`value import of ${specifier}: only a type-only import of a service module is allowed`];
  }
  return [`import of ${specifier} is not on the allowlist`];
}

/** Identifiers a probe must never name. */
const FORBIDDEN_NAMES = [
  /(^|[^A-Za-z0-9_])fetch([^A-Za-z0-9_]|$)/,
  /(^|[^A-Za-z0-9_])(XMLHttpRequest|WebSocket|EventSource)([^A-Za-z0-9_]|$)/,
  /child_process/,
  /["'`]execa(\/[^"'`]*)?["'`]/,
  /["'`](node:)?(https?|http2|net|tls|dgram|dns|undici|node-fetch)(\/promises)?["'`]/,
];

/** A file-system write, open or removal, called or referenced. */
const FS_WRITE =
  /(^|[^A-Za-z0-9_])(writeFile|appendFile|mkdir|mkdtemp|rm|rmdir|rename|chmod|chown|unlink|truncate|copyFile|cp|symlink|link|utimes|createWriteStream|open)(Sync)?([^A-Za-z0-9_]|$)/;

/** The problems with one source text, with the file label first. */
export function sourceProblems(label: string, source: string): string[] {
  const problems: string[] = [];
  for (const edge of importsOf(source)) {
    for (const problem of importProblems(edge)) problems.push(`${label}: ${problem}`);
  }
  const text = withoutComments(source);
  for (const [index, line] of text.split("\n").entries()) {
    for (const pattern of FORBIDDEN_NAMES) {
      if (pattern.test(line)) problems.push(`${label}:${index + 1}: names ${pattern.source}`);
    }
    if (FS_WRITE.test(line))
      problems.push(`${label}:${index + 1}: a file-system write or open call`);
  }
  return problems;
}

describe("the diagnostics folder source scan (rule 18, second leg)", () => {
  const files = sourceFiles();

  it("scans the probe modules written so far (the scan is not vacuous)", () => {
    const names = files.map((file) => relative(FOLDER, file));
    for (const expected of [
      "services.ts",
      "routes.ts",
      "run-probes.ts",
      "vault-probe.ts",
      "hooks-probe.ts",
      "collectors-probe.ts",
      "scheduler-probe.ts",
      "launchers-probe.ts",
      "probe-kit.ts",
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it("every non-test file imports only from the allowlist, names no network primitive or process module and writes nothing", () => {
    const problems = files.flatMap((file) =>
      sourceProblems(relative(FOLDER, file), readFileSync(file, "utf8")),
    );
    expect(problems).toEqual([]);
  });

  describe("non-vacuity: each check fires on a synthetic string", () => {
    const fires: ReadonlyArray<readonly [name: string, source: string]> = [
      ["a network module", 'import http from "node:http";\n'],
      ["a type-only network module import", 'import type { Server } from "node:http";\n'],
      ["fetch(", "const r = fetch(url);\n"],
      ["a bare fetch", "const send = fetch;\n"],
      ["WebSocket", "const w = new WebSocket(u);\n"],
      ["child_process", 'import { execFile } from "node:child_process";\n'],
      ["execa", 'import { execa } from "execa";\n'],
      ["an unknown package", 'import x from "left-pad";\n'],
      ["a value import of a service module", 'import { thing } from "../projects/detection.js";\n'],
      ["a write from node:fs/promises", 'import { writeFile } from "node:fs/promises";\n'],
      ["a namespace import of node:fs/promises", 'import * as fs from "node:fs/promises";\n'],
      ["node:fs", 'import { readFileSync } from "node:fs";\n'],
      [
        "a larger piece of the vault repository",
        'import { initializeVault } from "@ccc/vault-repo";\n',
      ],
      ["a write call", "await mkdir(path, { recursive: true });\n"],
      ["a removal call", "await fs.rm(path);\n"],
      ["a chmod call", "chmodSync(path, 0o700);\n"],
      ["a dynamic import of a network module", 'const m = await import("node:net");\n'],
    ];
    for (const [name, source] of fires) {
      it(`flags ${name}`, () => {
        expect(sourceProblems("probe.ts", source).length).toBeGreaterThan(0);
      });
    }

    const quiet: ReadonlyArray<readonly [name: string, source: string]> = [
      [
        "the domain and its subpaths",
        'import { z } from "@ccc/domain";\nimport type { A } from "@ccc/domain/x.js";\n',
      ],
      [
        "the read-only file-system names",
        'import { access, constants, realpath, stat } from "node:fs/promises";\n',
      ],
      [
        "the managed-tree plan",
        'import { planVaultSetup, type VaultSetupPlan } from "@ccc/vault-repo";\n',
      ],
      ["sibling diagnostics modules", 'import { x } from "./run-probes.js";\n'],
      ["a type-only service import", 'import type { Handler } from "../route-kit.js";\n'],
      ["the vault root policy", 'import { isForbiddenRoot } from "../vault-root-policy.js";\n'],
      [
        "comment lines naming the primitives",
        "// fetch( node:http child_process writeFile\n/* mkdir rm */\nexport const ok = 1;\n",
      ],
      [
        "look-alike identifiers",
        "const prefetch = 1; const remember = 2; const firmware = 3; const opened = 4;\n",
      ],
    ];
    for (const [name, source] of quiet) {
      it(`passes ${name}`, () => {
        expect(sourceProblems("probe.ts", source)).toEqual([]);
      });
    }
  });
});
