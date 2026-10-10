import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CodexBridgeStatus } from "@ccc/domain";
import {
  BRIDGE_DIRECTORY_NAMES,
  BRIDGE_HEARTBEAT_FRESH_MS,
  BRIDGE_PROTOCOL_MARKER_FILE,
  BRIDGE_PROTOCOL_VERSION,
  bridgeCommandPath,
  bridgeStateDir,
} from "@ccc/launchers";

/**
 * What the service can see of the codex-bridge (plan 05.1-13, R5, R6, D-14): the fixed launcher
 * file, the protocol marker the kit installer writes, and one heartbeat file per IDE window. It is
 * the input to the Antigravity adapter's typed errors and to the Settings status line.
 *
 * Three processes (the launchd service, a shell, the Dock-launched IDE) compute the state
 * directory from their own environment and can disagree. The service therefore looks in two
 * places: the directory its own environment names, then the default under the owner's home. A
 * candidate that is not under the owner's home is never read (an environment variable must not be
 * able to point the service at an arbitrary directory), and a bridge found only in the second place
 * is reported as `different-folder`, never as a bare timeout.
 *
 * The filesystem is injected; the default reads small local files with async fs/promises calls so a
 * stalled volume or a permission prompt cannot block the event loop (and with it the launch cap).
 */

export interface BridgeWindow {
  /** The heartbeat file name without `.json`. */
  readonly key: string;
  readonly folders: readonly string[];
  readonly updatedAt: string;
  /** `null` for a heartbeat of the old shape (extension 0.1.0 wrote neither field). */
  readonly protocol: number | null;
  readonly capabilities: readonly string[] | null;
}

/** `installed-idle` is installed with no fresh window; `outdated` also covers "cannot tell". */
export type BridgeInstallState = "not-installed" | "outdated" | "installed-idle" | "installed";
export type BridgeDirSource = "primary" | "default-fallback";

export interface BridgeStatus {
  readonly state: BridgeInstallState;
  /** The protocol marker's values; `null` when the marker is missing or malformed. */
  readonly protocol: number | null;
  readonly capabilities: readonly string[] | null;
  readonly launcherPresent: boolean;
  /** The state directory the queue is written to. */
  readonly dir: string;
  readonly dirSource: BridgeDirSource;
  /**
   * False when no candidate directory passed the containment check (an environment or a symlink
   * pointed outside the owner's home). Nothing was read, and nothing may be written to `dir`.
   */
  readonly launchable: boolean;
  /** Fresh heartbeats only (updated within the freshness window), in file-name order. */
  readonly windows: readonly BridgeWindow[];
}

export interface BridgeStateFs {
  /** Entry names, or `null` when the directory cannot be read. */
  readdir(path: string): Promise<string[] | null>;
  /** UTF-8 text of a small file, or `null` when it cannot be read. */
  readFile(path: string): Promise<string | null>;
  /** `stat` (following symlinks), or `null` when nothing is there. */
  stat(path: string): Promise<{
    readonly isFile: boolean;
    readonly isDirectory: boolean;
    readonly mode: number;
  } | null>;
  /** The real path, or `null` when nothing is there. */
  realpath(path: string): Promise<string | null>;
}

/** Heartbeats and the marker are tiny; anything larger is not one. */
const MAX_FILE_BYTES = 64 * 1024;

