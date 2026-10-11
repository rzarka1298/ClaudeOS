import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { INSTALLED_OBSIDIAN_BINARY, PLUGIN_BUILD_DIR } from "./repo-paths.js";
import type { SpikeDecisions } from "./spike-decisions.js";

/**
 * Pure builder for the sandbox Obsidian's wdio capabilities (05.2-01, L-3, D-07, D-08).
 *
 * It imports nothing from `obsidian` and nothing from wdio at runtime; the capability
 * shapes below mirror wdio-obsidian-service's `wdio:obsidianOptions` structurally, so the
 * unit test needs no wdio. The only filesystem inputs it accepts are the staged plugin
 * folder and a vault inside the run root, and it never touches the filesystem itself.
 * Every refusal is a fixed message that does not echo the offending path.
 */

export interface LaunchInput {
  /** The recorded launch decision (SPIKE_DECISIONS). */
  decisions: SpikeDecisions;
  /** Folder holding only main.js, manifest.json and styles.css (D-07). */
  pluginStageDir: string;
  /** The throwaway vault; it must sit strictly inside the run root. */
  vaultPath: string;
  /** The short mode-700 run root (D-05). */
  runRoot: string;
  /** The wdio-obsidian-service download cache (`.obsidian-cache`, D-08). */
  cacheDir: string;
  /** True only for the 10,000-task vault, which is opened in place instead of copied. */
  bigVault?: boolean;
  /** If given, must be the installed app executable and launch must be binaryPath. */
  binaryPath?: string;
  /** Real vault locations that must never overlap the throwaway vault. */
  ownerVaultPaths?: readonly string[];
  /** Overridable for tests; defaults to the real home directory. */
  homeDir?: string;
}

export interface ObsidianLaunchOptions {
  appVersion: string;
  installerVersion?: string;
  binaryPath?: string;
  plugins: string[];
  vault: string;
  copy: boolean;
}

export interface LaunchCapability {
  browserName: "obsidian";
  browserVersion: string;
  maxInstances: 1;
  "wdio:obsidianOptions": ObsidianLaunchOptions;
}

const ERR_BINARY = "Refusing to launch any Obsidian binary other than the installed app.";
const ERR_OUTSIDE = "Refusing a vault outside the run root.";
const ERR_RUN_ROOT = "Refusing a run root that is or contains the home directory.";
const ERR_OWNER_VAULT = "Refusing a vault that overlaps an owner vault.";
const ERR_STAGE = "Refusing a plugin stage directory that is relative or is the plugin package.";
const ERR_CACHE = "Refusing a cache directory that is relative or inside the Obsidian profile.";

/** True when `inner` equals `outer` or sits below it (boundary-safe, never a prefix match). */
function isSameOrInside(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}

function isStrictlyInside(outer: string, inner: string): boolean {
  return inner !== outer && isSameOrInside(outer, inner);
}

export function buildLaunchCapabilities(input: LaunchInput): LaunchCapability[] {
  const { decisions } = input;
  const home = resolve(input.homeDir ?? homedir());

  if (input.binaryPath !== undefined) {
    if (decisions.launch !== "binaryPath" || input.binaryPath !== INSTALLED_OBSIDIAN_BINARY) {
      throw new Error(ERR_BINARY);
    }
  }

  if (!isAbsolute(input.runRoot)) throw new Error(ERR_RUN_ROOT);
  const runRoot = resolve(input.runRoot);
  // A run root that is the home directory, or an ancestor of it, would make "inside the run
  // root" true for the owner's real folders.
  if (isSameOrInside(runRoot, home)) throw new Error(ERR_RUN_ROOT);

  if (!isAbsolute(input.vaultPath)) throw new Error(ERR_OUTSIDE);
  const vault = resolve(input.vaultPath);
  if (!isStrictlyInside(runRoot, vault)) throw new Error(ERR_OUTSIDE);

  for (const ownerPath of input.ownerVaultPaths ?? []) {
    const owner = resolve(ownerPath);
    if (isSameOrInside(owner, vault) || isSameOrInside(vault, owner)) {
      throw new Error(ERR_OWNER_VAULT);
    }
  }

  if (!isAbsolute(input.pluginStageDir)) throw new Error(ERR_STAGE);
  const stage = resolve(input.pluginStageDir);
  // The plugin package folder holds the owner's data.json; only a staged copy may be installed.
  if (isSameOrInside(resolve(PLUGIN_BUILD_DIR), stage)) throw new Error(ERR_STAGE);

  if (!isAbsolute(input.cacheDir)) throw new Error(ERR_CACHE);
  const cache = resolve(input.cacheDir);
  if (isSameOrInside(join(home, "Library", "Application Support", "obsidian"), cache)) {
    throw new Error(ERR_CACHE);
  }

  const options: ObsidianLaunchOptions = {
    appVersion: decisions.appVersion,
    plugins: [stage],
    vault,
    copy: input.bigVault !== true,
  };
  if (decisions.launch === "binaryPath") {
    options.binaryPath = INSTALLED_OBSIDIAN_BINARY;
  } else {
    options.installerVersion = decisions.installerVersion;
  }

  return [
    {
      browserName: "obsidian",
      browserVersion: decisions.appVersion,
      maxInstances: 1,
      "wdio:obsidianOptions": options,
    },
  ];
}
