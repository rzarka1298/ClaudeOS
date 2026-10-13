import { waitForAppExit } from "./app-exit.js";
import { readProcessTable } from "./process-table.js";
import { INSTALLED_OBSIDIAN_BINARY } from "./repo-paths.js";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { assertRunRootShape } from "./isolation-guards.js";
import { buildLaunchCapabilities, type LaunchCapability, type LaunchFs } from "./launch-options.js";
import { parseProfile } from "./profile.js";
import { REPO_ROOT } from "./repo-paths.js";
import { SPIKE_DECISIONS, type SpikeDecisions } from "./spike-decisions.js";
import { assertIsolatedEnv } from "./uat-env.js";
import { isolatePluginData, type PluginDataFs } from "./vault-plugin-data.js";
import { formatVersions, parseVersions, reconcileVersions } from "./versions.js";

/**
 * The real wdio configuration, built by a pure function from the run environment (05.2-03,
 * D-03, D-07, D-11). It refuses to load without a valid run root, takes every path from the
 * environment the runner built (buildWdioEnv), and validates each against the run root with the
 * Task 1 guards. wdio.conf.ts is a one-line call into buildWdioConfig.
 */

/** The 10,000-task scale spec (created by plan 05.2-07); run only in the full profile (D-07). */
export const SCALE_SPEC = "./specs/tasks-scale.e2e.ts";
export const SPEC_GLOB = "./specs/**/*.e2e.ts";
/** A GUI launch plus an app start is slow; no spec may fail on mocha's default timeout. */
export const MOCHA_TIMEOUT_MS = 180_000;

/** The download cache sits under the package folder and is gitignored (D-08). */
export const OBSIDIAN_CACHE_DIR = join(REPO_ROOT, "packages", "e2e", ".obsidian-cache");

export type WdioCapability = LaunchCapability & {
  "wdio:specs"?: string[];
  "wdio:exclude"?: string[];
};

export interface WdioRunConfig {
  runner: "local";
  specs: string[];
  maxInstances: 1;
  capabilities: WdioCapability[];
  services: string[];
  framework: "mocha";
  reporters: string[];
  mochaOpts: { ui: "bdd"; timeout: number; retries: 0 };
  cacheDir: string;
  outputDir: string;
  logLevel: "warn";
  specFileRetries: 0;
  waitforTimeout: number;
  /** Records the app and installer versions each spec's session reports (D-08). */
  before?: (capabilities: unknown, specs: string[], browser: VersionBrowser) => Promise<void>;
  /**
   * The same recording, run once the session is fully set up. The baseline run recorded no
   * versions: the service adds getObsidianVersion in its own before hook, which has not run yet
   * when this config's `before` does, so the call threw and wdio swallowed it into a log file.
   */
  beforeSuite?: (suite: unknown) => Promise<void>;
  /** Waits for the finished spec's app to exit before the next spec's app launches. */
  afterSession?: () => Promise<void>;
}

/** The two service getters the version hook reads. */
export interface VersionBrowser {
  getObsidianVersion(): string;
  getObsidianInstallerVersion(): string;
}

/** Reads and writes the run root's versions file; tests inject it. */
export interface VersionsIo {
  read: (path: string) => string | null;
  write: (path: string, text: string) => void;
}

export interface WdioConfigOptions {
  base?: string | undefined;
  home?: string | undefined;
  decisions?: SpikeDecisions | undefined;
  cacheDir?: string | undefined;
  /** Tests only: realpath and readdir for the launch guards; defaults to the real filesystem. */
  fs?: LaunchFs | undefined;
  /** Tests only: where the before hook reads and writes versions.json. */
  versionsIo?: VersionsIo | undefined;
  /** Tests only: where the vault plugin data is written; defaults to the real filesystem. */
  pluginDataFs?: PluginDataFs | undefined;
}

const NOT_RUNNER =
  "The wdio configuration loads only through the UAT runner: no run root in the environment.";

