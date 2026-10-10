import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Wave 8 test audit (plan 05.1-29 truth 7): the composed-service tests, their support modules and
 * the real-process tests name no owner machine state. The canary checks its own text only; this
 * covers every file the plan added. Patterns are assembled from fragments so this file is clean.
 */

const packages = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILES = [
  "service/src/codex/composition.int.test.ts",
  "service/src/codex/credential-canary.int.test.ts",
  "service/src/test-support/fake-codex.ts",
  "service/src/test-support/fs-recorder.ts",
  "service/src/test-support/codex-launch-context.ts",
  "test-fixtures/src/codex-sessions.int.test.ts",
  "test-fixtures/src/codex-real-process-support.ts",
  "test-fixtures/src/codex-contract.audit.test.ts",
];
const part = (...pieces: string[]): string => pieces.join("");

const HOME_PATH = new RegExp(`${part("/Us", "ers/")}(?!USERNAME|<)[A-Za-z0-9._-]+`);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;
const REAL_CODEX_DIR = new RegExp(`["'/~]${part("\\.co", "dex")}(["'/]|$)`);
const CREDENTIAL_LITERAL = new RegExp(part("auth", "\\.", "json"));
const CONFIG_LITERAL = new RegExp(part("config", "\\.", "toml"));
const RAW_CODEX_SPAWN = new RegExp(
  `(spawn|spawnSync|exec|execFile|execFileSync|execa)\\(\\s*["']${part("cod", "ex")}["']`,
);

describe("the plan 05.1-29 tests name no owner machine state and run no raw codex", () => {
  for (const file of FILES) {
    it(`${file} is clean`, () => {
      const path = join(packages, file);
      expect(existsSync(path), `${file} exists`).toBe(true);
      const code = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n");
      expect(HOME_PATH.test(code), "a real home path").toBe(false);
      expect(EMAIL.test(code), "an email").toBe(false);
      expect(REAL_CODEX_DIR.test(code), "a Codex home directory literal").toBe(false);
      expect(CREDENTIAL_LITERAL.test(code), "a credential file literal").toBe(false);
      expect(CONFIG_LITERAL.test(code), "a configuration file literal").toBe(false);
      expect(RAW_CODEX_SPAWN.test(code), "a raw codex spawn").toBe(false);
    });
  }

  it("the patterns can fail (they flag crafted violations)", () => {
    expect(HOME_PATH.test(`${part("/Us", "ers/")}someone/repo`)).toBe(true);
    expect(HOME_PATH.test(`${part("/Us", "ers/")}USERNAME/repo`)).toBe(false);
    expect(EMAIL.test("a@b.example")).toBe(true);
    expect(REAL_CODEX_DIR.test(`"~/${part(".co", "dex")}/x"`)).toBe(true);
    expect(CREDENTIAL_LITERAL.test(part("auth", ".", "json"))).toBe(true);
    expect(RAW_CODEX_SPAWN.test(`spawn("${part("cod", "ex")}", [])`)).toBe(true);
  });
});
