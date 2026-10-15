// A syntax-tree scan of packages/service/src/untrusted/ (ADR-0014 layer 3, the part a grep cannot
// do). Backstop rule 17 reads lines, so an author can hide the Function constructor from it with a
// destructured key, a concatenated key, a continuation line or a line inside a template literal
// that starts with two slashes. This scan reads the tree instead: it sees through comments,
// templates and line breaks, and it does not trip on a string that merely mentions a word.
//
// It bans: the names process, globalThis, eval, Function, Reflect, fetch, require, XMLHttpRequest,
// WebSocket and EventSource as identifiers; `constructor` as a property, a binding, a key or a
// string (a class's own constructor declaration is fine); every dynamic import and import.meta;
// element access whose key is not a literal; and any import that is not @ccc/domain or a
// relative module. The scan also runs on the test files of the folder.
//
// Fixtures prove it fires on each shape, including the ones the line scan cannot see.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FOLDER = join(REPO_ROOT, "packages", "service", "src", "untrusted");

const BANNED_IDENTIFIERS = new Set([
  "process",
  "globalThis",
  "eval",
  "Function",
  "Reflect",
  "fetch",
  "require",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
]);

export function findings(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const at = (node: ts.Node): string =>
    `${fileName}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (BANNED_IDENTIFIERS.has(node.text)) out.push(`${at(node)} identifier ${node.text}`);
      if (node.text === "constructor" && !ts.isConstructorDeclaration(node.parent)) {
        out.push(`${at(node)} identifier constructor`);
      }
    }
    if (ts.isStringLiteralLike(node) && node.text === "constructor") {
      out.push(`${at(node)} string constructor`);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      out.push(`${at(node)} dynamic import`);
    }
    if (ts.isMetaProperty(node)) out.push(`${at(node)} import.meta`);
    if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      if (!(ts.isStringLiteralLike(key) || ts.isNumericLiteral(key))) {
        out.push(`${at(node)} computed element access`);
      }
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier !== undefined && ts.isStringLiteral(specifier)) {
        const name = specifier.text;
        const testFile = /\.test\.[cm]?[jt]sx?$/.test(fileName);
        if (
          !(
            name === "@ccc/domain" ||
            name.startsWith("./") ||
            name.startsWith("../") ||
            (testFile && name === "vitest")
          )
        ) {
          out.push(`${at(node)} import of ${name}`);
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node)) out.push(`${at(node)} import equals`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry)) out.push(full);
  }
  return out.sort();
}

describe("the untrusted folder, read as a syntax tree", () => {
  it("holds no banned identifier, constructor access, dynamic import or foreign import", () => {
    const scanned = files(FOLDER);
    expect(scanned.length).toBeGreaterThanOrEqual(3);
    const all = scanned.flatMap((file) => findings(file, readFileSync(file, "utf8")));
    expect(all).toEqual([]);
  });

  const FIRE: ReadonlyArray<readonly [name: string, source: string]> = [
    ["a destructured constructor", 'const { constructor: F } = () => 0;\nF("return 1");\n'],
    ["a shorthand constructor binding", "const { constructor } = () => 0;\n"],
    [
      "a concatenated key",
      'declare const f: object;\nexport const k = (f as never)["con" + "structor"];\n',
    ],
    [
      "a template-literal line that starts with slashes",
      "export const t = `\n// x\n$" + "{globalThis}`;\n",
    ],
    ["a continuation line", "export const n = 1\n  * 0 || globalThis;\n"],
    ["a constructor property read", "export const c = (() => 1).constructor;\n"],
    ["a constructor string", 'export const s = "constructor";\n'],
    [
      "an import with a comment before the paren",
      'export const m = import /* x */ ("no" + "de:os");\n',
    ],
    ["a dynamic import with a literal", 'export const m = import("x");\n'],
    ["import.meta", "export const u = import.meta.url;\n"],
    [
      "a computed element access",
      "declare const o: Record<string, number>;\ndeclare const k: string;\nexport const v = o[k];\n",
    ],
    ["a node import", 'import { readFileSync } from "node:fs";\nexport const r = readFileSync;\n'],
    ["a package import", 'import pino from "pino";\nexport const p = pino;\n'],
    ["eval", 'export const e = eval("1");\n'],
    ["an indirect Function", 'export const f = (0, Function)("return 1");\n'],
    ["Reflect", "export const r = Reflect.ownKeys({});\n"],
    ["fetch", 'export const f = fetch("x");\n'],
    ["process", "export const p = process.env;\n"],
  ];
  for (const [name, source] of FIRE) {
    it(`finds ${name}`, () => {
      expect(findings("probe.ts", source).length, source).toBeGreaterThan(0);
    });
  }

  it("is quiet for ordinary domain code", () => {
    const quiet = [
      'import type { NoteId } from "@ccc/domain";',
      'import { helper } from "./helper.js";',
      "const processed = 1;",
      'const text = "process globalThis eval( Function fetch(";',
      "// process globalThis eval( Function",
      "/* import( constructor */",
      "export class Holder { constructor(readonly id: NoteId | null) {} }",
      "const list = [1, 2, 3];",
      "export const second = list[1];",
      'const record = { a: 1 }; export const a = record["a"];',
      "",
    ].join("\n");
    expect(findings("quiet.ts", quiet)).toEqual([]);
  });
});
