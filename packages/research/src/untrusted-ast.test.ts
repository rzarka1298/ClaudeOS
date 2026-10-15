// A syntax-tree scan of packages/service/src/untrusted/ (ADR-0014 layer 3, the part a grep cannot
// do), written as an ALLOWLIST. Backstop rule 17 reads lines, so an author can hide the Function
// constructor from it (a destructured or concatenated key, a continuation line, a template-literal
// line, a reflection chain through property descriptors). This scan reads the tree instead.
//
// Rules, for every file of the folder (test files included):
//   - an identifier that is used as a value must be declared in the file (a binding, a parameter,
//     a function, a class, an import) or be on the short list of plain language globals below.
//     Everything else (process, globalThis, eval, Function, Reflect, fetch, require, window,
//     console, setTimeout, Buffer, structuredClone, ...) is a finding without being named;
//   - no member or string that reaches the prototype machinery: constructor, __proto__, prototype,
//     getOwnPropertyDescriptor(s), getPrototypeOf, getOwnPropertyNames, getOwnPropertySymbols,
//     setPrototypeOf, defineProperty, defineProperties;
//   - no computed property key (in a literal, a pattern or a class) and no element access whose key
//     is not a string or number literal;
//   - no dynamic import, import.meta or import-equals, and no import except @ccc/domain, a
//     relative module, or vitest in a test file.
//
// Fixtures prove it fires on each shape, including the ones the line scan cannot see.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FOLDER = join(REPO_ROOT, "packages", "service", "src", "untrusted");

/** Plain language globals a pure text function may use. */
const ALLOWED_GLOBALS = new Set([
  "undefined",
  "NaN",
  "Infinity",
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
  "Math",
  "JSON",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "Date",
  "RegExp",
  "Symbol",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
]);

/** Members and strings that reach the prototype machinery or the constructor. */
const BANNED_MEMBERS = new Set([
  "constructor",
  "__proto__",
  "prototype",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getPrototypeOf",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "setPrototypeOf",
  "defineProperty",
  "defineProperties",
]);

function bindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bindingNames(element.name, into);
  }
}

function declaredNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) bindingNames(node.name, names);
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name !== undefined
    ) {
      names.add(node.name.text);
    }
    if (ts.isImportClause(node) && node.name !== undefined) names.add(node.name.text);
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) names.add(node.name.text);
    if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      bindingNames(node.variableDeclaration.name, names);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** True when the identifier is only a name (a declaration, a property, a label), not a value. */
function isNameOnly(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isQualifiedName(parent)) return parent.right === node;
  if (ts.isPropertyAssignment(parent)) return parent.name === node;
  if (ts.isBindingElement(parent)) return parent.propertyName === node || parent.name === node;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isFunctionExpression(parent) ||
    ts.isClassDeclaration(parent) ||
    ts.isClassExpression(parent) ||
    ts.isEnumDeclaration(parent) ||
    ts.isEnumMember(parent) ||
    ts.isInterfaceDeclaration(parent) ||
    ts.isTypeAliasDeclaration(parent) ||
    ts.isTypeParameterDeclaration(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isGetAccessor(parent) ||
    ts.isSetAccessor(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isLabeledStatement(parent) ||
    ts.isBreakOrContinueStatement(parent)
  ) {
    return (parent as { name?: ts.Node }).name === node || !("name" in parent);
  }
  return false;
}

/** True when the identifier sits inside a type (erased at runtime), except a class `extends`. */
function inTypePosition(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isExpressionWithTypeArguments(current)) {
      const clause = current.parent;
      const isClassExtends =
        ts.isHeritageClause(clause) &&
        clause.token === ts.SyntaxKind.ExtendsKeyword &&
        (ts.isClassDeclaration(clause.parent) || ts.isClassExpression(clause.parent));
      return !isClassExtends;
    }
    if (ts.isTypeNode(current) && !ts.isExpressionWithTypeArguments(current)) return true;
    if (ts.isStatement(current)) return false;
  }
  return false;
}

