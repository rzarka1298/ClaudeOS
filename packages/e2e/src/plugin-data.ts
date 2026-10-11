import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Plugin data seeding and plugin staging for the sandbox Obsidian (05.2-04, D-05, D-07).
 *
 * The vault's own `data.json` is written BEFORE the first launch with exactly the four
 * settings keys and `socketPathOverride` pointing at the sandbox socket. That is the first
 * of two layers keeping the sandbox plugin off the owner's service; the second is the
 * `CCC_SOCKET_PATH` environment of the wdio process (the plugin reads the override first,
 * then the environment, then the real default). Only `main.js`, `manifest.json` and
 * `styles.css` are staged as the plugin folder, so no `data.json` or `layout.json` from
 * the build tree can ever reach the sandbox.
 *
 * This module imports nothing from the plugin package or Obsidian: the key list below
 * mirrors `CommandCenterSettings` and the test pins it.
 */

export const PLUGIN_ID = "claude-command-center";

/** The four settings keys the plugin persists (mirrors CommandCenterSettings). */
export const PLUGIN_DATA_KEYS: readonly string[] = Object.freeze([
  "socketPathOverride",
  "lastOpenedDestination",
  "reducedMotion",
  "notifyApprovals",
]);

/** The only files the build tree contributes to the staged plugin folder. */
export const PLUGIN_STAGE_FILES: readonly string[] = Object.freeze([
  "main.js",
  "manifest.json",
  "styles.css",
]);

/** Case-insensitive credential-key pattern, the same shape the plugin's own guard uses. */
const CREDENTIAL_KEY_PATTERN = /token|secret|password|authorization/i;

export interface PluginData {
  socketPathOverride: string;
  lastOpenedDestination: "overview";
  reducedMotion: "auto";
  notifyApprovals: true;
}

/** The data.json contents for the sandbox plugin. */
export function buildPluginData(input: { socketPath: string }): PluginData {
  if (input.socketPath === "" || !isAbsolute(input.socketPath)) {
    throw new Error("The sandbox socket path must be a non-empty absolute path.");
  }
  return {
    socketPathOverride: input.socketPath,
    lastOpenedDestination: "overview",
    reducedMotion: "auto",
    notifyApprovals: true,
  };
}

/** Throws unless `data` has exactly the four settings keys and no credential-shaped key. */
export function assertPluginDataKeys(data: unknown): void {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Plugin data must be an object.");
  }
  const keys = Object.keys(data);
  if (keys.some((key) => CREDENTIAL_KEY_PATTERN.test(key))) {
    throw new Error("Plugin data must not contain a credential-shaped key.");
  }
  const expected = [...PLUGIN_DATA_KEYS].sort();
  const actual = [...keys].sort();
  if (expected.length !== actual.length || expected.some((key, i) => key !== actual[i])) {
    throw new Error("Plugin data must have exactly the four settings keys.");
  }
}

/** Resolves a path through real paths even when its tail does not exist yet. */
export function realResolve(path: string): string {
  const absolute = resolve(path);
  const tail: string[] = [];
  let current = absolute;
  while (!existsSync(current)) {
    tail.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(realpathSync(current), ...tail);
}

/** True when `child` is strictly below `root` once both are resolved through real paths. */
export function isStrictlyInside(root: string, child: string): boolean {
  const realRoot = realResolve(root);
  const realChild = realResolve(child);
  return realChild !== realRoot && realChild.startsWith(realRoot + sep);
}

const OUTSIDE_RUN_ROOT = "The vault folder is not inside the run root.";

/** Writes `.obsidian/plugins/<id>/data.json` (mode 0600) inside a vault under the run root. */
export function seedPluginData(input: {
  runRoot: string;
  vaultDir: string;
  data: PluginData;
}): string {
  assertPluginDataKeys(input.data);
  if (!isStrictlyInside(input.runRoot, input.vaultDir)) throw new Error(OUTSIDE_RUN_ROOT);
  const pluginDir = join(input.vaultDir, ".obsidian", "plugins", PLUGIN_ID);
  mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
  const target = join(pluginDir, "data.json");
  writeFileSync(target, `${JSON.stringify(input.data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(target, 0o600);
  return target;
}

/**
 * Copies exactly main.js, manifest.json and styles.css from the build folder into a new or
 * empty stage folder (mode 0700, files 0600). Anything else in the build folder is ignored.
 */
export function stagePlugin(input: { buildDir: string; stageDir: string }): void {
  for (const name of PLUGIN_STAGE_FILES) {
    if (!existsSync(join(input.buildDir, name))) {
      throw new Error(`Plugin build output is missing ${name}; build the plugin first.`);
    }
  }
  if (existsSync(input.stageDir) && readdirSync(input.stageDir).length > 0) {
    throw new Error("The plugin stage folder is not empty.");
  }
  mkdirSync(input.stageDir, { recursive: true, mode: 0o700 });
  chmodSync(input.stageDir, 0o700);
  for (const name of PLUGIN_STAGE_FILES) {
    const target = join(input.stageDir, name);
    copyFileSync(join(input.buildDir, name), target);
    chmodSync(target, 0o600);
  }
}
