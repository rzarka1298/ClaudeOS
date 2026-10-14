// The package is pure: no module may reach Node, a process global, the network or a CommonJS loader
// (D-08, RSRCH-08). The scan reads the syntax tree, so a comment or a string that merely
// mentions a word does not trip it, and an identifier that does cannot hide in one.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out.sort();
}

const BANNED_IDENTIFIERS = new Set(["process", "fetch", "require"]);
const BUILTINS = new Set(builtinModules);

function findings(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
  );
  const out: string[] = [];
  const checkSpecifier = (specifier: string, at: ts.Node): void => {
    const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
    if (specifier.startsWith("node:") || BUILTINS.has(bare)) {
      out.push(
        `${file}: imports ${specifier} at ${source.getLineAndCharacterOfPosition(at.getStart()).line + 1}`,
      );
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      checkSpecifier(node.moduleSpecifier.text, node);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      out.push(
        `${file}: dynamic import() at ${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
      );
    }
    if (ts.isIdentifier(node) && BANNED_IDENTIFIERS.has(node.text)) {
      out.push(
        `${file}: identifier ${node.text} at ${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe("Test 3 (source scan): the research package stays pure", () => {
  const files = sourceFiles(SRC);

  it("scans the real source files", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.map((f) => f.slice(SRC.length + 1))).toContain("feed.ts");
  });

  it("has no node: import, no process or fetch or require identifier and no dynamic import", () => {
    expect(files.flatMap(findings)).toEqual([]);
  });

  it("the scanner itself flags each banned form (it is not vacuous)", () => {
    const probe = (code: string): number => {
      const source = ts.createSourceFile("probe.ts", code, ts.ScriptTarget.ES2022, true);
      let n = 0;
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && BANNED_IDENTIFIERS.has(node.text)) n += 1;
        ts.forEachChild(node, visit);
      };
      visit(source);
      return n;
    };
    expect(probe("const a = process.env;")).toBe(1);
    expect(probe("await fetch(x);")).toBe(1);
    expect(probe("const m = require(x);")).toBe(1);
    expect(probe("// process fetch( require(\nconst s = 'process';")).toBe(0);
  });
});
