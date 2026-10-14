// Layer 2 of the three-layer boundary gate (ADR-0019, D-03, T-06-31): the
// approval and executors folders are nested composite TypeScript projects that
// reference only the domain package, so a relative import out of the folder
// fails the COMPILER, not only the lint. This file proves the mechanism on a
// pair of fixture projects (violating and clean), checks the structure of the
// real nested configs, and asserts the built layout the runtime depends on.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const FIXTURES = join(REPO_ROOT, "packages", "test-fixtures", "ts-boundary-violations");
const SERVICE_DIR = join(REPO_ROOT, "packages", "service");

interface TscResult {
  readonly exitCode: number;
  readonly output: string;
}

/** Runs the compiler on one project without emitting, returning its output
 * whatever the exit status (tsc exits non-zero on a diagnostic). */
function runTsc(projectDir: string, extraArgs: readonly string[] = []): TscResult {
  try {
    const out = execFileSync(
      TSC_BIN,
      ["-p", projectDir, "--noEmit", "--pretty", "false", ...extraArgs],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
      },
    );
    return { exitCode: 0, output: out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** The base tsconfig, used to compile an inline source in a throwaway project
 * with exactly the untrusted configuration (types empty, no references). */
const TSCONFIG_BASE = join(REPO_ROOT, "tsconfig.base.json");

/** Compiles one inline source string as a `types: []` project and returns the
 * compiler output. The throwaway folder is removed whatever the outcome. */
function runTscOnInlineSource(source: string): TscResult {
  const dir = mkdtempSync(join(tmpdir(), "ccc-untrusted-probe-"));
  try {
    writeFileSync(join(dir, "index.ts"), source);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: TSCONFIG_BASE,
        compilerOptions: { composite: true, rootDir: ".", outDir: "dist", noEmit: true, types: [] },
        files: ["index.ts"],
      }),
    );
    return runTsc(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface TsConfigShape {
  readonly extends?: string;
  readonly compilerOptions?: Record<string, unknown>;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly references?: ReadonlyArray<{ readonly path: string }>;
}

function readTsConfig(path: string): TsConfigShape {
  return JSON.parse(readFileSync(path, "utf8")) as TsConfigShape;
}

describe("nested composite project mechanism (fixtures)", () => {
  test("a relative import out of the project's file list fails the compiler with TS6307", () => {
    const result = runTsc(join(FIXTURES, "approval-shaped"));
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("TS6307");
  });

  test("the clean fixture project compiles with no output", () => {
    const result = runTsc(join(FIXTURES, "approval-shaped-clean"));
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe("");
  });
});

describe("untrusted folder: compiler layer (ADR-0014, D-01, D-02)", () => {
  // Each forbidden name below is on its own line of the fire fixture, so the
  // compiler must report exactly one diagnostic per name. The codes are what
  // TypeScript 6 reports for an unknown global (TS2304) and for an unknown
  // Node global or module specifier when no Node types are loaded (TS2591).
  const FORBIDDEN: ReadonlyArray<{ readonly name: string; readonly code: "TS2304" | "TS2591" }> = [
    { name: "fetch", code: "TS2304" },
    { name: "process", code: "TS2591" },
    { name: "require", code: "TS2591" },
    { name: "setTimeout", code: "TS2304" },
    { name: "node:fs", code: "TS2591" },
    { name: "child_process", code: "TS2591" },
  ];

  test("the fire fixture reports one diagnostic for each I/O name it uses", () => {
    const result = runTsc(join(FIXTURES, "untrusted-shaped"));
    expect(result.exitCode).not.toBe(0);
    for (const { name, code } of FORBIDDEN) {
      const matching = result.output
        .split("\n")
        .filter((line) => line.includes(`error ${code}: Cannot find name '${name}'`));
      expect(matching, `${name} should produce exactly one ${code} diagnostic`).toHaveLength(1);
    }
    const diagnostics = result.output.split("\n").filter((line) => line.includes(": error TS"));
    expect(diagnostics).toHaveLength(FORBIDDEN.length);
  });

  test("the clean twin imports a domain type and compiles with no output, so domain's declarations bring no Node types in", () => {
    const result = runTsc(join(FIXTURES, "untrusted-shaped-clean"), ["--listFiles"]);
    expect(result.exitCode).toBe(0);
    const files = result.output.split("\n").filter((line) => line.trim() !== "");
    // The domain declarations were really part of the program ...
    expect(files.some((f) => f.endsWith("/packages/domain/dist/index.d.ts"))).toBe(true);
    // ... and nothing pulled the Node typings in behind them.
    expect(files.filter((f) => f.includes("@types/node"))).toEqual([]);
    expect(files.filter((f) => f.includes("error TS"))).toEqual([]);
  });

  test("the real untrusted project's program contains no Node typings", () => {
    const result = runTsc(join(SERVICE_DIR, "src", "untrusted"), ["--listFiles"]);
    expect(result.exitCode).toBe(0);
    const files = result.output.split("\n").filter((line) => line.trim() !== "");
    expect(files.filter((f) => f.includes("@types/node"))).toEqual([]);
  });

  test("known limit of this layer: globalThis access, eval, Function, Reflect and a computed dynamic import still compile; the backstop rule is the layer that catches them", () => {
    const probe = [
      'export const viaGlobal = (globalThis as Record<string, unknown>)["fetch"];',
      'export const viaEval: unknown = eval("1");',
      'export const viaFunction: unknown = new Function("return 1")();',
      'export const viaReflect: unknown = Reflect.get({}, "k");',
      "export async function viaImport(specifier: string): Promise<unknown> {",
      "  return await import(specifier);",
      "}",
      "",
    ].join("\n");
    const result = runTscOnInlineSource(probe);
    expect(result.output.trim()).toBe("");
    expect(result.exitCode).toBe(0);
    // These names are caught by the untrusted-folder rule in
    // scripts/check-boundaries.sh, proven in check-boundaries-rules.test.ts.
    // Never read this test as saying the compiler alone keeps I/O out of the
    // folder.
  });

  test("the real nested config is types-free, references only domain, and is wired into the service project", () => {
    const config = readTsConfig(join(SERVICE_DIR, "src", "untrusted", "tsconfig.json"));
    expect(config.extends).toBe("../../../../tsconfig.base.json");
    expect(config.compilerOptions?.["types"]).toEqual([]);
    expect(config.compilerOptions?.composite).toBe(true);
    expect(config.compilerOptions?.outDir).toBe("../../dist/untrusted");
    expect(config.references).toEqual([{ path: "../../../domain" }]);
    const service = readTsConfig(join(SERVICE_DIR, "tsconfig.json"));
    expect(service.exclude).toContain("src/untrusted");
    expect((service.references ?? []).map((r) => r.path)).toContain("./src/untrusted");
  });
});

describe("real nested approval and executors projects", () => {
  for (const folder of ["approval", "executors"] as const) {
    const configPath = join(SERVICE_DIR, "src", folder, "tsconfig.json");

    test(`${folder}/tsconfig.json is composite, rooted at its folder and writes to dist/${folder}`, () => {
      expect(existsSync(configPath)).toBe(true);
      const config = readTsConfig(configPath);
      expect(config.extends).toBe("../../../../tsconfig.base.json");
      expect(config.compilerOptions?.composite).toBe(true);
      // A violating build must not scatter emitted files outside the folder.
      expect(config.compilerOptions?.noEmitOnError).toBe(true);
      expect(config.compilerOptions?.rootDir).toBe(".");
      expect(config.compilerOptions?.outDir).toBe(`../../dist/${folder}`);
      expect(config.include).toEqual(["**/*.ts"]);
    });

    test(`${folder}/tsconfig.json references only the domain package`, () => {
      const config = readTsConfig(configPath);
      expect(config.references).toEqual([{ path: "../../../domain" }]);
    });
  }

  test("the service tsconfig excludes both folders and references both nested projects", () => {
    const config = readTsConfig(join(SERVICE_DIR, "tsconfig.json"));
    expect(config.exclude).toEqual(expect.arrayContaining(["src/approval", "src/executors"]));
    const refs = (config.references ?? []).map((r) => r.path);
    expect(refs).toEqual(expect.arrayContaining(["./src/approval", "./src/executors"]));
    // The package references that existed before this plan are kept.
    for (const kept of [
      "../collectors",
      "../domain",
      "../keychain",
      "../launchers",
      "../operational-store",
      "../vault-repo",
    ]) {
      expect(refs).toContain(kept);
    }
  });
});

describe("built layout (T-06-31)", () => {
  test("dist/approval/index.js and dist/executors/index.js exist and the approval entry imports", async () => {
    const approval = join(SERVICE_DIR, "dist", "approval", "index.js");
    const executors = join(SERVICE_DIR, "dist", "executors", "index.js");
    expect(existsSync(approval)).toBe(true);
    expect(existsSync(executors)).toBe(true);
    await expect(import(pathToFileURL(approval).href)).resolves.toBeDefined();
  });
});
