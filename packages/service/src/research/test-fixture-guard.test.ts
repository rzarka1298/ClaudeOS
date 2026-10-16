import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResearchOverrideError } from "./override-error.js";
import { type OverrideLog, resolveResearchTestOverrides } from "./test-fixture-guard.js";

/**
 * Plan 07-14 Task 3, Tests 2 and 3 (D-27, research Pitfall 15, T-07-34): the guard returns no
 * overrides unless the one enabling flag is exactly `1`, returns only what each variable asks for,
 * and refuses a bad value at startup with a code-only log line that never quotes the value.
 */

const FLAG = "CCC_ENABLE_TEST_OVERRIDES";
const FIXTURE_DIR = "CCC_RESEARCH_TEST_FIXTURE_DIR";
const SUMMARISER = "CCC_RESEARCH_TEST_SUMMARISER";
const KEY_ACCOUNT = "CCC_RESEARCH_KEY_ACCOUNT";

let dir: string;
let logs: { level: string; fields: Record<string, unknown> }[];
const log: OverrideLog = {
  warn: (fields) => logs.push({ level: "warn", fields }),
  error: (fields) => logs.push({ level: "error", fields }),
};

beforeEach(() => {
  mkdirSync(join(homedir(), ".ccc-test"), { recursive: true });
  dir = mkdtempSync(join(homedir(), ".ccc-test", "guard-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ entries: [{ url: "https://a.example.invalid/x", failure: "timeout" }] }),
  );
  logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ALL = (): NodeJS.ProcessEnv => ({
  [FIXTURE_DIR]: dir,
  [SUMMARISER]: "extractive",
  [KEY_ACCOUNT]: "research-key-test-account",
});

describe("without the enabling flag nothing is overridden", () => {
  for (const flag of [undefined, "", "0", "true", "yes", "01", " 1", "1 "]) {
    it(`returns nothing for the flag ${JSON.stringify(flag)} even with every variable set`, () => {
      const env = { ...ALL(), ...(flag === undefined ? {} : { [FLAG]: flag }) };
      expect(resolveResearchTestOverrides(env, log)).toEqual({});
      // The ignored variables are reported by code only, never by value.
      expect(logs).toEqual([{ level: "warn", fields: { code: "research-test-override-ignored" } }]);
    });
  }

  it("is silent when no variable is set at all", () => {
    expect(resolveResearchTestOverrides({}, log)).toEqual({});
    expect(logs).toEqual([]);
  });
});

describe("with the flag set it returns only what each variable asks for", () => {
  it("returns the fixture fetcher alone for the fixture directory", () => {
    const result = resolveResearchTestOverrides({ [FLAG]: "1", [FIXTURE_DIR]: dir }, log);
    expect(Object.keys(result)).toEqual(["fetcher"]);
    expect(typeof result.fetcher?.fetchSources).toBe("function");
  });

  it("returns the extractive transport alone for the summariser variable", () => {
    const result = resolveResearchTestOverrides({ [FLAG]: "1", [SUMMARISER]: "extractive" }, log);
    expect(Object.keys(result)).toEqual(["transport"]);
    expect(typeof result.transport?.complete).toBe("function");
  });

  it("returns the test key account alone for the account variable", () => {
    const result = resolveResearchTestOverrides(
      { [FLAG]: "1", [KEY_ACCOUNT]: "research-key-test-account" },
      log,
    );
    expect(result).toEqual({ keyAccount: "research-key-test-account" });
  });

  it("returns all three together and says so by code", () => {
    const result = resolveResearchTestOverrides({ ...ALL(), [FLAG]: "1" }, log);
    expect(Object.keys(result).sort()).toEqual(["fetcher", "keyAccount", "transport"]);
    expect(logs).toEqual([{ level: "warn", fields: { code: "research-test-overrides-active" } }]);
  });

  it("returns nothing when the flag is set and no variable is", () => {
    expect(resolveResearchTestOverrides({ [FLAG]: "1" }, log)).toEqual({});
    expect(logs).toEqual([]);
  });
});

describe("a bad value is refused at startup with a code-only log line", () => {
  const HOSTILE = "extractive; echo SECRET_VALUE_9137 $(id)";

  it("refuses an unknown summariser and never logs its value", () => {
    for (const value of ["live", "anthropic", "", HOSTILE]) {
      logs = [];
      expect(() => resolveResearchTestOverrides({ [FLAG]: "1", [SUMMARISER]: value }, log)).toThrow(
        ResearchOverrideError,
      );
      expect(logs).toEqual([
        { level: "error", fields: { code: "research-test-override-unknown-summariser" } },
      ]);
      expect(JSON.stringify(logs)).not.toContain("SECRET_VALUE_9137");
    }
  });

  it("refuses a key account outside the keychain alphabet", () => {
    for (const value of ["", "a b", "../x", `x${"y".repeat(80)}`, "acc;rm", "café"]) {
      logs = [];
      expect(() =>
        resolveResearchTestOverrides({ [FLAG]: "1", [KEY_ACCOUNT]: value }, log),
      ).toThrow(ResearchOverrideError);
      expect(logs[0]?.fields).toEqual({ code: "research-test-override-invalid-key-account" });
    }
  });

  it("refuses a fixture directory that is relative, missing or without a usable manifest", () => {
    const missing = join(dir, "no-such-dir");
    const noManifest = mkdtempSync(join(dir, "empty-"));
    const badManifest = mkdtempSync(join(dir, "bad-"));
    writeFileSync(join(badManifest, "manifest.json"), "{ not json");
    for (const value of ["relative/dir", missing, noManifest, badManifest]) {
      logs = [];
      expect(() =>
        resolveResearchTestOverrides({ [FLAG]: "1", [FIXTURE_DIR]: value }, log),
      ).toThrow(ResearchOverrideError);
      expect(logs).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain(dir);
    }
  });

  it("the thrown message is constant and quotes no value", () => {
    try {
      resolveResearchTestOverrides({ [FLAG]: "1", [SUMMARISER]: HOSTILE }, log);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ResearchOverrideError);
      expect((error as Error).message).toBe("research test override refused: unknown-summariser");
    }
  });
});
