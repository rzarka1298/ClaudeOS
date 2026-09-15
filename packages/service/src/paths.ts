import { homedir } from "node:os";
import { join } from "node:path";

const SUN_PATH_MAX_BYTES = 104;

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
