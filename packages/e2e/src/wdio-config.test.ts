import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalPath } from "./canonical-path.js";
import { buildWdioEnv } from "./isolation-guards.js";
import type { LaunchFs } from "./launch-options.js";
import type { RunRootPaths } from "./run-root.js";
import { loadRunContext } from "./spec-context.js";
import { SPIKE_DECISIONS } from "./spike-decisions.js";
import type { PluginDataFs } from "./vault-plugin-data.js";
import { buildWdioConfig, SCALE_SPEC } from "./wdio-config.js";
import { buildWdioArgv, buildWdioProcessEnv, forwardSignals, locateWdioBin } from "./wdio-spawn.js";

const BASE = "/tmp";
const ROOT = "/tmp/ccc-uat.abc123";
const HOME = "/Users/USERNAME";

const paths: RunRootPaths = {
  runId: "0123abcd",
  root: ROOT,
  runtimeDir: `${ROOT}/rt`,
  socketPath: `${ROOT}/rt/svc.sock`,
  dbPath: `${ROOT}/rt/operational.db`,
  claudeConfigDir: `${ROOT}/claude`,
  codexHome: `${ROOT}/codex`,
  vaultsDir: `${ROOT}/vaults`,
  pluginStageDir: `${ROOT}/plugin-stage`,
  tmpDir: `${ROOT}/tmp`,
  wdioDir: `${ROOT}/wdio`,
  ledgerPath: `${ROOT}/ledger.jsonl`,
  resultsPath: `${ROOT}/results.jsonl`,
  lookPendingPath: `${ROOT}/look-pending.jsonl`,
  versionsPath: `${ROOT}/versions.json`,
};

const env = (profile: "standard" | "full" = "standard"): Record<string, string> =>
  buildWdioEnv(paths, { account: "ccc-uat-0123abcd", profile });

// The run root above is fictional, so realpath is the identity and the stage lists as the three
// plugin files; the real-filesystem behaviour is covered in launch-options-canonical.test.ts.
const FAKE_FS: LaunchFs = {
  realpathSync: (path) => path,
  readdirSync: () => ["main.js", "manifest.json", "styles.css"],
};

// An in-memory plugin data folder, so the config's isolation write never touches the disk.
const dataWrites = new Map<string, string>();
const FAKE_PLUGIN_FS: PluginDataFs = {
  readFile: (path) => dataWrites.get(path) ?? null,
  writeFileAtomic: (path, text) => {
    dataWrites.set(path, text);
  },
  mkdirp: () => {},
  isSymlink: () => false,
};

const opts = { base: BASE, home: HOME, fs: FAKE_FS, pluginDataFs: FAKE_PLUGIN_FS };

interface CapabilityShape {
  "wdio:obsidianOptions": { vault: string; copy: boolean; appVersion: string; binaryPath?: string };
  "wdio:specs"?: string[];
  "wdio:exclude"?: string[];
  maxInstances: number;
}

