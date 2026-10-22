import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
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

/** Whether a `/` after this text starts a regular-expression literal rather than a division. */
function regexMayStart(emitted: string): boolean {
  const trimmed = emitted.trimEnd();
  if (trimmed.length === 0) return true;
  const last = trimmed.at(-1) ?? "";
  if ("(,=:[!&|?{};+-*%<>~^".includes(last)) return true;
  return /(?:^|[^A-Za-z0-9_$])(?:return|typeof|case|in|of|yield|await|void|delete|throw|new)$/.test(
    trimmed,
  );
}

/** Index just past a template literal that starts at `start` (the backtick), `${ }` nesting included. */
function endOfTemplate(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
    } else if (c === "`") {
      return i + 1;
    } else if (c === "$" && source[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        const d = source[i];
        if (d === "`") i = endOfTemplate(source, i);
        else {
          if (d === "{") depth += 1;
          else if (d === "}") depth -= 1;
          i += 1;
        }
      }
    } else {
      i += 1;
    }
  }
  return source.length;
}

/**
 * Removes block and line comments, and nothing else: string, template and regular-expression
 * literals are copied through whole, so a `"/*"` in a string (or a quote in a regular expression)
 * cannot open a comment that swallows the code after it, and newlines are kept so line numbers hold.
 * (FIX2A F7: the earlier regex pair was fooled by `"/*"` inside a string.)
 */
export function withoutComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i] as string;
    const d = source[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && source[i] !== "\n") i += 1;
    } else if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      out += " ";
    } else if (c === '"' || c === "'") {
      const start = i;
      i += 1;
      while (i < n && source[i] !== c && source[i] !== "\n") i += source[i] === "\\" ? 2 : 1;
      i = Math.min(n, i + 1);
      out += source.slice(start, i);
    } else if (c === "`") {
      const end = endOfTemplate(source, i);
      out += source.slice(i, end);
      i = end;
    } else if (c === "/" && regexMayStart(out)) {
      const start = i;
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && source[j] !== "\n") {
        const e = source[j];
        if (e === "\\") j += 2;
        else {
          if (e === "[") inClass = true;
          else if (e === "]") inClass = false;
          else if (e === "/" && !inClass) {
            closed = true;
            j += 1;
            break;
          }
          j += 1;
        }
      }
      if (closed) {
        out += source.slice(start, j);
        i = j;
      } else {
        out += c;
        i += 1;
      }
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
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

/**
 * What the folder may take from outside itself, by name (FIX2A F7): keyed by the specifier resolved
 * against the service source folder. Nothing else outside the folder can be imported, type-only
 * imports included, and a namespace or default import (no names) is refused. `createLogger` is not
 * on the list (the folder uses the shared `logger`, it does not build one); the vault root reader
 * (`../vault-root.js`) is gone because no probe uses it.
 */
const BY_NAME_OUTSIDE: Readonly<Record<string, readonly string[]>> = {
  "logging.js": ["logger"],
  "route-kit.js": ["withAuth", "sendJson", "Handler"],
  "vault-root-policy.js": ["isForbiddenRoot"],
};
/** The file-system reads a probe may use. Nothing that creates, changes, removes or opens for writing. */
const ALLOWED_FS_NAMES = new Set(["access", "constants", "lstat", "realpath", "stat"]);
/** The one thing a probe may take from the vault repository: the fixed list of managed folder names. */
const ALLOWED_VAULT_REPO_NAMES = new Set(["MANAGED_FOLDERS"]);
/** A module that is a test file by its name: never imported by product code, which the other rules exempt. */
const TEST_FILE = /[.](test|spec)([.]|$)/;

