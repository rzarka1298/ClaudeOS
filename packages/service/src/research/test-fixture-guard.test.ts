import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResearchOverrideError } from "./override-error.js";
import {
  type OverrideLog,
  RESEARCH_TEST_ACCOUNT_PREFIX,
  type ResolveOverridesOptions,
  resolveResearchTestOverrides as resolveWith,
} from "./test-fixture-guard.js";

/**
 * Plan 07-14 Task 3, Tests 2 and 3 (D-27, research Pitfall 15, T-07-34): the guard returns no
 * overrides unless the one enabling flag is exactly `1`, returns only what each variable asks for,
 * and refuses a bad value at startup with a code-only log line that never quotes the value.
 */

const FLAG = "CCC_ENABLE_TEST_OVERRIDES";
const FIXTURE_DIR = "CCC_RESEARCH_TEST_FIXTURE_DIR";
const SUMMARISER = "CCC_RESEARCH_TEST_SUMMARISER";
const KEY_ACCOUNT = "CCC_RESEARCH_KEY_ACCOUNT";

/** The guard with a temporary runtime directory, as every test but the default-directory ones needs. */
function resolveResearchTestOverrides(
  env: NodeJS.ProcessEnv,
  log: OverrideLog,
  options: Partial<ResolveOverridesOptions> = {},
) {
  return resolveWith(env, log, { runtimeDir: join(dir, "runtime"), ...options });
}

const KEY_ACCOUNT_OK = "ccc-uat-research-key";

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
  [KEY_ACCOUNT]: KEY_ACCOUNT_OK,
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
      { [FLAG]: "1", [KEY_ACCOUNT]: KEY_ACCOUNT_OK },
      log,
    );
    expect(result).toEqual({ keyAccount: KEY_ACCOUNT_OK });
  });

  it("returns all three together and says so by code, naming which overrides are active", () => {
    const result = resolveResearchTestOverrides({ ...ALL(), [FLAG]: "1" }, log);
    expect(Object.keys(result).sort()).toEqual(["fetcher", "keyAccount", "transport"]);
    expect(logs).toEqual([
      {
        level: "warn",
        fields: {
          code: "research-test-overrides-active",
          overrides: ["fixture-fetcher", "extractive-summariser", "key-account"],
        },
      },
    ]);
  });

  it("names only the overrides that are on", () => {
    resolveResearchTestOverrides({ [FLAG]: "1", [SUMMARISER]: "extractive" }, log);
    expect(logs).toEqual([
      {
        level: "warn",
        fields: { code: "research-test-overrides-active", overrides: ["extractive-summariser"] },
      },
    ]);
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
    for (const value of [
      "",
      "a b",
      "../x",
      `x${"y".repeat(80)}`,
      "acc;rm",
      `caf${String.fromCodePoint(0xe9)}`,
    ]) {
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

describe("the key account is a test account, never one the service uses (wave 5, MAJOR-2, opus m6)", () => {
  it("pins the prefix to the one the end-to-end isolation guards define", () => {
    const source = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "e2e",
        "src",
        "isolation-guards.ts",
      ),
      "utf8",
    );
    const defined = /export const UAT_ACCOUNT_PREFIX = "([^"]+)";/.exec(source)?.[1];
    expect(defined).toBe(RESEARCH_TEST_ACCOUNT_PREFIX);
    expect(RESEARCH_TEST_ACCOUNT_PREFIX).toBe("ccc-uat-");
  });

  it("refuses the owner's research key account and the install secret, by their real names", () => {
    for (const value of ["anthropic-api-key", "install-secret"]) {
      logs = [];
      expect(() =>
        resolveResearchTestOverrides({ [FLAG]: "1", [KEY_ACCOUNT]: value }, log),
      ).toThrow(ResearchOverrideError);
      expect(logs).toEqual([
        { level: "error", fields: { code: "research-test-override-invalid-key-account" } },
      ]);
    }
  });

  it("refuses a name without the test prefix, even a harmless-looking one", () => {
    for (const value of [
      "research-key-test-account",
      "ccc-uat",
      "CCC-UAT-x",
      "xccc-uat-x",
      "uat-ccc-",
    ]) {
      expect(() =>
        resolveResearchTestOverrides({ [FLAG]: "1", [KEY_ACCOUNT]: value }, log),
      ).toThrow(ResearchOverrideError);
    }
  });

  it("refuses the account the running service keeps its install secret in, whatever it is called", () => {
    const sameAsInstall = "ccc-uat-install-secret-run-1";
    expect(() =>
      resolveResearchTestOverrides(
        { [FLAG]: "1", [KEY_ACCOUNT]: sameAsInstall, CCC_INSTALL_SECRET_ACCOUNT: sameAsInstall },
        log,
      ),
    ).toThrow(ResearchOverrideError);
    // A different test account is fine next to a test install-secret account.
    expect(
      resolveResearchTestOverrides(
        {
          [FLAG]: "1",
          [KEY_ACCOUNT]: "ccc-uat-research-key-run-1",
          CCC_INSTALL_SECRET_ACCOUNT: sameAsInstall,
        },
        log,
      ),
    ).toEqual({ keyAccount: "ccc-uat-research-key-run-1" });
  });
});

