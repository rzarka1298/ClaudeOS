// Wave 1+2 test audit for plan 07-02 (the untrusted summariser boundary). The executor's tests
// prove each layer fires; this file adds what they leave WEAK or UNTESTED:
//
//   - a mutation proof that backstop rule 17 is the only thing keeping the ES2022 names out of the
//     folder: with the rule removed from a copy of the script, every planted violation passes;
//   - the compensating control for third-party packages (the eslint element only knows workspace
//     packages), shown by compiling an import of a package whose declarations pull Node's types in;
//   - ADR-0014's "Phase 7 enforcement" section against the files and names it cites (SC4);
//   - a known hole in the shared comment-line skip, committed skipped with its finding.
//
// Pure ASCII source by design.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type GateRepo, gateRepo, REPO_ROOT } from "./gate-repo.js";

const SCRIPT = "scripts/check-boundaries.sh";
const PROBE = "packages/service/src/untrusted/probe.ts";
const CLEAN = { "packages/domain/src/index.ts": "export const answer = 42;\n" };
const RULE17 = "names an I/O primitive";

const repos: GateRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.dispose();
});

/** Runs the backstop over a throwaway repo holding `source` as the probe, optionally with a replaced script. */
function gate(source: string, script?: string) {
  const repo = gateRepo([SCRIPT], { ...CLEAN, [PROBE]: source });
  repos.push(repo);
  if (script !== undefined) repo.write(SCRIPT, script);
  return repo.run(SCRIPT);
}

/** The real script with the whole rule 17 block cut out, up to the closing count lines. */
function scriptWithoutRule17(): string {
  const script = readFileSync(join(REPO_ROOT, SCRIPT), "utf8");
  const start = script.indexOf("# --- Rule 17:");
  const end = script.indexOf("FILE_COUNT=$(", start);
  expect(start, "rule 17 block start").toBeGreaterThan(-1);
  expect(end, "rule 17 block end").toBeGreaterThan(start);
  return script.slice(0, start) + script.slice(end);
}

// One planted violation per name rule 17 lists (07-02 truth 3), written without the identifiers
// being tokens of this file's own code.
const EVERY_NAME: ReadonlyArray<readonly [name: string, source: string]> = [
  ["node: specifier", 'import "node:fs";\n'],
  ["child_process", 'import { spawn } from "child_process";\n'],
  ["fetch(", "export const a = fetch(u);\n"],
  ["require(", 'export const b = require("x");\n'],
  ["dynamic import(", "export const c = await import(spec);\n"],
  ["process", "export const d = process.env.X;\n"],
  ["globalThis", "export const e = globalThis.fetch;\n"],
  ["eval(", 'export const f = eval("1");\n'],
  ["Function(", 'export const g = new Function("return 1");\n'],
  ["Reflect", 'export const h = Reflect.get(o, "k");\n'],
  ["XMLHttpRequest", "export const i = new XMLHttpRequest();\n"],
  ["WebSocket", "export const j = new WebSocket(u);\n"],
  ["EventSource", "export const k = new EventSource(u);\n"],
  ["a .constructor( call", 'export const l = (() => 1).constructor("return 1")();\n'],
];

describe("07-02 truth 3 (backstop): each planted name is caught by rule 17 and by nothing else", () => {
  const without = scriptWithoutRule17();

  it("the cut copy of the script still runs and counts one rule fewer", () => {
    const result = gate("export const ok = 1;\n", without);
    expect(result.status).toBe(0);
    expect(result.out).toContain("checked 16 rules");
  });

  for (const [name, source] of EVERY_NAME) {
    it(`${name}: the gate fails with rule 17, and passes once rule 17 is removed`, () => {
      const real = gate(source);
      expect(real.status).toBe(1);
      expect(real.out).toContain(RULE17);
      const mutated = gate(source, without);
      expect(mutated.status, `${name} must be caught by rule 17 alone`).toBe(0);
      expect(mutated.out).not.toContain(RULE17);
    });
  }
});

