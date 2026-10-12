import { join, resolve, sep } from "node:path";
import { assertRunRootShape } from "./isolation-guards.js";
import { buildLaunchCapabilities, type LaunchCapability, type LaunchFs } from "./launch-options.js";
import { parseProfile } from "./profile.js";
import { REPO_ROOT } from "./repo-paths.js";
import { SPIKE_DECISIONS, type SpikeDecisions } from "./spike-decisions.js";

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
  requireInside(runRoot, "a socket path", env.CCC_SOCKET_PATH);
  requireInside(runRoot, "a TMPDIR", env.TMPDIR);

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
  };
}