describe("buildWdioConfig (Tests 1 and 2)", () => {
  it("standard profile: one live-vault capability, no retries, scale spec excluded", () => {
    const config = buildWdioConfig(env(), opts);
    expect(config.maxInstances).toBe(1);
    expect(config.specFileRetries).toBe(0);
    expect(config.mochaOpts.retries).toBe(0);
    expect(config.specs).toEqual(["./specs/**/*.e2e.ts"]);
    expect(config.mochaOpts.timeout).toBeGreaterThanOrEqual(120_000);
    expect(config.services).toEqual(["obsidian"]);
    expect(config.reporters).toEqual(["spec"]);
    expect(config.outputDir).toBe(join(ROOT, "wdio"));
    expect(config.cacheDir).toMatch(/\/packages\/e2e\/\.obsidian-cache$/);
    const caps = config.capabilities as unknown as CapabilityShape[];
    expect(caps).toHaveLength(1);
    expect(caps[0]?.["wdio:obsidianOptions"].vault).toBe(join(ROOT, "vaults", "live"));
    expect(caps[0]?.["wdio:obsidianOptions"].copy).toBe(true);
    expect(caps[0]?.["wdio:exclude"]).toEqual([SCALE_SPEC]);
    expect(JSON.stringify(config)).not.toContain("big");
  });

  it("full profile: a second capability for the big vault, used in place, with only the scale spec", () => {
    const config = buildWdioConfig(env("full"), opts);
    const caps = config.capabilities as unknown as CapabilityShape[];
    expect(caps).toHaveLength(2);
    expect(caps[0]?.["wdio:exclude"]).toEqual([SCALE_SPEC]);
    expect(caps[1]?.["wdio:obsidianOptions"].vault).toBe(join(ROOT, "vaults", "big"));
    expect(caps[1]?.["wdio:obsidianOptions"].copy).toBe(false);
    expect(caps[1]?.["wdio:specs"]).toEqual([SCALE_SPEC]);
    expect(caps.every((cap) => cap.maxInstances === 1)).toBe(true);
    expect(config.maxInstances).toBe(1);
  });

  it("applies the recorded launch decisions (binaryPath, app version)", () => {
    const caps = buildWdioConfig(env(), opts).capabilities as unknown as CapabilityShape[];
    const launch = caps[0]?.["wdio:obsidianOptions"];
    expect(launch?.appVersion).toBe(SPIKE_DECISIONS.appVersion);
    expect(launch?.binaryPath).toBe("/Applications/Obsidian.app/Contents/MacOS/Obsidian");
  });
});

describe("buildWdioConfig refusals (Test 3)", () => {
  const without = (name: string): Record<string, string> => {
    const copy = { ...env() };
    delete copy[name];
    return copy;
  };

  it("refuses a missing run root", () => {
    expect(() => buildWdioConfig(without("CCC_UAT_RUN_ROOT"), opts)).toThrow(/run root/i);
    expect(() => buildWdioConfig({}, opts)).toThrow(/run root/i);
  });

  it("refuses a run root of the wrong shape", () => {
    for (const root of ["/tmp", "/tmp/other", "/Users/USERNAME", "/tmp/ccc-uat.abc123/x"]) {
      expect(() => buildWdioConfig({ ...env(), CCC_UAT_RUN_ROOT: root }, opts)).toThrow();
    }
  });

  it("refuses a vault outside the run root, a missing vault, and a missing plugin stage", () => {
    expect(() =>
      buildWdioConfig({ ...env(), CCC_UAT_VAULT_LIVE: "/tmp/elsewhere/vault" }, opts),
    ).toThrow();
    expect(() => buildWdioConfig(without("CCC_UAT_VAULT_LIVE"), opts)).toThrow();
    expect(() => buildWdioConfig(without("CCC_UAT_PLUGIN_STAGE"), opts)).toThrow();
  });

  it("refuses a socket or TMPDIR outside the run root, and a full profile without the big vault", () => {
    expect(() =>
      buildWdioConfig({ ...env(), CCC_SOCKET_PATH: "/tmp/elsewhere/svc.sock" }, opts),
    ).toThrow();
    expect(() => buildWdioConfig(without("CCC_SOCKET_PATH"), opts)).toThrow();
    expect(() => buildWdioConfig({ ...env(), TMPDIR: "/var/tmp" }, opts)).toThrow();
    const noBig = { ...env("full") };
    delete noBig.CCC_UAT_VAULT_BIG;
    expect(() => buildWdioConfig(noBig, opts)).toThrow();
    expect(() => buildWdioConfig({ ...env(), CCC_UAT_PROFILE: "weird" }, opts)).toThrow();
  });
});

