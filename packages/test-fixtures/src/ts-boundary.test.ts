// Layer 2 of the three-layer boundary gate (ADR-0019, D-03, T-06-31): the
// approval and executors folders are nested composite TypeScript projects that
// reference only the domain package, so a relative import out of the folder
// fails the COMPILER, not only the lint. This file proves the mechanism on a
// pair of fixture projects (violating and clean), checks the structure of the
// real nested configs, and asserts the built layout the runtime depends on.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
function runTsc(projectDir: string): TscResult {
  try {
    const out = execFileSync(TSC_BIN, ["-p", projectDir, "--noEmit", "--pretty", "false"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return { exitCode: 0, output: out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
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

describe("real nested approval and executors projects", () => {
  for (const folder of ["approval", "executors"] as const) {
    const configPath = join(SERVICE_DIR, "src", folder, "tsconfig.json");

    test(`${folder}/tsconfig.json is composite, rooted at its folder and writes to dist/${folder}`, () => {
      expect(existsSync(configPath)).toBe(true);
      const config = readTsConfig(configPath);
      expect(config.extends).toBe("../../../../tsconfig.base.json");
      expect(config.compilerOptions?.composite).toBe(true);
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
