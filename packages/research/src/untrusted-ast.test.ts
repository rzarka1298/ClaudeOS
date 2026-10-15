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
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
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
  // V8 Error statics (a host-visible hook and a stack-shape probe), the legacy accessor methods
  // that read or install getters and setters, and the sloppy-mode call-stack links.
  "prepareStackTrace",
  "captureStackTrace",
  "stackTraceLimit",
  "__lookupGetter__",
  "__defineGetter__",
  "__lookupSetter__",
  "__defineSetter__",
  "caller",
  "callee",
]);

/** Built-ins whose statics are a shared surface: only construction or a call may name them. */
const CONSTRUCTOR_ONLY = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "RegExp"]);

/** Object statics that change an object in place (a call on a built-in target is a write). */
const MUTATORS = new Set([
  "assign",
  "defineProperty",
  "defineProperties",
  "freeze",
  "seal",
  "preventExtensions",
  "setPrototypeOf",
]);

/** True when the identifier is only a name (a declaration, a property, a label), not a value. */
function isNameOnly(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isQualifiedName(parent)) return parent.right === node;
  if (ts.isPropertyAssignment(parent)) return parent.name === node;
  if (ts.isBindingElement(parent)) return parent.propertyName === node || parent.name === node;
  if (ts.isImportSpecifier(parent)) return true;
  if (ts.isExportSpecifier(parent)) {
    // A re-export (`export { x } from "m"`) names the other module's binding. A local export
    // reads a local value: the local name (propertyName ?? name) is a reference, not a name.
    if (parent.parent.parent.moduleSpecifier !== undefined) return true;
    return (parent.propertyName ?? parent.name) !== node;
  }
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
function programFor(
  fileName: string,
  text: string,
): { program: ts.Program; host: ts.CompilerHost } {
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
  return { program: ts.createProgram([fileName], COMPILER_OPTIONS, host), host };
}

/** How a relative specifier is resolved: the way the real build does (NodeNext, ESM importer). */
const RESOLVE_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  types: [],
};

const REAL_FOLDER = `${realpathSync(FOLDER)}${sep}`;

function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Why an import or export-from specifier is not acceptable, or null. */
function specifierProblem(
  name: string,
  fileName: string,
  host: ts.CompilerHost,
  testFile: boolean,
): string | null {
  if (name === "@ccc/domain") return null;
  if (name === "vitest") return testFile ? null : "import of vitest from a non-test file";
  if (!name.startsWith("./") && !name.startsWith("../")) return `import of ${name}`;
  if (!testFile && name.includes(".test.")) return `import of the test module ${name}`;
  const resolved = ts.resolveModuleName(
    name,
    fileName,
    RESOLVE_OPTIONS,
    host,
    undefined,
    undefined,
    ts.ModuleKind.ESNext,
  ).resolvedModule;
  if (resolved === undefined) return `import of ${name} does not resolve`;
  const real = realOf(resolved.resolvedFileName);
  if (resolved.isExternalLibraryImport === true || real.split(sep).includes("node_modules")) {
    return `import of ${name} reaches node_modules`;
  }
  if (resolved.extension !== ts.Extension.Ts || real.endsWith(".d.ts")) {
    return `import of ${name} resolves to a non-.ts file`;
  }
  if (!real.startsWith(REAL_FOLDER)) return `import of ${name} resolves outside the folder`;
  if (!testFile && basename(real).includes(".test.")) return `import of the test module ${name}`;
  return null;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The member a property or element access names, when the key is a plain string. */
function memberNameOf(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return undefined;
}

/** True when `this` sits in a class member (arrows are transparent; any other function is not). */
function thisInClassMember(node: ts.Node): boolean {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isArrowFunction(current)) continue;
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) return false;
    if (
      ts.isConstructorDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessor(current) ||
      ts.isSetAccessor(current) ||
      ts.isPropertyDeclaration(current) ||
      ts.isClassStaticBlockDeclaration(current)
    ) {
      return ts.isClassLike(current.parent);
    }
    if (ts.isSourceFile(current)) return false;
  }
  return false;
}

function isDeclare(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
  );
}

