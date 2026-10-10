import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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
 * The filesystem is injected; the default reads small local files synchronously.
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
  /** Fresh heartbeats only (updated within the freshness window), in file-name order. */
  readonly windows: readonly BridgeWindow[];
}

export interface BridgeStateFs {
  /** Entry names, or `null` when the directory cannot be read. */
  readdir(path: string): string[] | null;
  /** UTF-8 text of a small file, or `null` when it cannot be read. */
  readFile(path: string): string | null;
  /** `stat` (following symlinks), or `null` when nothing is there. */
  stat(
    path: string,
  ): { readonly isFile: boolean; readonly isDirectory: boolean; readonly mode: number } | null;
  /** The real path, or `null` when nothing is there. */
  realpath(path: string): string | null;
}

/** Heartbeats and the marker are tiny; anything larger is not one. */
const MAX_FILE_BYTES = 64 * 1024;

export const nodeBridgeStateFs: BridgeStateFs = {
  readdir(path) {
    try {
      return readdirSync(path);
    } catch {
      return null;
    }
  },
  readFile(path) {
    try {
      if (statSync(path).size > MAX_FILE_BYTES) return null;
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  stat(path) {
    try {
      const info = statSync(path);
      return { isFile: info.isFile(), isDirectory: info.isDirectory(), mode: info.mode };
    } catch {
      return null;
    }
  },
  realpath(path) {
    try {
      return realpathSync(path);
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
function readMarker(fs: BridgeStateFs, dir: string): Marker | null {
  const raw = parseJson(fs.readFile(join(dir, BRIDGE_PROTOCOL_MARKER_FILE)));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const marker = raw as Record<string, unknown>;
  if (!Number.isInteger(marker.protocol) || typeof marker.kit !== "string") return null;
  if (!isStringArray(marker.capabilities)) return null;
  return { protocol: marker.protocol as number, capabilities: marker.capabilities };
}

function readWindows(fs: BridgeStateFs, dir: string, nowMs: number): BridgeWindow[] {
  const windowsDir = join(dir, BRIDGE_DIRECTORY_NAMES.windows);
  const names = fs.readdir(windowsDir);
  if (names === null) return [];
  const found: BridgeWindow[] = [];
  for (const name of [...names].sort()) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const raw = parseJson(fs.readFile(join(windowsDir, name)));
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

function hasBridge(fs: BridgeStateFs, dir: string): boolean {
  if (readMarker(fs, dir) !== null) return true;
  const names = fs.readdir(join(dir, BRIDGE_DIRECTORY_NAMES.windows));
  return names?.some((name) => name.endsWith(".json") && !name.startsWith(".")) === true;
}

/**
 * Reads the bridge state. Never throws: an unreadable directory is simply "nothing there". The
 * classification is global (any fresh window that cannot claim agent requests makes the whole
 * bridge `outdated`); {@link coveringWindows} narrows it to one project.
 */
export function readBridgeStatus(options: ReadBridgeStatusOptions): BridgeStatus {
  const fs = options.fs ?? nodeBridgeStateFs;
  const nowMs = typeof options.now === "function" ? options.now() : (options.now ?? Date.now());
  const { home } = options;
  const homeReal = fs.realpath(home) ?? home;

  /** Under the owner's home, lexically and (when it exists) after following symlinks. */
  const acceptable = (dir: string): boolean => {
    if (!isInside(dir, home) && !isInside(dir, homeReal)) return false;
    const real = fs.realpath(dir);
    return real === null || isInside(real, homeReal);
  };

  const primary = bridgeStateDir(options.env, home);
  const fallback = bridgeStateDir({}, home);
  const candidates: string[] = [];
  if (acceptable(primary)) candidates.push(primary);
  if (fallback !== primary && acceptable(fallback)) candidates.push(fallback);

  const chosen = candidates.find((dir) => hasBridge(fs, dir));
  const dir = chosen ?? candidates[0] ?? fallback;
  const dirSource: BridgeDirSource =
    chosen !== undefined && chosen !== primary ? "default-fallback" : "primary";

  const launcher = fs.stat(bridgeCommandPath(home));
  const launcherPresent = launcher?.isFile === true && (launcher.mode & 0o111) !== 0;
  const marker = readMarker(fs, dir);
  const windows = readWindows(fs, dir, nowMs);

  let state: BridgeInstallState;
  if (!launcherPresent) state = "not-installed";
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
    windows,
  };
}

/** An absolute path that is an existing directory, as its real path. */
function realDir(fs: Pick<BridgeStateFs, "realpath" | "stat">, path: string): string | null {
  if (!path.startsWith("/")) return null;
  const real = fs.realpath(path);
  if (real === null) return null;
  return fs.stat(real)?.isDirectory === true ? real : null;
}

/**
 * Every fresh window that has the project open, in file-name order: a window whose folder is the
 * project, or contains it, by real path (the bridge's own folder match).
 */
export function coveringWindows(
  status: BridgeStatus,
  projectRoot: string,
  fs: Pick<BridgeStateFs, "realpath" | "stat"> = nodeBridgeStateFs,
): BridgeWindow[] {
  const root = realDir(fs, projectRoot);
  if (root === null) return [];
  return status.windows.filter((window) =>
    window.folders.some((folder) => {
      const real = realDir(fs, folder);
      return real !== null && isInside(root, real);
    }),
  );
}

/** The first window that has the project open, or `null`. */
export function coveringWindow(
  status: BridgeStatus,
  projectRoot: string,
  fs: Pick<BridgeStateFs, "realpath" | "stat"> = nodeBridgeStateFs,
): BridgeWindow | null {
  return coveringWindows(status, projectRoot, fs)[0] ?? null;
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