/** The reasons an import edge is not allowed, empty when it is. `fileDir` is the importing file's folder inside the diagnostics folder. */
export function importProblems(edge: ImportEdge, fileDir = ""): string[] {
  const { specifier } = edge;
  if (specifier === "@ccc/domain" || specifier.startsWith("@ccc/domain/")) return [];
  if (specifier === "node:crypto" || specifier === "node:path") return [];
  if (specifier === "node:fs/promises") {
    const bad = (edge.names ?? ["*"]).filter((name) => !ALLOWED_FS_NAMES.has(name));
    return bad.map((name) => `node:fs/promises name ${name} is not a read-only call`);
  }
  if (specifier === "@ccc/vault-repo") {
    const bad = (edge.names ?? ["*"]).filter((name) => !ALLOWED_VAULT_REPO_NAMES.has(name));
    return bad.map((name) => `@ccc/vault-repo name ${name} is more than the managed folder list`);
  }
  if (specifier === "." || specifier === ".." || /^[.][.]?\//.test(specifier)) {
    // Normalised against the folder, so `./../x`, `./a/../../x` and `../diagnostics/x` cannot hide where they go.
    const resolved = posix.normalize(posix.join("diagnostics", fileDir, specifier));
    if (resolved === "diagnostics" || resolved.startsWith("diagnostics/")) {
      return TEST_FILE.test(resolved) ? [`import of the test file ${specifier}`] : [];
    }
    const allowed = BY_NAME_OUTSIDE[resolved];
    if (allowed === undefined) {
      return [
        `import of ${specifier} leaves the diagnostics folder and is not on the by-name list`,
      ];
    }
    const bad = (edge.names ?? ["*"]).filter((name) => !allowed.includes(name));
    return bad.map((name) => `import of ${name} from ${specifier} is not on the by-name list`);
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

/**
 * Ways to reach a module or the global scope without an import statement, mirroring rule 17 (FIX2A
 * F7): the built-in module getter, the process internals, a CommonJS require, a computed global or
 * reflective read, `eval` and the Function constructor. Checked on the whole comment-free text.
 */
const FORBIDDEN_ESCAPES: ReadonlyArray<readonly [name: string, pattern: RegExp]> = [
  ["getBuiltinModule", /(^|[^A-Za-z0-9_$])getBuiltinModule([^A-Za-z0-9_$]|$)/],
  [
    "process.binding or process.dlopen",
    /(^|[^A-Za-z0-9_$])process\s*\.\s*(binding|dlopen)([^A-Za-z0-9_$]|$)/,
  ],
  ["a bracketed process access", /(^|[^A-Za-z0-9_$])process\s*\[/],
  ["createRequire", /(^|[^A-Za-z0-9_$])createRequire([^A-Za-z0-9_$]|$)/],
  ["require(", /(^|[^A-Za-z0-9_$.])require\s*\(/],
  ["a bracketed globalThis access", /(^|[^A-Za-z0-9_$])globalThis\s*\[/],
  ["Reflect", /(^|[^A-Za-z0-9_$])Reflect([^A-Za-z0-9_$]|$)/],
  ["eval", /(^|[^A-Za-z0-9_$])eval([^A-Za-z0-9_$]|$)/],
  ["Function(", /(^|[^A-Za-z0-9_$])Function\s*\(/],
  ["a computed import(", /(^|[^A-Za-z0-9_$.])import\s*\(\s*(?!(["'`])[^"'`\\\n]*\2\s*[,)])/],
  ["a synchronous file-system call (*Sync()", /(^|[^A-Za-z0-9_$])[A-Za-z0-9_$]*Sync\s*\(/],
];

/** A file-system write, open or removal, called or referenced. */
const FS_WRITE =
  /(^|[^A-Za-z0-9_])(writeFile|appendFile|mkdir|mkdtemp|rm|rmdir|rename|chmod|chown|unlink|truncate|copyFile|cp|symlink|link|utimes|createWriteStream|open)(Sync)?([^A-Za-z0-9_]|$)/;

/** The 1-based line of an index in a text. */
function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** The problems with one source text, with the file label first. */
export function sourceProblems(label: string, source: string): string[] {
  const problems: string[] = [];
  const fileDir = posix.dirname(label) === "." ? "" : posix.dirname(label);
  for (const edge of importsOf(source)) {
    for (const problem of importProblems(edge, fileDir)) problems.push(`${label}: ${problem}`);
  }
  const text = withoutComments(source);
  for (const [index, line] of text.split("\n").entries()) {
    for (const pattern of FORBIDDEN_NAMES) {
      if (pattern.test(line)) problems.push(`${label}:${index + 1}: names ${pattern.source}`);
    }
    if (FS_WRITE.test(line))
      problems.push(`${label}:${index + 1}: a file-system write or open call`);
  }
  for (const [name, pattern] of FORBIDDEN_ESCAPES) {
    const hit = pattern.exec(text);
    if (hit !== null) problems.push(`${label}:${lineAt(text, hit.index)}: names ${name}`);
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
      [
        "the vault repository's synchronous plan",
        'import { planVaultSetup } from "@ccc/vault-repo";\n',
      ],
      ["a write call", "await mkdir(path, { recursive: true });\n"],
      ["a removal call", "await fs.rm(path);\n"],
      ["a chmod call", "chmodSync(path, 0o700);\n"],
      ["a dynamic import of a network module", 'const m = await import("node:net");\n'],

      // FIX2A F7: the seven evasions of the first version of this scan.
      [
        "1. a specifier that climbs out and back in (./../)",
        'import { x } from "./../untrusted/x.js";\n',
      ],
      [
        "1b. a specifier that climbs out through a sibling folder",
        'import { x } from "./a/../../projects/detection.js";\n',
      ],
      ["2. an import of a test file of the folder", 'import { x } from "./vault-probe.test.js";\n'],
      ["2b. an import of a spec file by a bare name", 'import { x } from "./helper.spec";\n'],
      [
        "3. a by-name import of something else from the logging module",
        'import { createLogger } from "../logging.js";\n',
      ],
      ["3b. a default import from the route kit", 'import kit from "../route-kit.js";\n'],
      [
        "3c. the vault root reader (no longer on the list)",
        'import { readVaultRoot } from "../vault-root.js";\n',
      ],
      ["4. getBuiltinModule", 'const http = process.getBuiltinModule("node:" + "http");\n'],
      ["4b. process.binding", 'const t = process.binding("tcp_wrap");\n'],
      ["4c. process.dlopen", "process.dlopen(m, file);\n"],
      ["4d. createRequire", "const r = createRequire(import.meta.url);\n"],
      ["5. a computed globalThis read", 'const f = globalThis["fe" + "tch"];\n'],
      ["5b. Reflect.get", 'const f = Reflect.get(globalThis, "fetch");\n'],
      ["6. eval", 'eval("fet" + "ch(u)");\n'],
      ["6b. (0, eval)", 'const e = (0, eval)("1");\n'],
      ["6c. Function(", 'const f = new Function("return fetch")();\n'],
      ["7. a computed import(", "const m = await import(name);\n"],
      ["7b. a concatenated import(", 'const m = await import("node:" + "http");\n'],
      ["7c. an import( whose argument is on the next line", "const m = await import(\n  name);\n"],
      [
        "8. code after a string that holds a comment opener",
        'const opener = "/*";\nconst send = fetch(u);\nconst closer = "*/";\n',
      ],
      [
        "8b. code after a template that holds a comment opener",
        "const opener = `/*`;\nawait import(name);\nconst closer = `*/`;\n",
      ],
      [
        "8c. code after a regular expression with a quote",
        "const q = /[\"']/;\nconst send = fetch(u);\n",
      ],
      ["9. existsSync(", "const there = existsSync(path);\n"],
      ["9b. a member Sync call", "const info = fs.statSync(path);\n"],
      ["9c. readFileSync(", "const text = readFileSync(path);\n"],
      ["10. a bracketed process access", 'const k = process["bind" + "ing"]("tcp_wrap");\n'],
      ["11. a CommonJS require", 'const http = require("node:http");\n'],
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
      ["the managed folder list", 'import { MANAGED_FOLDERS } from "@ccc/vault-repo";\n'],
      ["sibling diagnostics modules", 'import { x } from "./run-probes.js";\n'],
      [
        "a sibling reached through a round trip",
        'import { x } from "../diagnostics/run-probes.js";\n',
      ],
      [
        "the route kit, by name",
        'import { type Handler, sendJson, withAuth } from "../route-kit.js";\n',
      ],
      [
        "a type-only import of the route kit's Handler",
        'import type { Handler } from "../route-kit.js";\n',
      ],
      ["the shared logger, by name", 'import { logger } from "../logging.js";\n'],
      ["the vault root policy", 'import { isForbiddenRoot } from "../vault-root-policy.js";\n'],
      [
        "a string that holds a comment opener, then ordinary code",
        'const opener = "/*";\nconst closer = "*/";\nexport const ok = 1;\n',
      ],
      [
        "a division after a comment",
        "const half = total / 2; /* note */ export const ok = half;\n",
      ],
      ["a regular expression with a quote", "const q = /[\"']/;\nexport const ok = q;\n"],
      [
        "an import( with a literal specifier of an allowed module",
        'const m = await import("@ccc/domain");\n',
      ],
      [
        "look-alike names",
        "const evaluate = 1; const Functional = 2; const processed = 3; const resync = 4;\n",
      ],
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
