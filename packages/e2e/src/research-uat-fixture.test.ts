import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchSourcesConfigSchema } from "@ccc/domain";
import { afterEach, describe, expect, it } from "vitest";
import { realRuntimeDir, UAT_ACCOUNT_PREFIX } from "./isolation-guards.js";
import { REPO_ROOT } from "./repo-paths.js";
import {
  isResearchGuardEnv,
  prepareResearchUat,
  RESEARCH_SCENARIOS,
  RESEARCH_TEST_ENV,
  SLOW_FETCH_MS,
} from "./research-uat-fixture.js";
import { createServiceFixture } from "./service-fixture.js";

/**
 * Plan 07-17 Task 1 Test 2 (D-27, OD-3, T-07-44, T-07-45): the fixture a live research item runs
 * against is synthetic, sits inside the throwaway runtime directory and reaches the service
 * only through the guard environment.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runtimeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccc-uat-fixture-"));
  made.push(dir);
  return dir;
}

const INSTALL_ACCOUNT = "ccc-uat-0123abcd";

function parsedSources(dir: string) {
  return ResearchSourcesConfigSchema.parse(
    JSON.parse(readFileSync(join(dir, "research-sources.json"), "utf8")),
  );
}

describe("prepareResearchUat writes the allowlist, the fixture directory and the guard environment", () => {
  it("writes research-sources.json with the three synthetic sources and the UAT topic", () => {
    const dir = runtimeDir();
    prepareResearchUat(dir, { installAccount: INSTALL_ACCOUNT });
    const config = parsedSources(dir);
    expect(config.topicLabel).toBe("Developer tooling and open-source releases");
    expect(config.sources).toHaveLength(3);
    for (const source of config.sources) {
      expect(source.url.startsWith("https://")).toBe(true);
      expect(new URL(source.url).hostname.endsWith(".invalid")).toBe(true);
    }
    expect(statSync(join(dir, "research-sources.json")).mode & 0o777).toBe(0o600);
  });

  it("creates a fixture directory inside the runtime directory with a manifest naming real files", () => {
    const dir = runtimeDir();
    const prepared = prepareResearchUat(dir, { installAccount: INSTALL_ACCOUNT });
    expect(prepared.fixtureDir.startsWith(`${dir}/`)).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(prepared.fixtureDir, "manifest.json"), "utf8"),
    ) as {
      entries: { url: string; file?: string; failure?: string; delayMs?: number }[];
    };
    expect(manifest.entries.length).toBeGreaterThan(3);
    for (const entry of manifest.entries) {
      expect(new URL(entry.url).hostname.endsWith(".invalid")).toBe(true);
      if (entry.file !== undefined) {
        expect(existsSync(join(prepared.fixtureDir, entry.file)), entry.file).toBe(true);
        expect(entry.file).not.toMatch(/[\\/]/);
      }
    }
  });

  it("returns exactly the guard variables, with the extractive summariser and the test key account", () => {
    const dir = runtimeDir();
    const prepared = prepareResearchUat(dir, { installAccount: INSTALL_ACCOUNT });
    expect({ ...prepared.guardEnv }).toEqual({
      CCC_ENABLE_TEST_OVERRIDES: "1",
      [RESEARCH_TEST_ENV.fixtureDir]: prepared.fixtureDir,
      [RESEARCH_TEST_ENV.summariser]: "extractive",
      [RESEARCH_TEST_ENV.keyAccount]: prepared.keyAccount,
    });
    expect(isResearchGuardEnv(prepared.guardEnv)).toBe(true);
  });

  it("returns a variant without the summariser override for the unconfigured item", () => {
    const dir = runtimeDir();
    const prepared = prepareResearchUat(dir, { installAccount: INSTALL_ACCOUNT });
    expect({ ...prepared.guardEnvWithoutSummariser }).toEqual({
      CCC_ENABLE_TEST_OVERRIDES: "1",
      [RESEARCH_TEST_ENV.fixtureDir]: prepared.fixtureDir,
      [RESEARCH_TEST_ENV.keyAccount]: prepared.keyAccount,
    });
    expect(isResearchGuardEnv(prepared.guardEnvWithoutSummariser)).toBe(true);
  });

  it("uses a unique test key account in the ccc-uat family that is never the install secret account", () => {
    const first = prepareResearchUat(runtimeDir(), { installAccount: INSTALL_ACCOUNT });
    const second = prepareResearchUat(runtimeDir(), { installAccount: "ccc-uat-feedbeef" });
    expect(first.keyAccount.startsWith(UAT_ACCOUNT_PREFIX)).toBe(true);
    expect(first.keyAccount).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    expect(first.keyAccount).not.toBe(INSTALL_ACCOUNT);
    expect(first.keyAccount).not.toBe("anthropic-api-key");
    expect(first.keyAccount).not.toBe(second.keyAccount);
  });

  it("refuses an install account outside the ccc-uat family", () => {
    expect(() => prepareResearchUat(runtimeDir(), { installAccount: "install-secret" })).toThrow();
    expect(() =>
      prepareResearchUat(runtimeDir(), { installAccount: "anthropic-api-key" }),
    ).toThrow();
  });

  it("selects a scenario by rewriting the allowlist only, and refuses an unknown scenario", () => {
    const dir = runtimeDir();
    const prepared = prepareResearchUat(dir, { installAccount: INSTALL_ACCOUNT });
    const before = readdirSync(prepared.fixtureDir).sort();
    for (const scenario of RESEARCH_SCENARIOS) {
      prepared.select(scenario);
      const config = parsedSources(dir);
      expect(config.sources.length, scenario).toBeGreaterThan(0);
      expect(config.sources.length, scenario).toBeLessThanOrEqual(12);
    }
    expect(readdirSync(prepared.fixtureDir).sort()).toEqual(before);
    expect(() => prepared.select("not-a-scenario" as never)).toThrow();
  });

  it("scenario sizes: base 3, partial 3, all-failing 3, slow 3, long 12, hostile within 12", () => {
    const dir = runtimeDir();
    const prepared = prepareResearchUat(dir, { installAccount: INSTALL_ACCOUNT });
    const size = (name: (typeof RESEARCH_SCENARIOS)[number]) => {
      prepared.select(name);
      return parsedSources(dir).sources.length;
    };
    expect(size("base")).toBe(3);
    expect(size("partial")).toBe(3);
    expect(size("all-failing")).toBe(3);
    expect(size("slow")).toBe(3);
    expect(size("long")).toBe(12);
    expect(size("hostile")).toBeGreaterThanOrEqual(9);
    expect(size("hostile")).toBeLessThanOrEqual(12);
  });

  it("gives the partial scenario exactly one failing source and the all-failing scenario three", () => {
    const dir = runtimeDir();
    const prepared = prepareResearchUat(dir, { installAccount: INSTALL_ACCOUNT });
    const manifest = JSON.parse(
      readFileSync(join(prepared.fixtureDir, "manifest.json"), "utf8"),
    ) as {
      entries: { url: string; failure?: string }[];
    };
    const failing = (scenario: (typeof RESEARCH_SCENARIOS)[number]) => {
      prepared.select(scenario);
      return parsedSources(dir).sources.filter(
        (source) =>
          manifest.entries.find((entry) => entry.url === source.url)?.failure !== undefined,
      ).length;
    };
    expect(failing("base")).toBe(0);
    expect(failing("partial")).toBe(1);
    expect(failing("all-failing")).toBe(3);
  });

  it("holds every source of the slow scenario long enough to stop the service mid-fetch, and no other scenario that long", () => {
    const dir = runtimeDir();
    const prepared = prepareResearchUat(dir, { installAccount: INSTALL_ACCOUNT });
    const manifest = JSON.parse(
      readFileSync(join(prepared.fixtureDir, "manifest.json"), "utf8"),
    ) as {
      entries: { url: string; delayMs?: number }[];
    };
    const delayed = (scenario: (typeof RESEARCH_SCENARIOS)[number]) => {
      prepared.select(scenario);
      return parsedSources(dir).sources.filter(
        (source) =>
          (manifest.entries.find((entry) => entry.url === source.url)?.delayMs ?? 0) >=
          SLOW_FETCH_MS,
      ).length;
    };
    expect(delayed("slow")).toBe(3);
    for (const scenario of RESEARCH_SCENARIOS.filter((name) => name !== "slow")) {
      expect(delayed(scenario), scenario).toBe(0);
    }
  });

  it("refuses a runtime directory inside the repository, creating nothing", () => {
    const inside = join(REPO_ROOT, "packages", "e2e", `uat-fixture-refused-${process.pid}`);
    expect(() => prepareResearchUat(inside, { installAccount: INSTALL_ACCOUNT })).toThrow(
      /repository/i,
    );
    expect(existsSync(inside)).toBe(false);
    expect(() => prepareResearchUat(REPO_ROOT, { installAccount: INSTALL_ACCOUNT })).toThrow();
  });

  it("refuses the owner's real runtime directory and a relative one", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-uat-home-"));
    made.push(home);
    expect(() =>
      prepareResearchUat(realRuntimeDir(home), {
        installAccount: INSTALL_ACCOUNT,
        home,
      }),
    ).toThrow(/runtime directory/i);
    expect(() =>
      prepareResearchUat(realRuntimeDir(homedir()), {
        installAccount: INSTALL_ACCOUNT,
      }),
    ).toThrow(/runtime directory/i);
    expect(() => prepareResearchUat("relative/dir", { installAccount: INSTALL_ACCOUNT })).toThrow();
  });
});

describe("the guard environment reaches the service fixture only through the brand", () => {
  const paths = {
    root: "/tmp/ccc-uat.AbCdEf",
    runtimeDir: "/tmp/ccc-uat.AbCdEf/rt",
    socketPath: "/tmp/ccc-uat.AbCdEf/rt/svc.sock",
    dbPath: "/tmp/ccc-uat.AbCdEf/rt/operational.db",
    claudeConfigDir: "/tmp/ccc-uat.AbCdEf/claude",
    codexHome: "/tmp/ccc-uat.AbCdEf/codex",
  };

  it("merges the guard variables into the service environment", async () => {
    const calls: { env: Record<string, string> }[] = [];
    const dir = runtimeDir();
    const prepared = prepareResearchUat(dir, { installAccount: INSTALL_ACCOUNT });
    const fixture = createServiceFixture(
      {
        paths: paths as never,
        account: INSTALL_ACCOUNT,
        registerService: async () => undefined,
        unregister: () => undefined,
      },
      {
        startService: async (args) => {
          calls.push({ env: args.env });
          return { pid: undefined, stop: async () => undefined, kill: async () => undefined };
        },
        home: "/nonexistent-home",
      },
    );
    await fixture.start({ kind: "normal", researchEnv: prepared.guardEnv });
    expect(calls[0]?.env.CCC_ENABLE_TEST_OVERRIDES).toBe("1");
    expect(calls[0]?.env[RESEARCH_TEST_ENV.fixtureDir]).toBe(prepared.fixtureDir);
    expect(calls[0]?.env[RESEARCH_TEST_ENV.summariser]).toBe("extractive");
    expect(calls[0]?.env.CCC_INSTALL_SECRET_ACCOUNT).toBe(INSTALL_ACCOUNT);
    await fixture.stop();
  });

  it("refuses a plain object that is not the prepared environment", async () => {
    const fixture = createServiceFixture(
      {
        paths: paths as never,
        account: INSTALL_ACCOUNT,
        registerService: async () => undefined,
        unregister: () => undefined,
      },
      {
        startService: async () => {
          throw new Error("must not start");
        },
        home: "/nonexistent-home",
      },
    );
    const forged = {
      CCC_ENABLE_TEST_OVERRIDES: "1",
      [RESEARCH_TEST_ENV.fixtureDir]: "/tmp/anywhere",
    };
    expect(isResearchGuardEnv(forged)).toBe(false);
    await expect(fixture.start({ kind: "normal", researchEnv: forged as never })).rejects.toThrow(
      /research/i,
    );
  });

  it("starts a service with no research variables when none is passed", async () => {
    const calls: { env: Record<string, string> }[] = [];
    const fixture = createServiceFixture(
      {
        paths: paths as never,
        account: INSTALL_ACCOUNT,
        registerService: async () => undefined,
        unregister: () => undefined,
      },
      {
        startService: async (args) => {
          calls.push({ env: args.env });
          return { pid: undefined, stop: async () => undefined, kill: async () => undefined };
        },
        home: "/nonexistent-home",
      },
    );
    await fixture.start({ kind: "normal" });
    expect(Object.keys(calls[0]?.env ?? {}).some((key) => key.startsWith("CCC_RESEARCH"))).toBe(
      false,
    );
    expect(calls[0]?.env.CCC_ENABLE_TEST_OVERRIDES).toBeUndefined();
    await fixture.stop();
  });
});