export function findings(file: string, text: string): string[] {
  const fileName = resolve(file);
  const { program, host } = programFor(fileName, text);
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
    let symbol: ts.Symbol | undefined;
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
      symbol = checker.getShorthandAssignmentValueSymbol(parent);
    } else if (ts.isExportSpecifier(parent)) {
      symbol = checker.getExportSpecifierLocalTargetSymbol(parent);
    } else {
      symbol = checker.getSymbolAtLocation(node);
    }
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

  const inDefaultLibrary = (symbol: ts.Symbol | undefined): boolean =>
    (symbol?.declarations ?? []).some((declaration) =>
      program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
    );

  /** True when an expression is the value of a built-in constructor or namespace (by its type). */
  const isBuiltinValue = (expression: ts.Expression, pattern: RegExp): boolean => {
    const symbol = checker.getTypeAtLocation(expression).getSymbol();
    return symbol !== undefined && pattern.test(symbol.name) && inDefaultLibrary(symbol);
  };

  const BUILTIN_VALUE = /^(?:[A-Za-z]+Constructor|Math|JSON)$/;
  const SHARED_CTOR =
    /^(?:Error|TypeError|RangeError|SyntaxError|EvalError|ReferenceError|URIError|RegExp)Constructor$/;

  /** True when an access chain starts at (or passes through) a built-in the folder may name. */
  const touchesBuiltin = (target: ts.Expression): boolean => {
    let current = unwrap(target);
    for (;;) {
      if (ts.isIdentifier(current) && ALLOWED_GLOBALS.has(current.text)) return true;
      if (isBuiltinValue(current, BUILTIN_VALUE)) return true;
      if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
        current = unwrap(current.expression);
        continue;
      }
      return false;
    }
  };

  /** The assignment targets inside a (possibly destructuring) left-hand side. */
  const targetsOf = (left: ts.Expression): ts.Expression[] => {
    const target = unwrap(left);
    if (ts.isArrayLiteralExpression(target)) {
      return target.elements.flatMap((element) =>
        ts.isSpreadElement(element) ? targetsOf(element.expression) : targetsOf(element),
      );
    }
    if (ts.isObjectLiteralExpression(target)) {
      return target.properties.flatMap((property) => {
        if (ts.isPropertyAssignment(property)) return targetsOf(property.initializer);
        if (ts.isShorthandPropertyAssignment(property)) return [property.name];
        if (ts.isSpreadAssignment(property)) return targetsOf(property.expression);
        return [];
      });
    }
    // `[a = 1] = ...`: the default-value assignment is visited as an assignment of its own.
    if (ts.isBinaryExpression(target)) return [];
    return [target];
  };

  const flagWrites = (node: ts.Node, targets: readonly ts.Expression[]): void => {
    if (targets.some(touchesBuiltin)) out.push(`${at(node)} write to a shared built-in`);
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
        if (CONSTRUCTOR_ONLY.has(node.text)) {
          const parent = node.parent;
          const allowed =
            ((ts.isNewExpression(parent) || ts.isCallExpression(parent)) &&
              parent.expression === node) ||
            (ts.isBinaryExpression(parent) &&
              parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
              parent.right === node) ||
            ts.isExpressionWithTypeArguments(parent);
          if (!allowed) out.push(`${at(node)} ${node.text} is only for new, a call or instanceof`);
        }
      }
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword && !thisInClassMember(node)) {
      out.push(`${at(node)} this outside a class member`);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (isBuiltinValue(node.expression, SHARED_CTOR)) {
        out.push(`${at(node)} member of Error or RegExp`);
      }
      const member = memberNameOf(node);
      const object = unwrap(node.expression);
      if (
        member !== undefined &&
        MUTATORS.has(member) &&
        ((ts.isIdentifier(object) && object.text === "Object") ||
          isBuiltinValue(object, /^ObjectConstructor$/))
      ) {
        const callee = node.parent;
        if (!(ts.isCallExpression(callee) && callee.expression === node)) {
          out.push(`${at(node)} Object.${member} used other than as a direct call`);
        } else if (callee.arguments[0] !== undefined && touchesBuiltin(callee.arguments[0])) {
          out.push(`${at(node)} Object.${member} on a shared built-in`);
        }
      }
    }
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      if (kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment) {
        flagWrites(node, targetsOf(node.left));
      }
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      flagWrites(node, [node.operand]);
    }
    if (ts.isDeleteExpression(node)) flagWrites(node, [node.expression]);
    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      flagWrites(node, targetsOf(node.initializer));
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
        const why = specifierProblem(specifier.text, fileName, host, testFile);
        if (why !== null) out.push(`${at(node)} ${why}`);
        if (specifier.text === "vitest" && testFile) {
          // Only the named describe, it and expect: no vi, no namespace, no default, no re-export.
          const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
          const bindings = clause?.namedBindings;
          const named =
            clause !== undefined &&
            clause.name === undefined &&
            bindings !== undefined &&
            ts.isNamedImports(bindings) &&
            bindings.elements.every((element) =>
              ["describe", "it", "expect"].includes((element.propertyName ?? element.name).text),
            );
          if (!named) out.push(`${at(node)} vitest import other than describe, it, expect`);
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node)) out.push(`${at(node)} import equals`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Every file under dir (any name, any extension); a symlink counts as a file, never followed. */
function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (lstatSync(full).isDirectory()) out.push(...files(full));
    else out.push(full);
  }
  return out.sort();
}