describe("07-02 truth 4 (three layers): third-party packages and the compensating control", () => {
  const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
  // Assembled at runtime so this file does not itself import the native binding, which backstop
  // rule 3 forbids outside packages/service and packages/operational-store.
  const NATIVE_DB = ["better", "sqlite3"].join("-");
  const NATIVE_DB_TYPES = join(
    REPO_ROOT,
    "packages",
    "service",
    "node_modules",
    "@types",
    NATIVE_DB,
  );

  it("an import of a package whose declarations reference Node's types compiles in a types-free project, but puts @types/node in the program", () => {
    if (!existsSync(NATIVE_DB_TYPES)) return;
    const dir = mkdtempSync(join(tmpdir(), "ccc-untrusted-third-party-"));
    try {
      writeFileSync(
        join(dir, "index.ts"),
        `import Database from "${NATIVE_DB}";\nexport const opened: unknown = new Database("x.db");\n`,
      );
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          extends: join(REPO_ROOT, "tsconfig.base.json"),
          compilerOptions: {
            composite: true,
            rootDir: ".",
            outDir: "dist",
            noEmit: true,
            types: [],
            paths: { [NATIVE_DB]: [NATIVE_DB_TYPES] },
          },
          files: ["index.ts"],
        }),
      );
      const output = execFileSync(
        TSC_BIN,
        ["-p", dir, "--noEmit", "--pretty", "false", "--listFiles"],
        { cwd: REPO_ROOT, encoding: "utf8" },
      );
      // The compiler layer alone does not refuse the import (no diagnostic) ...
      expect(output).not.toContain("error TS");
      // ... so the control that keeps the real folder honest is the listFiles check in
      // ts-boundary.test.ts, which fails as soon as a Node typing enters the program.
      expect(
        output.split("\n").filter((line) => line.includes("@types/node")).length,
      ).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // FINDING (audit, 07-02 truth 3, MAJOR): grep_noncomment treats every line whose first
  // non-blank characters are slash-star as a comment line, so a block comment opener followed by
  // code on the same line hides the whole line from every rule that uses it, rule 17 included. A
  // planted globalThis access behind a one-line comment passes the gate. Fix: strip a leading
  // closed block comment from the line before the comment test, or treat only lines that begin a
  // comment AND do not close it before more code as comments.
  it.skip("fires on a name that follows a block comment on the same line", () => {
    const result = gate("/* note */ export const g = globalThis.fetch;\n");
    expect(result.status).toBe(1);
    expect(result.out).toContain(RULE17);
  });

  it("stays quiet for a line that is only a closed block comment (control for the case above)", () => {
    const result = gate("/* globalThis eval( process */\nexport const ok = 1;\n");
    expect(result.status).toBe(0);
  });
});

describe("07-02 truth 7: ADR-0014 records the three layers and their fire-proving fixtures", () => {
  const adr = readFileSync(
    join(REPO_ROOT, "docs", "adr", "0014-untrusted-content-boundary.md"),
    "utf8",
  );
  const script = readFileSync(join(REPO_ROOT, SCRIPT), "utf8");
  const section = adr.slice(adr.indexOf("## Phase 7 enforcement"));

  it("has the section and names all three layers", () => {
    expect(adr).toContain("## Phase 7 enforcement");
    expect(section).toContain("eslint `untrusted` element");
    expect(section).toContain("`types: []`");
    expect(section).toContain("backstop rule 17");
  });

  it("cites only test files and fixtures that exist", () => {
    const testFixtures = join(REPO_ROOT, "packages", "test-fixtures");
    for (const file of [
      "src/boundary-lint.test.ts",
      "src/ts-boundary.test.ts",
      "src/check-boundaries-rules.test.ts",
      "src/phase051-wiring.audit.test.ts",
      "boundary-violations/untrusted/untrusted-imports-adapter.ts",
      "ts-boundary-violations/untrusted-shaped/index.ts",
      "ts-boundary-violations/untrusted-shaped-clean/index.ts",
    ]) {
      expect(existsSync(join(testFixtures, file)), file).toBe(true);
    }
    for (const cited of [
      "boundary-lint.test.ts",
      "ts-boundary.test.ts",
      "check-boundaries-rules.test.ts",
      "phase051-wiring.audit.test.ts",
      "boundary-violations/untrusted/untrusted-imports-adapter.ts",
      "ts-boundary-violations/untrusted-shaped",
      "untrusted-shaped-clean",
    ]) {
      expect(section, cited).toContain(cited);
    }
  });

  it("lists every name the script's rule 17 pattern contains, and quotes its description", () => {
    const block = script.slice(script.indexOf("# --- Rule 17:"), script.indexOf("FILE_COUNT=$("));
    for (const name of [
      "node:",
      "child_process",
      "fetch",
      "require",
      "import",
      "process",
      "globalThis",
      "eval",
      "Function",
      "Reflect",
      "XMLHttpRequest",
      "WebSocket",
      "EventSource",
    ]) {
      expect(block, `script: ${name}`).toContain(name);
      expect(section, `ADR: ${name}`).toContain(name);
    }
    expect(section).toContain(
      "a non-test file under packages/service/src/untrusted/ names an I/O primitive",
    );
    expect(script).toContain(
      "a non-test file under packages/service/src/untrusted/ names an I/O primitive",
    );
  });

  it("states the limit that no layer addresses (stylesheet-hidden text) and where it is handled", () => {
    expect(section).toContain("stylesheet");
    expect(section).toContain("delimiter");
    expect(section).toContain("no-tools port");
  });
});
