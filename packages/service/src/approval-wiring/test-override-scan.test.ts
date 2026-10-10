import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source scan (plan 06-21 Task 3, Test 6, D-10, D-46, T-06-34): the test-only
 * approval lifetime override is a guarded one-function lever. Its variable name
 * appears in no source file except the one module that owns the guard, and no
 * other source reads an environment value that shortens an approval lifetime.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const GUARD_MODULE = join(HERE, "services.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const pkg of readdirSync(join(REPO, "packages"))) {
    const src = join(REPO, "packages", pkg, "src");
    try {
      walk(src, files);
    } catch {
      // a package without a src folder
    }
  }
  files.push(...walk(join(REPO, "scripts")));
  return files.filter((file) => /\.(ts|tsx|mjs|js|sh|template|plist)$/.test(file));
}

const isTest = (file: string): boolean => /\.test\.|\.int\.test\.|test-support|harness/.test(file);

describe("the test-lifetime override is confined to its guard (Task 3, Test 6)", () => {
  const files = sourceFiles();

  it("names CCC_APPROVAL_TEST_TTL_MS in no non-test file except the guard module", () => {
    const hits = files
      .filter((file) => !isTest(file) && file !== GUARD_MODULE)
      .filter((file) => readFileSync(file, "utf8").includes("CCC_APPROVAL_TEST_TTL_MS"))
      .map((file) => relative(REPO, file));
    expect(hits).toEqual([]);
  });

  it("reads the variable and the enabling flag exactly once each, in the guard module", () => {
    const source = readFileSync(GUARD_MODULE, "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(code.match(/CCC_APPROVAL_TEST_TTL_MS/g)).toHaveLength(1);
    expect(code.match(/CCC_ENABLE_TEST_OVERRIDES/g)).toHaveLength(1);
  });

  it("never names the override in the installed service's environment", () => {
    const installers = files.filter((file) => /launchagent/.test(file));
    expect(installers.length).toBeGreaterThan(0);
    for (const file of installers) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain("CCC_APPROVAL_TEST_TTL_MS");
      expect(text).not.toContain("CCC_ENABLE_TEST_OVERRIDES");
    }
  });

  it("finds no other environment read that shortens an approval lifetime", () => {
    const hits = files
      .filter((file) => !isTest(file) && file !== GUARD_MODULE && /\.(ts|tsx)$/.test(file))
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return /env\.CCC_[A-Z_]*(TTL|LIFETIME|EXPIR)[A-Z_]*/.test(text);
      })
      .map((file) => relative(REPO, file));
    expect(hits).toEqual([]);
  });

  it("lets only the engine and the guard module set a requested lifetime", () => {
    const hits = files
      .filter((file) => !isTest(file) && /\.(ts|tsx)$/.test(file))
      .filter((file) => readFileSync(file, "utf8").includes("requestedTtlMs"))
      .map((file) => relative(REPO, file))
      .sort();
    expect(hits).toEqual([
      "packages/service/src/approval-wiring/services.ts",
      "packages/service/src/approval/engine.ts",
    ]);
  });
});