describe("overrides are refused when the runtime directory is the owner's default one", () => {
  const HOME = "/ccc-test-home-does-not-exist";
  const DEFAULT_DIR = `${HOME}/.claude-command-center`;

  it("refuses every kind of override, with a code-only log line", () => {
    for (const env of [
      { [FLAG]: "1", [KEY_ACCOUNT]: KEY_ACCOUNT_OK },
      { [FLAG]: "1", [SUMMARISER]: "extractive" },
      { [FLAG]: "1", [FIXTURE_DIR]: dir },
    ]) {
      logs = [];
      expect(() =>
        resolveResearchTestOverrides(env, log, { runtimeDir: DEFAULT_DIR, home: HOME }),
      ).toThrow(ResearchOverrideError);
      expect(logs).toEqual([
        { level: "error", fields: { code: "research-test-override-default-runtime-dir" } },
      ]);
    }
  });

  it("recognises the default directory however the path is written", () => {
    for (const written of [
      `${DEFAULT_DIR}/`,
      `${HOME}/./.claude-command-center`,
      `${HOME}//.claude-command-center`,
      `${HOME}/x/../.claude-command-center`,
    ]) {
      expect(() =>
        resolveResearchTestOverrides({ [FLAG]: "1", [SUMMARISER]: "extractive" }, log, {
          runtimeDir: written,
          home: HOME,
        }),
      ).toThrow(ResearchOverrideError);
    }
  });

  it("uses the real home directory when none is injected, without creating anything", () => {
    expect(() =>
      resolveResearchTestOverrides({ [FLAG]: "1", [SUMMARISER]: "extractive" }, log, {
        runtimeDir: join(homedir(), ".claude-command-center"),
      }),
    ).toThrow(ResearchOverrideError);
  });

  it("allows a temporary runtime directory, and sets nothing when no override is asked for", () => {
    expect(
      resolveResearchTestOverrides({ [FLAG]: "1", [SUMMARISER]: "extractive" }, log, {
        runtimeDir: join(dir, "runtime"),
        home: HOME,
      }).transport,
    ).toBeDefined();
    logs = [];
    expect(
      resolveResearchTestOverrides({ [FLAG]: "1" }, log, { runtimeDir: DEFAULT_DIR, home: HOME }),
    ).toEqual({});
    expect(logs).toEqual([]);
  });

  it("does not refuse without the flag: the variables are ignored, as before", () => {
    expect(
      resolveResearchTestOverrides({ [SUMMARISER]: "extractive" }, log, {
        runtimeDir: DEFAULT_DIR,
        home: HOME,
      }),
    ).toEqual({});
  });
});

describe("07-FIX8: the default-directory comparison follows links on both sides", () => {
  it("refuses a runtime directory that is a link to the default one", () => {
    const home = join(dir, "home");
    const defaultDir = join(home, ".claude-command-center");
    mkdirSync(defaultDir, { recursive: true });
    const link = join(dir, "looks-temporary");
    symlinkSync(defaultDir, link);
    expect(() =>
      resolveResearchTestOverrides({ [FLAG]: "1", [SUMMARISER]: "extractive" }, log, {
        runtimeDir: link,
        home,
      }),
    ).toThrow(ResearchOverrideError);
  });

  it("refuses the default directory reached through a home that is itself a link", () => {
    const realHome = join(dir, "real-home");
    mkdirSync(join(realHome, ".claude-command-center"), { recursive: true });
    const linkedHome = join(dir, "linked-home");
    symlinkSync(realHome, linkedHome);
    expect(() =>
      resolveResearchTestOverrides({ [FLAG]: "1", [SUMMARISER]: "extractive" }, log, {
        runtimeDir: join(realHome, ".claude-command-center"),
        home: linkedHome,
      }),
    ).toThrow(ResearchOverrideError);
  });

  it("refuses a not-yet-created default directory below a linked parent", () => {
    const realHome = join(dir, "real-home2");
    mkdirSync(realHome, { recursive: true });
    const linkedHome = join(dir, "linked-home2");
    symlinkSync(realHome, linkedHome);
    expect(() =>
      resolveResearchTestOverrides({ [FLAG]: "1", [SUMMARISER]: "extractive" }, log, {
        runtimeDir: join(realHome, ".claude-command-center"),
        home: linkedHome,
      }),
    ).toThrow(ResearchOverrideError);
  });

  it("still allows a real temporary directory beside a linked home", () => {
    const realHome = join(dir, "real-home3");
    mkdirSync(realHome, { recursive: true });
    const linkedHome = join(dir, "linked-home3");
    symlinkSync(realHome, linkedHome);
    expect(
      resolveResearchTestOverrides({ [FLAG]: "1", [SUMMARISER]: "extractive" }, log, {
        runtimeDir: join(dir, "runtime"),
        home: linkedHome,
      }).transport,
    ).toBeDefined();
  });
});
