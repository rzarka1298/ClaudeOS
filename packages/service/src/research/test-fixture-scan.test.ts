import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source scan (plan 07-14 Task 3, Tests 1 and 2; D-04, D-27, research Pitfall 15, T-07-34): the
 * research test variables are read in exactly one module, the installed service's environment
 * never names them, and the Anthropic key is confined to the composition root. Mirrors the
 * approval override scan.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const GUARD_MODULE = join(HERE, "test-fixture-guard.ts");
const MAIN = join(HERE, "..", "main.ts");

const FLAG = "CCC_ENABLE_TEST_OVERRIDES";
const VARIABLES = [
  "CCC_RESEARCH_TEST_FIXTURE_DIR",
  "CCC_RESEARCH_TEST_SUMMARISER",
  "CCC_RESEARCH_KEY_ACCOUNT",
] as const;

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
    try {
      walk(join(REPO, "packages", pkg, "src"), files);
    } catch {
      // a package without a src folder
    }
  }
  files.push(...walk(join(REPO, "scripts")));
  return files.filter((file) => /\.(ts|tsx|mjs|js|sh|template|plist)$/.test(file));
}

const isTest = (file: string): boolean => /\.test\.|\.int\.test\.|test-support|harness/.test(file);

const codeOf = (file: string): string =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

describe("the research test variables are confined to their guard (Test 2)", () => {
  const files = sourceFiles();

  for (const variable of VARIABLES) {
    it(`names ${variable} in exactly one non-test source file, the guard module`, () => {
      const hits = files
        .filter((file) => !isTest(file))
        .filter((file) => readFileSync(file, "utf8").includes(variable))
        .map((file) => relative(REPO, file));
      expect(hits).toEqual(["packages/service/src/research/test-fixture-guard.ts"]);
    });

    it(`reads ${variable} exactly once in the guard's code`, () => {
      expect(codeOf(GUARD_MODULE).match(new RegExp(variable, "g"))).toHaveLength(1);
    });
  }

  it("reads the enabling flag exactly once in the guard's code", () => {
    expect(codeOf(GUARD_MODULE).match(new RegExp(FLAG, "g"))).toHaveLength(1);
  });

  it("names none of the variables or the flag in any LaunchAgent installer file", () => {
    const installers = files.filter((file) => /launchagent/i.test(file));
    expect(installers.length).toBeGreaterThan(0);
    for (const file of installers) {
      const text = readFileSync(file, "utf8");
      for (const name of [...VARIABLES, FLAG]) expect(text, `${file} ${name}`).not.toContain(name);
    }
  });

  it("is imported by the composition root alone", () => {
    const importers = files
      .filter((file) => !isTest(file) && /\.(ts|tsx)$/.test(file) && file !== GUARD_MODULE)
      .filter((file) => /test-fixture-guard/.test(readFileSync(file, "utf8")))
      .map((file) => relative(REPO, file));
    expect(importers).toEqual(["packages/service/src/main.ts"]);
  });

  it("adds no plain-HTTP or loopback allowance to the production fetcher", () => {
    const fetchDir = join(HERE, "fetch");
    for (const file of walk(fetchDir).filter((name) => !isTest(name) && name.endsWith(".ts"))) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/\bCCC_[A-Z_]+/);
    }
  });
});

describe("the Anthropic key is read only at the composition root (Test 1)", () => {
  const serviceSrc = join(HERE, "..");
  const files = walk(serviceSrc).filter((file) => /\.(ts|tsx)$/.test(file) && !isTest(file));

  it("imports @ccc/keychain only in main.ts and the install-secret type import", () => {
    const importers = files
      .filter((file) => /from "@ccc\/keychain"/.test(readFileSync(file, "utf8")))
      .map((file) => relative(serviceSrc, file))
      .sort();
    expect(importers).toEqual(["auth/install-secret.ts", "main.ts"]);
  });

  it("has no module under research or untrusted that imports the keychain package or a secret store", () => {
    for (const file of files.filter((name) => /\/(research|untrusted)\//.test(name))) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/@ccc\/keychain|SecretStore|secretStore|security-cli/);
    }
  });

  it("hands the research wiring a closure, never a key string", () => {
    const main = codeOf(MAIN);
    expect(main).toContain("readApiKey: () => secretStore.get(researchKeyAccount)");
    expect(main.match(/secretStore\.get\(/g)?.length).toBeLessThanOrEqual(1);
    const transportSource = codeOf(join(HERE, "anthropic-transport.ts"));
    expect(transportSource).toContain("readApiKey: () => Promise<string | null>");
  });
});