function isStrictlyInside(outer: string, inner: string): boolean {
  const a = resolve(outer);
  const b = resolve(inner);
  return b !== a && b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`);
}

function requireInside(runRoot: string, label: string, value: string | undefined): string {
  if (value === undefined || value === "" || !isStrictlyInside(runRoot, value)) {
    throw new Error(`Refusing ${label} that is missing or outside the run root.`);
  }
  return value;
}

const REAL_VERSIONS_IO: VersionsIo = {
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  write: (path, text) => {
    writeFileSync(path, text, { mode: 0o600 });
  },
};

/** Records one observation; false when the session cannot report its versions yet. */
function recordVersions(
  versionsPath: string,
  decisions: SpikeDecisions,
  io: VersionsIo,
  browser: Partial<VersionBrowser> | undefined,
): boolean {
  if (
    typeof browser?.getObsidianVersion !== "function" ||
    typeof browser.getObsidianInstallerVersion !== "function"
  ) {
    return false;
  }
  const observed = {
    app: browser.getObsidianVersion(),
    installer: browser.getObsidianInstallerVersion(),
  };
  const text = io.read(versionsPath);
  const existing = text === null ? undefined : parseVersions(text);
  io.write(versionsPath, formatVersions(reconcileVersions(existing, observed, decisions)));
  return true;
}

/** The before hook: reconcile what this session reports with the record so far (D-08). */
function versionHook(
  versionsPath: string,
  decisions: SpikeDecisions,
  io: VersionsIo,
): NonNullable<WdioRunConfig["before"]> {
  return async (_capabilities, _specs, browser) => {
    recordVersions(versionsPath, decisions, io, browser);
  };
}

/** The suite hook: the service's commands exist by now, so the global browser can report. */
function versionSuiteHook(
  versionsPath: string,
  decisions: SpikeDecisions,
  io: VersionsIo,
): NonNullable<WdioRunConfig["beforeSuite"]> {
  return async () => {
    const live = (globalThis as { browser?: Partial<VersionBrowser> }).browser;
    recordVersions(versionsPath, decisions, io, live);
  };
}

export function buildWdioConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: WdioConfigOptions = {},
): WdioRunConfig {
  const runRootRaw = env.CCC_UAT_RUN_ROOT;
  if (runRootRaw === undefined || runRootRaw === "") throw new Error(NOT_RUNNER);
  assertRunRootShape(runRootRaw, { base: options.base, home: options.home });
  const runRoot = resolve(runRootRaw);

  const profile = parseProfile(env.CCC_UAT_PROFILE);
  const vaultLive = requireInside(runRoot, "a live vault", env.CCC_UAT_VAULT_LIVE);
  const pluginStage = requireInside(runRoot, "a plugin stage folder", env.CCC_UAT_PLUGIN_STAGE);
  const socketPath = requireInside(runRoot, "a socket path", env.CCC_SOCKET_PATH);
  requireInside(runRoot, "a TMPDIR", env.TMPDIR);
  // The service, Claude, Codex and Keychain isolation variables must all point inside the run
  // root before anything is written or launched (HIGH-1, LOW-5); then each vault's plugin data
  // is pinned to the run-root socket, because the plugin prefers that setting over the variable.
  assertIsolatedEnv(env, { runRoot, home: options.home ?? homedir() });
  const isolate = (vaultPath: string): void => {
    isolatePluginData({
      vaultPath,
      runRoot,
      socketPath,
      ...(options.home === undefined ? {} : { homeDir: options.home }),
      ...(options.pluginDataFs === undefined ? {} : { fs: options.pluginDataFs }),
    });
  };
  isolate(vaultLive);

  const decisions = options.decisions ?? SPIKE_DECISIONS;
  const cacheDir = options.cacheDir ?? OBSIDIAN_CACHE_DIR;
  const launch = {
    decisions,
    pluginStageDir: pluginStage,
    runRoot,
    cacheDir,
    ...(options.home === undefined ? {} : { homeDir: options.home }),
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  };

  const capabilities: WdioCapability[] = buildLaunchCapabilities({
    ...launch,
    vaultPath: vaultLive,
  }).map((capability) => ({
    ...capability,
    "wdio:specs": [SPEC_GLOB],
    "wdio:exclude": [SCALE_SPEC],
  }));

  if (profile === "full") {
    const vaultBig = requireInside(runRoot, "a big vault", env.CCC_UAT_VAULT_BIG);
    isolate(vaultBig);
    // The 10,000-task vault is used in place, never copied (D-07).
    for (const capability of buildLaunchCapabilities({
      ...launch,
      vaultPath: vaultBig,
      bigVault: true,
    })) {
      capabilities.push({ ...capability, "wdio:specs": [SCALE_SPEC] });
    }
  }

  return {
    runner: "local",
    specs: [SPEC_GLOB],
    maxInstances: 1,
    capabilities,
    services: ["obsidian"],
    framework: "mocha",
    reporters: ["spec"],
    mochaOpts: { ui: "bdd", timeout: MOCHA_TIMEOUT_MS, retries: 0 },
    cacheDir,
    outputDir: join(runRoot, "wdio"),
    logLevel: "warn",
    // D-11: a failed look or assertion is a result, never something to retry away.
    specFileRetries: 0,
    waitforTimeout: 10_000,
    before: versionHook(
      join(runRoot, "versions.json"),
      decisions,
      options.versionsIo ?? REAL_VERSIONS_IO,
    ),
    afterSession: async () => {
      try {
        await waitForAppExit({
          readTable: () => readProcessTable(),
          appBinary: INSTALLED_OBSIDIAN_BINARY,
          runRoot,
          sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
          now: () => Date.now(),
          timeoutMs: 20_000,
          intervalMs: 500,
        });
      } catch {
        // waiting is best effort; the next spec's launch is the real test
      }
    },
    beforeSuite: versionSuiteHook(
      join(runRoot, "versions.json"),
      decisions,
      options.versionsIo ?? REAL_VERSIONS_IO,
    ),
  };
}
