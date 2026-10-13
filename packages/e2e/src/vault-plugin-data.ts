import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  assertNoSymlinkBelow,
  canonicalPath,
  isStrictlyInside,
  isSymlinkOnDisk,
  MSG_PATH_LINK,
} from "./canonical-path.js";
import { assertRunRoot } from "./launch-options.js";

/**
 * Socket isolation against the sandbox vault's persisted plugin settings (Codex finding 1,
 * 05.2 D-05, L-3). The plugin resolves its service socket as `socketPathOverride` first and
 * `CCC_SOCKET_PATH` only second (packages/plugin/src/socket-path.ts), so an environment
 * guard alone is bypassed by a vault whose `data.json` still names the owner's live socket,
 * and spike S1 would then post a test approval into the owner's store. Before launch the
 * runner therefore writes (or merges into) the vault's plugin data file a
 * `socketPathOverride` equal to `CCC_SOCKET_PATH`, replacing any conflicting value, and
 * reads the file back to verify. Spikes S0 and S1 re-check the same fact from inside the
 * renderer with {@link evaluateSocketIsolation}.
 *
 * Filesystem use is limited to the plugin data file and `realpath`; both are injectable.
 * Every refusal is a fixed message that does not echo a path or a settings value.
 */

export const PLUGIN_ID = "claude-command-center";
/** Where Obsidian keeps a plugin's `loadData` file, relative to the vault root. */
export const PLUGIN_DATA_RELATIVE = join(".obsidian", "plugins", PLUGIN_ID, "data.json");

export const MSG_SOCKET_OUTSIDE =
  "Refusing a socket path that is not strictly inside the run root, or that is the owner's live socket.";
export const MSG_VAULT_OUTSIDE = "Refusing a vault outside the run root.";
export { MSG_PATH_LINK };
export const MSG_DATA_MALFORMED = "Refusing a plugin data.json that is not a JSON object.";
export const MSG_DATA_VERIFY =
  "The plugin data.json does not hold the isolated socket path after writing.";

export interface PluginDataFs {
  /** The file's text, or null when it does not exist. */
  readFile(path: string): string | null;
  /** Writes the whole file atomically (temporary file in the same directory, then rename). */
  writeFileAtomic(path: string, text: string): void;
  mkdirp(path: string): void;
  /** True when `path` itself is a symbolic link (live or dangling). */
  isSymlink(path: string): boolean;
}

export const REAL_PLUGIN_DATA_FS: PluginDataFs = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  writeFileAtomic(path, text) {
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, text, { mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  },
  mkdirp(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  },
  isSymlink: isSymlinkOnDisk,
};

export interface PluginDataPlan {
  /** The full new file text. */
  text: string;
  /** True when a different, non-null override was present and has been replaced. */
  replacedPrevious: boolean;
}

function parseObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(MSG_DATA_MALFORMED);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(MSG_DATA_MALFORMED);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Pure merge: the existing settings (or none) with `socketPathOverride` set to `socketPath`.
 * Every other key is kept as is, so a seeded vault's settings survive.
 */
export function planPluginData(existingText: string | null, socketPath: string): PluginDataPlan {
  const existing = existingText === null ? {} : parseObject(existingText);
  const previous = existing.socketPathOverride;
  const merged = { ...existing, socketPathOverride: socketPath };
  return {
    text: `${JSON.stringify(merged, null, 2)}\n`,
    replacedPrevious: previous !== undefined && previous !== null && previous !== socketPath,
  };
}

export interface IsolatePluginDataInput {
  vaultPath: string;
  runRoot: string;
  /** Must equal CCC_SOCKET_PATH and sit strictly inside the run root. */
  socketPath: string;
  homeDir?: string;
  fs?: PluginDataFs;
}

export interface IsolatePluginDataResult {
  /** The plugin data file that was written. */
  dataPath: string;
  /** Whether a conflicting persisted override was found and replaced. */
  replacedPrevious: boolean;
}

/**
 * Writes the isolated `socketPathOverride` into the vault's plugin data file and verifies it.
 * Call it before the capabilities are built, so nothing can launch with the persisted value.
 */
export function isolatePluginData(input: IsolatePluginDataInput): IsolatePluginDataResult {
  const fs = input.fs ?? REAL_PLUGIN_DATA_FS;
  const home = resolve(input.homeDir ?? homedir());
  const runRoot = assertRunRoot(input.runRoot, home);

  if (!isAbsolute(input.vaultPath)) throw new Error(MSG_VAULT_OUTSIDE);
  const vault = canonicalPath(input.vaultPath);
  if (!isStrictlyInside(runRoot, vault)) throw new Error(MSG_VAULT_OUTSIDE);

  if (!isAbsolute(input.socketPath)) throw new Error(MSG_SOCKET_OUTSIDE);
  const socket = canonicalPath(input.socketPath);
  const liveSocket = canonicalPath(join(home, ".claude-command-center", "svc.sock"));
  if (!isStrictlyInside(runRoot, socket) || socket === liveSocket) {
    throw new Error(MSG_SOCKET_OUTSIDE);
  }

  // The vault root is canonical, but the folders below it are not: a link at .obsidian,
  // plugins or the plugin folder (or at data.json) would carry the write out of the run root.
  // Check every component, and the resolved destination, before reading or writing anything.
  assertNoSymlinkBelow(vault, PLUGIN_DATA_RELATIVE, (path) => fs.isSymlink(path));
  const dataPath = join(vault, PLUGIN_DATA_RELATIVE);
  if (!isStrictlyInside(runRoot, canonicalPath(dirname(dataPath)))) {
    throw new Error(MSG_PATH_LINK);
  }
  const plan = planPluginData(fs.readFile(dataPath), input.socketPath);
  fs.mkdirp(dirname(dataPath));
  fs.writeFileAtomic(dataPath, plan.text);

  const written = fs.readFile(dataPath);
  const override = written === null ? undefined : parseObject(written).socketPathOverride;
  if (override !== input.socketPath) throw new Error(MSG_DATA_VERIFY);
  return { dataPath, replacedPrevious: plan.replacedPrevious };
}

export interface SocketIsolationFacts {
  /** CCC_SOCKET_PATH as the wdio worker holds it (the run-root socket). */
  expected: string | undefined;
  /** CCC_SOCKET_PATH as the Obsidian renderer sees it, or null when unreadable. */
  seenByRenderer: string | null;
  /** socketPathOverride read back from the launched vault's data.json; null or undefined if none. */
  persistedOverride?: string | null | undefined;
}

export interface SocketIsolationVerdict {
  ok: boolean;
  /** A fixed explanation; it never contains a path. */
  reason: string;
}

/** The S0 and S1 gate: the sandbox plugin provably talks to the run-root socket and no other. */
export function evaluateSocketIsolation(facts: SocketIsolationFacts): SocketIsolationVerdict {
  if (facts.expected === undefined || facts.expected === "") {
    return { ok: false, reason: "the run-root socket path (CCC_SOCKET_PATH) is not set" };
  }
  if (facts.seenByRenderer === null || facts.seenByRenderer === "") {
    return { ok: false, reason: "the renderer cannot see CCC_SOCKET_PATH" };
  }
  if (facts.seenByRenderer !== facts.expected) {
    return { ok: false, reason: "the renderer sees a socket path other than the run-root socket" };
  }
  const persisted = facts.persistedOverride;
  if (persisted !== undefined && persisted !== null && persisted !== facts.expected) {
    return {
      ok: false,
      reason: "the vault's persisted socketPathOverride is not the run-root socket",
    };
  }
  return { ok: true, reason: "the renderer and the persisted settings use the run-root socket" };
}