/** Why a file may not sit in the folder, or null: only plain *.ts (and the folder's tsconfig.json). */
function fileProblem(full: string): string | null {
  const name = basename(full);
  try {
    if (lstatSync(full).isSymbolicLink()) return `${full} is a symlink`;
  } catch {
    // a fixture name that is not on disk
  }
  if (name === "tsconfig.json") return null;
  if (name.endsWith(".d.ts")) return `${full} is a declaration file`;
  if (!/^[^/]+\.ts$/.test(name) || /\.[cm]ts$/.test(name)) return `${full} is not a plain .ts file`;
  return null;
}

describe("the untrusted folder, read as a syntax tree against an allowlist", () => {
  it("uses only declared names, plain globals, no prototype machinery, no computed keys", () => {
    const scanned = files(FOLDER);
    expect(scanned.length).toBeGreaterThanOrEqual(3);
    expect(scanned.map(fileProblem).filter((problem) => problem !== null)).toEqual([]);
    const all = scanned
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) => findings(file, readFileSync(file, "utf8")));
    expect(all).toEqual([]);
  });

  // Fixtures run as if they lived in the real folder, so a relative specifier resolves against it.
  const PROBE = join(FOLDER, "probe.ts");
  const PROBE_TEST = join(FOLDER, "probe.test.ts");
  const FIRE: ReadonlyArray<readonly [name: string, source: string, file?: string]> = [
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
    // Round 5 (Opus gap review). Relative specifiers are resolved against the real folder.
    ["a relative import that leaves the folder", 'export { a } from "../approval/index.js";\n'],
    [
      "a relative import of a sibling folder",
      'import { a } from "../paths.js";\nexport const b = a;\n',
    ],
    [
      "a relative import that does not resolve",
      'import { a } from "./missing.js";\nexport const b = a;\n',
    ],
    ["a relative export-from that leaves the folder", 'export * from "../index.js";\n'],
    [
      "a relative import that climbs into node_modules",
      'import "../../../node_modules/zod/index.js";\n',
    ],
    [
      "a relative import of a test module from a non-test file",
      'import { a } from "./index.test.js";\nexport const b = a;\n',
    ],
    ["Error.prepareStackTrace", "export const p = Error.prepareStackTrace;\n"],
    [
      "an Error.prepareStackTrace write",
      "Error.prepareStackTrace = (_e: unknown, s: unknown) => s;\n",
    ],
    ["Error.captureStackTrace", "Error.captureStackTrace({});\n"],
    ["Error.stackTraceLimit", "export const l = Error.stackTraceLimit;\n"],
    ["a stackTraceLimit string", 'export const s = "stackTraceLimit";\n'],
    ["an Error static that is not on the V8 list", "export const n = Error.name;\n"],
    ["Error held in a variable", "const E = Error;\nexport const n = E;\n"],
    ["Error element access", 'export const n = Error["name"];\n'],
    ["RegExp.$1", 'export const m = /a(b)/.exec("ab") && RegExp.$1;\n'],
    ["RegExp lastMatch", "export const m = RegExp.lastMatch;\n"],
    ["RegExp input", "export const m = RegExp.input;\n"],
    ["RegExp $& element access", 'export const m = RegExp["$&"];\n'],
    ["RegExp $_ element access", 'export const m = RegExp["$_"];\n'],
    ["RegExp destructured", "export const { $1 } = RegExp;\n"],
    ["a write to Array", "Array.x = 1;\n"],
    ["a write to Math", "Math.max = Math.min;\n"],
    ["a compound write to Object", "Object.x += 1;\n"],
    ["a logical write to JSON", "JSON.x ??= 1;\n"],
    ["a delete on a built-in", "delete JSON.parse;\n"],
    ["an increment of a built-in member", "Math.PI++;\n"],
    ["a decrement of a built-in member", "--Math.E;\n"],
    ["a write through a cast", "(Array as unknown as { x: number }).x = 1;\n"],
    ["a nested write to a built-in", "Object.keys.x.y = 1;\n"],
    ["a destructuring write to a built-in", "[Array.x] = [1];\n"],
    ["an object destructuring write to a built-in", "({ a: Array.x } = { a: 1 });\n"],
    ["a for-of write to a built-in", "for (Array.x of [1]) {}\n"],
    ["a write through an alias of a built-in", "const A = Array;\nA.x = 1;\n"],
    ["Object.assign onto a built-in", "Object.assign(Array, { x: 1 });\n"],
    ["Object.freeze of a built-in", "Object.freeze(Map);\n"],
    ["Object.seal of a built-in member", "Object.seal(Math.max);\n"],
    ["Object.preventExtensions of a built-in", "Object.preventExtensions(Set);\n"],
    ["Object.assign held in a variable", "const a = Object.assign;\na(Array, {});\n"],
    ["Object.assign through call", "Object.assign.call(null, Array, {});\n"],
    [
      "Object[assign] element access held in a variable",
      'const a = Object["freeze"];\na(Array);\n',
    ],
    [
      "__lookupGetter__",
      "export const g = ({} as { __lookupGetter__: unknown }).__lookupGetter__;\n",
    ],
    [
      "__defineGetter__",
      "export const g = ({} as { __defineGetter__: unknown }).__defineGetter__;\n",
    ],
    [
      "__lookupSetter__",
      "export const g = ({} as { __lookupSetter__: unknown }).__lookupSetter__;\n",
    ],
    [
      "__defineSetter__",
      "export const g = ({} as { __defineSetter__: unknown }).__defineSetter__;\n",
    ],
    [
      "a caller read",
      "export function f(): unknown { return (f as { caller?: unknown }).caller; }\n",
    ],
    [
      "a callee read",
      "export function f(): unknown { return (arguments as { callee?: unknown }).callee; }\n",
    ],
    [
      "the vi helper from vitest",
      'import { vi } from "vitest";\nexport const v = vi;\n',
      PROBE_TEST,
    ],
    [
      "a namespace import of vitest",
      'import * as v from "vitest";\nexport const x = v;\n',
      PROBE_TEST,
    ],
    ["a default import of vitest", 'import v from "vitest";\nexport const x = v;\n', PROBE_TEST],
    ["a side-effect import of vitest", 'import "vitest";\n', PROBE_TEST],
    ["a re-export from vitest", 'export { it } from "vitest";\n', PROBE_TEST],
    [
      "vitest beside describe, it and expect",
      'import { describe, it, vi } from "vitest";\nexport const x = [describe, it, vi];\n',
      PROBE_TEST,
    ],
    ["vitest from a non-test file", 'import { it } from "vitest";\nexport const x = it;\n'],
    ["this in a function declaration", "export function f() { return this; }\n"],
    ["this in an object method", "export const o = { m() { return this; } };\n"],
    ["this at module level", "export const t = this;\n"],
    ["this in a top-level arrow", "export const a = () => this;\n"],
    [
      "this in a function expression inside a method",
      "export class A { m() { return function () { return this; }; } }\n",
    ],
    ["a local name exported that is a global off the list", "export { Intl };\n"],
    ["a renamed global off the list exported", "export { Int8Array as bytes };\n"],
    ["a name that resolves to nothing exported", "export { nowhere };\n"],
  ];
  for (const [name, source, file] of FIRE) {
    it(`finds ${name}`, () => {
      expect(findings(file ?? PROBE, source).length, source).toBeGreaterThan(0);
    });
  }

  it("is quiet for ordinary domain code", () => {
    const quiet = [
      'import type { NoteId } from "@ccc/domain";',
      'import { SUMMARISER_INSTRUCTIONS as helper } from "./instructions.js";',
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
      'export const fresh = new Error("x");',
      'export const called = Error("y");',
      'export const re = new RegExp("a", "u");',
      "export const isErr = (value: unknown): boolean => value instanceof Error || value instanceof RegExp;",
      "export class Probe { readonly me = this; m() { return () => this; } get g() { return this; } static s = 1; }",
      "const own = { a: 1 }; own.a = 2; own.a += 1; own.a++; Object.assign(own, { b: 1 }); Object.freeze(own);",
      "let counter = 0; counter++; counter += 1;",
      'export const named = fresh.name === "x" ? 1 : 2;',
      "export { total as renamedTotal };",
      "",
    ].join("\n");
    expect(findings(join(FOLDER, "quiet.ts"), quiet)).toEqual([]);
  });

  it("is quiet for a test file importing describe, it and expect from vitest", () => {
    const quiet = [
      'import { describe, expect, it } from "vitest";',
      'import { SUMMARISER_INSTRUCTIONS } from "./instructions.js";',
      'describe("x", () => { it("y", () => { expect(SUMMARISER_INSTRUCTIONS).toBeDefined(); }); });',
      "",
    ].join("\n");
    expect(findings(join(FOLDER, "quiet.test.ts"), quiet)).toEqual([]);
  });

  it("rejects an unexpected file in the folder (extension, declaration file, symlink)", () => {
    for (const name of [
      "a.js",
      "a.mjs",
      "a.d.ts",
      "a.mts",
      "a.cts",
      "a.tsx",
      "a.json",
      "a.map",
      "a",
    ]) {
      expect(fileProblem(join(FOLDER, name)), name).not.toBeNull();
    }
    for (const name of ["a.ts", "a.test.ts", "tsconfig.json"]) {
      expect(fileProblem(join(FOLDER, name)), name).toBeNull();
    }
  });
});
