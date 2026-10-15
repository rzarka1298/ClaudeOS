// A syntax-tree scan of packages/service/src/untrusted/ (ADR-0014 layer 3, the part a grep cannot
// do), written as an ALLOWLIST. Backstop rule 17 reads lines, so an author can hide the Function
// constructor from it (a destructured or concatenated key, a continuation line, a template-literal
// line, a reflection chain through property descriptors). This scan reads the tree instead.
//
// Rules, for every file of the folder (test files included). Identifiers are resolved with the
// TypeChecker, never by text alone:
//   - a name used as a value must resolve to a REAL declaration in the same file (a binding, a
//     parameter, a function, a class, an import: not an ambient `declare`), or to a standard-library
//     symbol whose name is on the short list of plain language globals below;
//   - a list of host and reflection names (process, globalThis, eval, Function, Reflect, Proxy,
//     fetch, require, window, console, setTimeout, Buffer, structuredClone, ...) is rejected
//     unconditionally by name, wherever it appears and whatever the file declares: an unrelated
//     parameter named like a global exempts nothing;
//   - no `declare` (ambient declarations, `declare global`), no module or namespace declaration
//     (augmentation), no triple-slash reference, no import type, and no unicode escape in an
//     identifier (the decoded name would hide from a text match);
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
import { dirname, join, resolve } from "node:path";
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

/** Host, reflection and loader names: rejected by name wherever they appear. */
const FORBIDDEN_NAMES = new Set([
  "process",
  "globalThis",
  "eval",
  "Function",
  "Reflect",
  "Proxy",
  "fetch",
  "require",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "window",
  "self",
  "global",
  "Buffer",
  "console",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "structuredClone",
  "Atomics",
  "SharedArrayBuffer",
  "WebAssembly",
  "importScripts",
  "module",
  "exports",
  "__dirname",
  "__filename",
]);

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  lib: ["lib.es2022.d.ts"],
  types: [],
  noResolve: true,
  noEmit: true,
  skipLibCheck: true,
};

const libraryFiles = new Map<string, ts.SourceFile>();

/** A one-file program (the real folder's compiler options: ES2022, no ambient types). */
function programFor(fileName: string, text: string): ts.Program {
  const base = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const host: ts.CompilerHost = {
    ...base,
    getSourceFile(name, languageVersion, onError) {
      if (name === fileName) return ts.createSourceFile(name, text, languageVersion, true);
      const cached = libraryFiles.get(name);
      if (cached !== undefined) return cached;
      const loaded = base.getSourceFile(name, languageVersion, onError);
      if (loaded !== undefined) libraryFiles.set(name, loaded);
      return loaded;
    },
    fileExists: (name) => name === fileName || base.fileExists(name),
    readFile: (name) => (name === fileName ? text : base.readFile(name)),
  };
  return ts.createProgram([fileName], COMPILER_OPTIONS, host);
}

function isDeclare(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
  );
}

export function findings(file: string, text: string): string[] {
  const fileName = resolve(file);
  const program = programFor(fileName, text);
  const source = program.getSourceFile(fileName);
  if (source === undefined) return [`${file} could not be read`];
  const checker = program.getTypeChecker();
  const testFile = /\.test\.[cm]?[jt]sx?$/.test(fileName);
  const out: string[] = [];
  const at = (node: ts.Node): string =>
    `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

  if (
    source.referencedFiles.length > 0 ||
    source.typeReferenceDirectives.length > 0 ||
    source.libReferenceDirectives.length > 0
  ) {
    out.push(`${file}:1 triple-slash reference`);
  }

  /** Why a value name is not acceptable, or null when it resolves to something allowed. */
  const rejectName = (node: ts.Identifier): string | null => {
    const parent = node.parent;
    const symbol =
      ts.isShorthandPropertyAssignment(parent) && parent.name === node
        ? checker.getShorthandAssignmentValueSymbol(parent)
        : checker.getSymbolAtLocation(node);
    const declarations = symbol?.declarations ?? [];
    if (symbol === undefined || declarations.length === 0) {
      return ALLOWED_GLOBALS.has(node.text) ? null : `name ${node.text} resolves to nothing`;
    }
    for (const declaration of declarations) {
      const declaredIn = declaration.getSourceFile();
      if (declaredIn === source) {
        if (
          (ts.getCombinedModifierFlags(declaration as ts.Declaration) &
            ts.ModifierFlags.Ambient) !==
          0
        ) {
          return `name ${node.text} is only declared ambiently`;
        }
      } else if (program.isSourceFileDefaultLibrary(declaredIn)) {
        if (!ALLOWED_GLOBALS.has(node.text)) return `global ${node.text} is not on the allowlist`;
      } else {
        return `name ${node.text} comes from outside the file`;
      }
    }
    return null;
  };

  const visit = (node: ts.Node): void => {
    if (isDeclare(node)) out.push(`${at(node)} declare`);
    if (ts.isModuleDeclaration(node)) out.push(`${at(node)} module or namespace declaration`);
    if (ts.isImportTypeNode(node)) out.push(`${at(node)} import type expression`);
    if (ts.isIdentifier(node)) {
      if (node.getText(source).includes("\\")) out.push(`${at(node)} escaped identifier`);
      if (FORBIDDEN_NAMES.has(node.text)) {
        out.push(`${at(node)} forbidden name ${node.text}`);
      } else if (BANNED_MEMBERS.has(node.text) && !ts.isConstructorDeclaration(node.parent)) {
        out.push(`${at(node)} banned name ${node.text}`);
      } else if (!isNameOnly(node) && !inTypePosition(node)) {
        const why = rejectName(node);
        if (why !== null) out.push(`${at(node)} ${why}`);
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
