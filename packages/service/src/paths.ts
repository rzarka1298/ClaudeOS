import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";

const SUN_PATH_MAX_BYTES = 104;

/** Group/other bits — any of these set means the directory is readable/writable/executable
 * by accounts other than its owner. */
const GROUP_OTHER_PERMISSION_MASK = 0o077;

/**
 * Thrown when a resolved socket path is at or above the 104-byte macOS
 * `sun_path` cap. ADR-0001 records that the randomized per-user temporary
 * directory is exactly what broke a comparable project at 116 characters —
 * this is why the runtime directory is a short, fixed path under `$HOME`.
 */
export class SocketPathTooLongError extends Error {
  constructor(path: string, byteLength: number) {
    super(
      `Resolved socket path is ${byteLength} bytes, at or above the ${SUN_PATH_MAX_BYTES}-byte macOS sun_path cap: ${path}`,
    );
    this.name = "SocketPathTooLongError";
  }
}

/** The short, fixed runtime directory holding the socket, database, logs, and spool. */
export function resolveRuntimeDir(): string {
  return process.env.CCC_RUNTIME_DIR ?? join(homedir(), ".claude-command-center");
}

/**
 * Creates `runtimeDir` if absent, then unconditionally verifies its mode
 * and repairs it if needed. `mkdirSync(..., { mode: 0o700 })` only applies
 * `mode` when it actually creates the directory — Node (like POSIX
 * `mkdir(2)`) silently ignores `mode` when the directory already exists,
 * so a pre-existing runtime directory left group/other-readable (e.g.
 * from an old installation, a restored backup, or a permissive umask)
 * would stay that way forever, exposing the DB/spool/logs that sit
 * beside the 0600 socket to other local accounts. This always `stat`s
 * after `mkdir` and `chmod`s back to `0700` if any group/other bit is
 * set, regardless of whether the directory was just created or already
 * existed.
 */
export function ensureRuntimeDir(runtimeDir: string, logger?: Pick<Logger, "warn">): void {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const { mode } = statSync(runtimeDir);
  if ((mode & GROUP_OTHER_PERMISSION_MASK) !== 0) {
    chmodSync(runtimeDir, 0o700);
    logger?.warn({ runtimeDir }, "runtime dir permissions repaired");
  }
}

/** The Unix domain socket path, guarded against the sun_path cap. */
export function resolveSocketPath(): string {
  const path = process.env.CCC_SOCKET_PATH ?? join(resolveRuntimeDir(), "svc.sock");
  const byteLength = Buffer.byteLength(path);
  if (byteLength >= SUN_PATH_MAX_BYTES) {
    throw new SocketPathTooLongError(path, byteLength);
  }
  return path;
}

/** The better-sqlite3 operational store file path. */
export function resolveDbPath(): string {
  return join(resolveRuntimeDir(), "operational.db");
}

/**
 * The hook spool file `drainSpool` (`./lifecycle/spool-drain.ts`) reads and
 * truncates on every startup — a transient queue, never a retained record
 * of session activity (ADR-0007, ADR-0010).
 */
export function resolveSpoolPath(): string {
  return process.env.CCC_SPOOL_PATH ?? join(resolveRuntimeDir(), "spool", "hooks.ndjson");
}