describe("loadRunContext (Test 5)", () => {
  it("reads and validates the run environment and returns the paths the specs need", () => {
    const context = loadRunContext(env("full"), opts);
    expect(context.runRoot).toBe(ROOT);
    expect(context.runId).toBe("0123abcd");
    expect(context.profile).toBe("full");
    expect(context.account).toBe("ccc-uat-0123abcd");
    expect(context.socketPath).toBe(paths.socketPath);
    expect(context.vaultLive).toBe(join(ROOT, "vaults", "live"));
    expect(context.vaultBig).toBe(join(ROOT, "vaults", "big"));
    expect(context.paths.runtimeDir).toBe(paths.runtimeDir);
    expect(context.paths.ledgerPath).toBe(paths.ledgerPath);
  });

  it("throws a fixed message outside the runner or on a bad shape", () => {
    expect(() => loadRunContext({}, opts)).toThrow(/runner/i);
    expect(() => loadRunContext({ ...env(), CCC_UAT_RUN_ROOT: "/tmp/other" }, opts)).toThrow();
    expect(() => loadRunContext({ ...env(), CCC_UAT_ACCOUNT: "install-secret" }, opts)).toThrow();
  });
});

describe("wdio spawn wrapper (Test 7)", () => {
  it("builds an argv array through the package's own binary entry, never npx or pnpm", () => {
    const argv = buildWdioArgv("/pkg/@wdio/cli/bin/wdio.js", "/repo/packages/e2e/wdio.conf.ts", [
      "--spec",
      "x",
    ]);
    expect(argv).toEqual([
      "/pkg/@wdio/cli/bin/wdio.js",
      "run",
      "/repo/packages/e2e/wdio.conf.ts",
      "--spec",
      "x",
    ]);
    expect(argv.join(" ")).not.toMatch(/npx|pnpm/);
  });

  it("locates the wdio bin from the resolved main file and the package's bin field", () => {
    const bin = locateWdioBin({
      resolveMain: () => "/store/@wdio/cli/build/index.cjs",
      readJson: (file) =>
        file === "/store/@wdio/cli/package.json"
          ? { name: "@wdio/cli", bin: { wdio: "./bin/wdio.js" } }
          : undefined,
    });
    expect(bin).toBe("/store/@wdio/cli/bin/wdio.js");
    expect(() =>
      locateWdioBin({ resolveMain: () => "/x/index.cjs", readJson: () => undefined }),
    ).toThrow();
  });

  it("merges the wdio env over a scrubbed environment (no overrides, no isolation leftovers)", () => {
    const merged = buildWdioProcessEnv(
      {
        PATH: "/usr/bin",
        CCC_ENABLE_TEST_OVERRIDES: "1",
        CCC_SOCKET_PATH: "/real/svc.sock",
        CODEX_HOME: "/real",
      },
      env(),
    );
    expect(merged.PATH).toBe("/usr/bin");
    expect(merged.CCC_SOCKET_PATH).toBe(paths.socketPath);
    expect(merged.CCC_ENABLE_TEST_OVERRIDES).toBeUndefined();
    // the inherited real value is replaced by the run-root one the runner built
    expect(merged.CODEX_HOME).toBe(paths.codexHome);
    for (const [key, value] of Object.entries(env())) expect(merged[key]).toBe(value);
  });

  it("forwards a runner SIGINT or SIGTERM to the child as SIGTERM through the child handle", () => {
    const handlers = new Map<string, () => void>();
    const proc = {
      on: vi.fn((signal: string, handler: () => void) => {
        handlers.set(signal, handler);
      }),
      off: vi.fn((signal: string) => {
        handlers.delete(signal);
      }),
    };
    const child = { kill: vi.fn().mockReturnValue(true) };
    const dispose = forwardSignals(child, proc);
    handlers.get("SIGINT")?.();
    handlers.get("SIGTERM")?.();
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGTERM");
    dispose();
    expect(handlers.size).toBe(0);
  });
});