export const nodeBridgeStateFs: BridgeStateFs = {
  async readdir(path) {
    try {
      return await readdir(path);
    } catch {
      return null;
    }
  },
  async readFile(path) {
    try {
      if ((await stat(path)).size > MAX_FILE_BYTES) return null;
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
  async stat(path) {
    try {
      const info = await stat(path);
      return { isFile: info.isFile(), isDirectory: info.isDirectory(), mode: info.mode };
    } catch {
      return null;
    }
  },
  async realpath(path) {
    try {
      return await realpath(path);
    } catch {
      return null;
    }
  },
};

export interface ReadBridgeStatusOptions {
  /** The service's own environment (only `XDG_STATE_HOME` is consulted). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The owner's home directory. */
  readonly home: string;
  /** A fixed time or a clock; defaults to `Date.now`. */
  readonly now?: number | (() => number);
  readonly fs?: BridgeStateFs;
  /**
   * Only consider candidate directories whose real path contains this path (a run record's state
   * directory), so a follow request is queued where the extension can accept the live log.
   */
  readonly containing?: string;
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/** True when the extension in a window (or the kit marker) can claim agent requests. */
export function hasAgentCapability(x: {
  readonly protocol: number | null;
  readonly capabilities: readonly string[] | null;
}): boolean {
  return (
    x.protocol !== null &&
    x.protocol >= BRIDGE_PROTOCOL_VERSION &&
    x.capabilities?.includes("agent") === true
  );
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

interface Marker {
  readonly protocol: number;
  readonly capabilities: readonly string[];
}

/** The same acceptance as the bridge's own marker reader. */
async function readMarker(fs: BridgeStateFs, dir: string): Promise<Marker | null> {
  const raw = parseJson(await fs.readFile(join(dir, BRIDGE_PROTOCOL_MARKER_FILE)));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const marker = raw as Record<string, unknown>;
  if (!Number.isInteger(marker.protocol) || typeof marker.kit !== "string") return null;
  if (!isStringArray(marker.capabilities)) return null;
  return { protocol: marker.protocol as number, capabilities: marker.capabilities };
}

async function readWindows(fs: BridgeStateFs, dir: string, nowMs: number): Promise<BridgeWindow[]> {
  const windowsDir = join(dir, BRIDGE_DIRECTORY_NAMES.windows);
  const names = await fs.readdir(windowsDir);
  if (names === null) return [];
  const found: BridgeWindow[] = [];
  for (const name of [...names].sort()) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const raw = parseJson(await fs.readFile(join(windowsDir, name)));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const heartbeat = raw as Record<string, unknown>;
    const at =
      typeof heartbeat.updatedAt === "string" ? Date.parse(heartbeat.updatedAt) : Number.NaN;
    if (!Number.isFinite(at) || nowMs - at > BRIDGE_HEARTBEAT_FRESH_MS) continue;
    if (!Array.isArray(heartbeat.folders)) continue;
    found.push({
      key: name.slice(0, -".json".length),
      folders: heartbeat.folders.filter((folder): folder is string => typeof folder === "string"),
      updatedAt: heartbeat.updatedAt as string,
      protocol: Number.isInteger(heartbeat.protocol) ? (heartbeat.protocol as number) : null,
      capabilities: isStringArray(heartbeat.capabilities) ? heartbeat.capabilities : null,
    });
  }
  return found;
}

async function hasBridge(fs: BridgeStateFs, dir: string): Promise<boolean> {
  if ((await readMarker(fs, dir)) !== null) return true;
  const names = await fs.readdir(join(dir, BRIDGE_DIRECTORY_NAMES.windows));
  return names?.some((name) => name.endsWith(".json") && !name.startsWith(".")) === true;
}

/**
 * Reads the bridge state. Never throws: an unreadable directory is simply "nothing there". The
 * classification is global (any fresh window that cannot claim agent requests makes the whole
 * bridge `outdated`); {@link coveringWindows} narrows it to one project.
 */
export async function readBridgeStatus(options: ReadBridgeStatusOptions): Promise<BridgeStatus> {
  const fs = options.fs ?? nodeBridgeStateFs;
  const nowMs = typeof options.now === "function" ? options.now() : (options.now ?? Date.now());
  const { home } = options;
  const homeReal = (await fs.realpath(home)) ?? home;

  /** Under the owner's home, lexically and (when it exists) after following symlinks. */
  const acceptable = async (dir: string): Promise<boolean> => {
    if (!isInside(dir, home) && !isInside(dir, homeReal)) return false;
    const real = await fs.realpath(dir);
    return real === null || isInside(real, homeReal);
  };

  const primary = bridgeStateDir(options.env, home);
  const fallback = bridgeStateDir({}, home);
  const candidates: string[] = [];
  if (await acceptable(primary)) candidates.push(primary);
  if (fallback !== primary && (await acceptable(fallback))) candidates.push(fallback);

  if (options.containing !== undefined) {
    const wanted = options.containing;
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const candidate = candidates[i] as string;
      if (!isInside(wanted, (await fs.realpath(candidate)) ?? candidate)) candidates.splice(i, 1);
    }
  }

  let chosen: string | undefined;
  for (const candidate of candidates) {
    if (await hasBridge(fs, candidate)) {
      chosen = candidate;
      break;
    }
  }
  const launchable = candidates.length > 0;
  const dir = chosen ?? candidates[0] ?? fallback;
  const dirSource: BridgeDirSource =
    chosen !== undefined && chosen !== primary ? "default-fallback" : "primary";

  const launcher = await fs.stat(bridgeCommandPath(home));
  const launcherPresent = launcher?.isFile === true && (launcher.mode & 0o111) !== 0;
  // A rejected directory is never read: no marker, no heartbeats.
  const marker = launchable ? await readMarker(fs, dir) : null;
  const windows = launchable ? await readWindows(fs, dir, nowMs) : [];

  let state: BridgeInstallState;
  if (!launcherPresent || !launchable) state = "not-installed";
  else if (windows.some((window) => !hasAgentCapability(window))) state = "outdated";
  else if (marker !== null && !hasAgentCapability(marker)) state = "outdated";
  else if (windows.length > 0) state = "installed";
  else state = marker !== null ? "installed-idle" : "outdated";

  return {
    state,
    protocol: marker?.protocol ?? null,
    capabilities: marker?.capabilities ?? null,
    launcherPresent,
    dir,
    dirSource,
    launchable,
    windows,
  };
}

/** An absolute path that is an existing directory, as its real path. */
async function realDir(
  fs: Pick<BridgeStateFs, "realpath" | "stat">,
  path: string,
): Promise<string | null> {
  if (!path.startsWith("/")) return null;
  const real = await fs.realpath(path);
  if (real === null) return null;
  return (await fs.stat(real))?.isDirectory === true ? real : null;
}

/**
 * Every fresh window that has the project open, in file-name order: a window whose folder is the
 * project, or contains it, by real path (the bridge's own folder match).
 */
export async function coveringWindows(
  status: BridgeStatus,
  projectRoot: string,
  fs: Pick<BridgeStateFs, "realpath" | "stat"> = nodeBridgeStateFs,
): Promise<BridgeWindow[]> {
  const root = await realDir(fs, projectRoot);
  if (root === null) return [];
  const covering: BridgeWindow[] = [];
  for (const window of status.windows) {
    for (const folder of window.folders) {
      const real = await realDir(fs, folder);
      if (real !== null && isInside(root, real)) {
        covering.push(window);
        break;
      }
    }
  }
  return covering;
}

/** The first window that has the project open, or `null`. */
export async function coveringWindow(
  status: BridgeStatus,
  projectRoot: string,
  fs: Pick<BridgeStateFs, "realpath" | "stat"> = nodeBridgeStateFs,
): Promise<BridgeWindow | null> {
  return (await coveringWindows(status, projectRoot, fs))[0] ?? null;
}

/** The Settings status line's view: a bridge found only in the default folder is `different-folder`. */
export function toBridgeStatusView(status: BridgeStatus): CodexBridgeStatus {
  let newest = Number.NEGATIVE_INFINITY;
  for (const window of status.windows) {
    const at = Date.parse(window.updatedAt);
    if (at > newest) newest = at;
  }
  const state =
    status.dirSource === "default-fallback" && status.state !== "not-installed"
      ? "different-folder"
      : status.state;
  return {
    state,
    lastWindowAt: Number.isFinite(newest) ? new Date(newest).toISOString() : null,
  };
}
