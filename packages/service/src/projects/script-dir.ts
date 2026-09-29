import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import { ensureRuntimeDir } from "../paths.js";

/**
 * The generated launch script's lifecycle (D-20, ADR-0024 "Script lifecycle").
 *
 * The one shell-parsed artifact in the product lives only here:
 * `<runtimeDir>/launch`, a 0700 directory inside the service's own 0700
 * runtime directory. Never the system temporary directory (ADR-0001: a
 * randomized per-user temp path is long, shared with every other tool the
 * owner runs, and swept by the OS on its own schedule), never the
 * repository and never the vault.
 *
 * - Each script is created with `wx` (O_CREAT | O_EXCL, so an existing file
 *   or a planted symlink at the name makes the write fail) and mode 0o700,
 *   under a 128-bit random name.
 * - The script deletes itself as its first action (`rm -f -- "$0"`). The
 *   service never deletes a script it has handed off: Terminal may not have
 *   read it yet (Pitfall 5).
 * - A hand-off that was interrupted (Terminal never ran the script) leaves
 *   the file here. Service startup deletes leftovers older than
 *   {@link STARTUP_SCRIPT_MIN_AGE_MS}, and each launch deletes any older
 *   than {@link SCRIPT_MAX_AGE_MS} — both long past any hand-off, so never a
 *   just-handed-off file (a launchd KeepAlive restart can follow a hand-off
 *   within seconds, before Terminal has read the script).
 */

export const SCRIPT_DIR_NAME = "launch";

/** A leftover script older than this is swept by the next launch. */
export const SCRIPT_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * A leftover script older than this is swept at service startup. Short,
 * because a restart means no launch of the previous process is still
 * pending for long — but never zero, because Terminal may not yet have
 * read a script handed off just before the restart.
 */
export const STARTUP_SCRIPT_MIN_AGE_MS = 60 * 1000;

const SCRIPT_SUFFIX = ".command";

/** An age threshold ({@link STARTUP_SCRIPT_MIN_AGE_MS} at startup, {@link SCRIPT_MAX_AGE_MS} per launch), or `{ all: true }`. */
export type SweepOptions =
  | { readonly all: true }
  | { readonly olderThanMs: number; readonly now?: number };

/** Thrown when `<runtimeDir>/launch` exists but is not a real directory (a symlink or a file). */
export class ScriptDirError extends Error {
  constructor() {
    super("the launch script directory is not a directory");
    this.name = "ScriptDirError";
  }
}

function refuseNonDirectory(dir: string): void {
  let isDirectory: boolean;
  try {
    isDirectory = lstatSync(dir).isDirectory();
  } catch (err: unknown) {
    if ((err as { code?: unknown } | null)?.code === "ENOENT") return;
    throw err;
  }
  if (!isDirectory) throw new ScriptDirError();
}

/**
 * Creates `<runtimeDir>/launch` at 0700, or repairs an existing one back to
 * 0700, and returns it. A symlink or a file at that name is refused before
 * anything follows it.
 */
export function ensureScriptDir(runtimeDir: string, logger?: Pick<Logger, "warn">): string {
  const dir = join(runtimeDir, SCRIPT_DIR_NAME);
  refuseNonDirectory(dir);
  ensureRuntimeDir(dir, logger);
  return dir;
}

/**
 * Writes `body` to a new `<32 hex>.command` file in `dir` with mode 0o700
 * and returns its path. Throws when the file cannot be created — the
 * directory is never created here.
 */
export function writeLaunchScript(dir: string, body: string): string {
  const path = join(dir, `${randomBytes(16).toString("hex")}${SCRIPT_SUFFIX}`);
  writeFileSync(path, body, { flag: "wx", mode: 0o700 });
  return path;
}

/**
 * Deletes leftover `.command` files in `dir` and answers how many went.
 * Other files (and anything that is not a regular file) are left alone; a
 * missing directory sweeps nothing. A file that vanishes mid-sweep (a
 * script deleting itself) is not an error.
 */
export function sweepStaleScripts(dir: string, options: SweepOptions = { all: true }): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const threshold = "olderThanMs" in options ? options : null;
  const now = threshold?.now ?? Date.now();
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(SCRIPT_SUFFIX)) continue;
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) continue;
      if (threshold !== null && now - stat.mtimeMs <= threshold.olderThanMs) continue;
      unlinkSync(path);
      removed += 1;
    } catch {
      // Gone already (the script removed itself) or unreadable: skip it.
    }
  }
  return removed;
}