describe("the version-recording before hook (05.2-09 Test 8)", () => {
  const fakeBrowser = (app: string, installer: string) => ({
    getObsidianVersion: () => app,
    getObsidianInstallerVersion: () => installer,
  });

  it("writes the observed versions into the run root's versions file", async () => {
    const written: Array<{ path: string; text: string }> = [];
    const config = buildWdioConfig(env(), {
      ...opts,
      versionsIo: {
        read: () => null,
        write: (path, text) => {
          written.push({ path, text });
        },
      },
    });
    await config.before?.([], [], fakeBrowser("1.14.4", "1.13.7"));
    expect(written).toHaveLength(1);
    expect(written[0]?.path).toBe(join(ROOT, "versions.json"));
    expect(JSON.parse(written[0]?.text ?? "{}")).toEqual({
      app: "1.14.4",
      installer: "1.13.7",
      mismatches: [],
    });
  });

  it("reconciles with an earlier record and records a drift between specs", async () => {
    let stored: string | null = null;
    const config = buildWdioConfig(env(), {
      ...opts,
      versionsIo: {
        read: () => stored,
        write: (_path, text) => {
          stored = text;
        },
      },
    });
    await config.before?.([], [], fakeBrowser("1.14.4", "1.13.7"));
    await config.before?.([], [], fakeBrowser("1.15.0", "1.13.7"));
    expect(JSON.parse(stored ?? "{}").mismatches).toContain("app-changed-between-specs");
  });
});

describe("the config enforces the isolation guards before it builds capabilities (LOW-5)", () => {
  const dataPath = (vault: string) =>
    join(canonicalPath(vault), ".obsidian", "plugins", "claude-command-center", "data.json");

  it("writes the run-root socket into the live vault's plugin data", () => {
    dataWrites.clear();
    buildWdioConfig(env(), opts);
    const live = dataWrites.get(dataPath(join(ROOT, "vaults", "live"))) ?? "";
    expect(JSON.parse(live).socketPathOverride).toBe(paths.socketPath);
    expect(dataWrites.has(dataPath(join(ROOT, "vaults", "big")))).toBe(false);
  });

  it("also isolates the big vault in the full profile", () => {
    dataWrites.clear();
    buildWdioConfig(env("full"), opts);
    const big = dataWrites.get(dataPath(join(ROOT, "vaults", "big"))) ?? "";
    expect(JSON.parse(big).socketPathOverride).toBe(paths.socketPath);
  });

  it("refuses an environment without the isolation variables and writes nothing", () => {
    dataWrites.clear();
    for (const name of [
      "CCC_RUNTIME_DIR",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "CCC_INSTALL_SECRET_ACCOUNT",
    ]) {
      const broken: Record<string, string | undefined> = { ...env() };
      delete broken[name];
      expect(() => buildWdioConfig(broken, opts), name).toThrow();
    }
    expect(dataWrites.size).toBe(0);
  });

  it("refuses an isolation variable that points outside the run root", () => {
    expect(() => buildWdioConfig({ ...env(), CODEX_HOME: "/tmp/elsewhere/codex" }, opts)).toThrow();
  });

  it("calls the env guard, then the plugin data write, then builds the capabilities (source order)", () => {
    const source = readFileSync(new URL("./wdio-config.ts", import.meta.url), "utf8");
    const guard = source.indexOf("assertIsolatedEnv(");
    const isolate = source.indexOf("isolatePluginData(");
    const build = source.indexOf("buildLaunchCapabilities({");
    expect(guard).toBeGreaterThan(-1);
    expect(isolate).toBeGreaterThan(guard);
    expect(build).toBeGreaterThan(isolate);
  });

  it("is the only thing wdio.conf.ts loads, so the real path runs both guards", () => {
    const conf = readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");
    expect(conf).toContain("buildWdioConfig(process.env)");
  });

  it("the before hook records versions only and installs no result recorder (no duplicated results)", () => {
    for (const file of ["./wdio-config.ts", "../wdio.conf.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toContain("installResultRecorder");
      expect(source, file).not.toContain("resultsPath");
    }
  });
});