export function findings(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const declared = declaredNames(source);
  const testFile = /\.test\.[cm]?[jt]sx?$/.test(fileName);
  const out: string[] = [];
  const at = (node: ts.Node): string =>
    `${fileName}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (BANNED_MEMBERS.has(node.text) && !ts.isConstructorDeclaration(node.parent)) {
        out.push(`${at(node)} banned name ${node.text}`);
      } else if (
        !isNameOnly(node) &&
        !inTypePosition(node) &&
        !declared.has(node.text) &&
        !ALLOWED_GLOBALS.has(node.text)
      ) {
        out.push(`${at(node)} global ${node.text} is not on the allowlist`);
      }
    }
    if (ts.isStringLiteralLike(node) && BANNED_MEMBERS.has(node.text)) {
      out.push(`${at(node)} banned string ${node.text}`);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      out.push(`${at(node)} dynamic import`);
    }
    if (ts.isMetaProperty(node)) out.push(`${at(node)} import.meta`);
    if (ts.isComputedPropertyName(node)) {
      const key = node.expression;
      if (!(ts.isStringLiteralLike(key) || ts.isNumericLiteral(key))) {
        out.push(`${at(node)} computed property key`);
      }
    }
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
        const allowed =
          name === "@ccc/domain" ||
          name.startsWith("./") ||
          name.startsWith("../") ||
          (testFile && name === "vitest");
        if (!allowed) out.push(`${at(node)} import of ${name}`);
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

describe("the untrusted folder, read as a syntax tree against an allowlist", () => {
  it("uses only declared names, plain globals, no prototype machinery, no computed keys", () => {
    const scanned = files(FOLDER);
    expect(scanned.length).toBeGreaterThanOrEqual(3);
    const all = scanned.flatMap((file) => findings(file, readFileSync(file, "utf8")));
    expect(all).toEqual([]);
  });

  const FIRE: ReadonlyArray<readonly [name: string, source: string]> = [
    ["a destructured constructor", 'const { constructor: F } = () => 0;\nF("return 1");\n'],
    ["a shorthand constructor binding", "const { constructor } = () => 0;\n"],
    [
      "a concatenated key in a destructuring pattern",
      'declare const f: object;\nconst { ["con" + "structor"]: F } = f as never;\nexport const g = F;\n',
    ],
    [
      "a concatenated key",
      'declare const f: object;\nexport const k = (f as never)["con" + "structor"];\n',
    ],
    [
      "a computed key in an object literal",
      "declare const k: string;\nexport const o = { [k]: 1 };\n",
    ],
    ["a computed key in a class", "declare const k: string;\nexport class A { [k] = 1; }\n"],
    [
      "a template-literal line that starts with slashes",
      "export const t = `\n// x\n$" + "{globalThis}`;\n",
    ],
    ["a continuation line", "export const n = 1\n  * 0 || globalThis;\n"],
    ["a constructor property read", "export const c = (() => 1).constructor;\n"],
    ["a constructor string", 'export const s = "constructor";\n'],
    [
      "the descriptor chain to the Function constructor",
      "const proto = Object.getPrototypeOf(() => 0);\nexport const d = Object.getOwnPropertyDescriptor(proto, 'x');\n",
    ],
    ["getOwnPropertyNames", "export const n = Object.getOwnPropertyNames({});\n"],
    ["setPrototypeOf", "export const s = Object.setPrototypeOf({}, null);\n"],
    ["defineProperty", "export const d = Object.defineProperty({}, 'a', { value: 1 });\n"],
    ["__proto__ as a member", "export const p = ({} as { __proto__: object }).__proto__;\n"],
    ["__proto__ as a key", "export const p = { __proto__: null };\n"],
    ["prototype", "export class A {}\nexport const p = A.prototype;\n"],
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
    ["a class extending Function", "export class A extends Function {}\n"],
    ["Reflect", "export const r = Reflect.ownKeys({});\n"],
    ["fetch", 'export const f = fetch("x");\n'],
    ["process", "export const p = process.env;\n"],
    ["window", "export const w = window;\n"],
    ["console", 'console.log("x");\n'],
    ["setTimeout", "setTimeout(() => 0, 1);\n"],
    ["Buffer", 'export const b = Buffer.from("x");\n'],
    ["structuredClone", "export const c = structuredClone({});\n"],
    ["globalThis", "export const g = globalThis;\n"],
    [
      "an ambient declaration of fetch used through an alias",
      "declare const fetch: (url: string) => Promise<unknown>;\nexport const send = fetch;\nexport const go = (url: string) => send(url);\n",
    ],
    ["declare global", "declare global { interface Window { x: number } }\nexport {};\n"],
    ["a module augmentation", 'declare module "x" { export const y: number; }\n'],
    ["a namespace", "namespace N { export const a = 1; }\nexport { N };\n"],
    [
      "an escaped Function with an unrelated parameter (Codex)",
      'export function harmless(Funct\\u0069on: unknown) { return 0; }\nexport const escape = Funct\\u0069on("return this")();\n',
    ],
    [
      "an escaped globalThis with an unrelated parameter",
      "export function shadow(glob\\u0061lThis: number): number { return glob\\u0061lThis + 1; }\nexport const host = glob\\u0061lThis;\n",
    ],
    [
      "a plain parameter named Function elsewhere in the file",
      'export function harmless(Function: unknown) { return Function; }\nexport const f = (0, Function)("return 1");\n',
    ],
    [
      "a parameter named globalThis elsewhere in the file",
      "export function shadow(globalThis: number) { return globalThis; }\nexport const g = globalThis;\n",
    ],
    [
      "a local declaration named process",
      "const process = { env: 1 };\nexport const e = process.env;\n",
    ],
    ["a local function named fetch", "function fetch() { return 1; }\nexport const f = fetch();\n"],
    ["a reference directive", '/// <reference lib="dom" />\nexport const a = 1;\n'],
    ["an escaped identifier", "export const \\u0061 = 1;\n"],
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
      "export class Failure extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; } }",
      "const list = [1, 2, 3];",
      "export const second = list[1];",
      'const record = { a: 1 }; export const a = record["a"];',
      "export const keys = Object.keys(record).map((key) => key.toUpperCase());",
      'export const lookup = new Map<string, number>([["a", 1]]);',
      "export async function run(): Promise<number> { return Math.max(1, 2); }",
      "export const total = JSON.parse('[1]') as number[];",
      "",
    ].join("\n");
    expect(findings("quiet.ts", quiet)).toEqual([]);
  });
});
