import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { checkPathContainmentResolved } from "@ccc/domain";

/**
 * The one read-only door into Codex's home directory (CODEX-09, D-26, D-29).
 *
 * Codex's home holds the owner's credentials next to the files the product
 * legitimately reads. So every read goes through this port, and the port can
 * only be asked for names on a POSITIVE allowlist:
 *
 *   - the state database (a path only; the store reader opens it read-only),
 *   - three small named files (session index, version file, hooks file),
 *   - rollout files under `sessions/YYYY/MM/DD/rollout-*.jsonl`.
 *
 * Anything else, a traversal, an archived path or a symlink that resolves
 * outside the sessions folder, throws {@link CodexHomeAccessError} BEFORE the
 * file system is touched where the argument alone decides it (the syntactic
 * checks), and before any open or read where a symlink must be resolved.
 * There is no member that writes, creates, deletes, renames or changes
 * anything: the injected file-system object offers read operations only.
 *
 * The allowlist is data in this file; the credential and config file names
 * are never spelled in non-test source (the plan 05 backstop), so the
 * allowlist can only ever grow by an explicit, reviewed edit here.
 */

/** Fixed refusal codes; the message carries the code and never the offending value. */
export type CodexHomeAccessCode =
  | "name-not-allowed"
  | "path-not-allowed"
  | "archived"
  | "bad-rollout-name"
  | "escape"
  | "unreadable"
  | "bad-argument"
  | "real-home-under-test";

export class CodexHomeAccessError extends Error {
  readonly code: CodexHomeAccessCode;

  constructor(code: CodexHomeAccessCode) {
    super(`codex home access refused: ${code}`);
    this.name = "CodexHomeAccessError";
    this.code = code;
  }
}

export interface CodexFileStat {
  readonly isFile: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface CodexDirEntry {
  readonly name: string;
  /** True for a regular file; false for a directory, a symlink or anything else. */
  readonly isFile: boolean;
}

/**
 * The read-only file-system operations the port needs. Injectable so a test
 * can record every path the port touches. There is no write member by type.
 */
export interface CodexFs {
  realpath(path: string): string;
  stat(path: string): CodexFileStat;
  readDir(path: string): readonly CodexDirEntry[];
  /** Opens read-only, reads up to `length` bytes at `offset`, closes. */
  readBytes(path: string, offset: number, length: number): Buffer;
}

export const defaultCodexFs: CodexFs = {
  realpath: (path) => realpathSync.native(path),
  stat: (path) => {
    const stat = statSync(path);
    return { isFile: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs };
  },
  readDir: (path) =>
    readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
    })),
  readBytes: (path, offset, length) => {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, offset);
      return buffer.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  },
};

/** The small files readable by name. The state database is a path, not a byte read. */
export const CODEX_HOME_READABLE_NAMES = [
  "session_index.jsonl",
  "version.json",
  "hooks.json",
] as const;
export type CodexHomeReadableName = (typeof CODEX_HOME_READABLE_NAMES)[number];

export const CODEX_STATE_DB_NAME = "state_5.sqlite";

/** Byte caps so a hostile or huge file cannot exhaust memory. */
export const MAX_NAMED_READ_BYTES = 4 * 1024 * 1024;
export const MAX_ROLLOUT_READ_BYTES = 1024 * 1024;
/** Bounds on a listing. */
export const MAX_ROLLOUT_LIST = 5000;
export const MAX_ROLLOUT_LIST_DAYS = 400;

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSIONS_DIR = "sessions";
const ARCHIVED_DIR = "archived_sessions";
const ROLLOUT_NAME = /^rollout-[A-Za-z0-9._-]{1,200}\.jsonl$/;
const ROLLOUT_RELATIVE = /^(\d{4})\/(\d{2})\/(\d{2})\/(rollout-[A-Za-z0-9._-]{1,200}\.jsonl)$/;

const READABLE: ReadonlySet<string> = new Set(CODEX_HOME_READABLE_NAMES);

export interface RolloutRef {
  readonly path: string;
}

export interface BoundedRead {
  readonly bytes: Buffer;
  /** The file's full size, so a caller can tell a short read from the end. */
  readonly size: number;
}

export interface CodexHomePort {
  /** Absolute path of the state database, or null when Codex never created it. */
  stateDbPath(): string | null;
  /** Bytes of one allowlisted small file, or null when it does not exist. */
  readNamed(name: string, maxBytes: number): BoundedRead | null;
  /** Rollout files in dated folders covering the range (padded one day each side). */
  listRolloutFiles(range: { readonly from: number; readonly to: number }): readonly RolloutRef[];
  statRollout(ref: RolloutRef): { readonly size: number; readonly mtimeMs: number } | null;
  readRolloutRange(ref: RolloutRef, offset: number, maxBytes: number): BoundedRead;
  /** The contained real path of a sessions file, or null for anything not openable. */
  resolveSessionsFile(path: string): string | null;
}

/**
 * Where Codex's home is: a test-only `CCC_CODEX_HOME` override, else
 * `CODEX_HOME`, each used only when absolute, else the default under `home`.
 * The service runs under launchd with a minimal environment that never
 * carries the shell's value, so the default is the normal path (R6).
 */
export function resolveCodexHome(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  for (const key of ["CCC_CODEX_HOME", "CODEX_HOME"] as const) {
    const value = env[key];
    if (
      typeof value === "string" &&
      value.length > 0 &&
      !value.includes("\0") &&
      isAbsolute(value)
    ) {
      return resolve(value);
    }
  }
  return join(home, ".codex");
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function unreadable(): CodexHomeAccessError {
  return new CodexHomeAccessError("unreadable");
}

function assertSafeInteger(value: unknown, min: number): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new CodexHomeAccessError("bad-argument");
  }
}

/** The relative `YYYY/MM/DD/rollout-*.jsonl` tail after a sessions prefix, or null. */
function datedTail(relative: string): string | null {
  const match = ROLLOUT_RELATIVE.exec(relative);
  if (match === null) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const name = match[4] ?? "";
  if (month < 1 || month > 12 || day < 1 || day > 31 || name.includes("..")) return null;
  return relative;
}

/**
 * The syntactic half of rollout validation: pure string checks, no file
 * system. Returns the dated tail relative to the sessions folder.
 */
function validateRolloutPath(root: string, candidate: unknown): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new CodexHomeAccessError("bad-argument");
  }
  if (candidate.includes("\0") || !isAbsolute(candidate)) {
    throw new CodexHomeAccessError("path-not-allowed");
  }
  const segments = candidate.split("/");
  if (
    segments.some(
      (segment, index) => index > 0 && (segment === "" || segment === "." || segment === ".."),
    )
  ) {
    throw new CodexHomeAccessError("path-not-allowed");
  }
  const prefix = `${root}/`;
  if (!candidate.startsWith(prefix)) throw new CodexHomeAccessError("path-not-allowed");
  const underRoot = candidate.slice(prefix.length);
  if (underRoot.startsWith(`${ARCHIVED_DIR}/`)) throw new CodexHomeAccessError("archived");
  if (!underRoot.startsWith(`${SESSIONS_DIR}/`)) throw new CodexHomeAccessError("path-not-allowed");
  const tail = underRoot.slice(SESSIONS_DIR.length + 1);
  const dated = datedTail(tail);
  if (dated === null) {
    const name = tail.split("/").pop() ?? "";
    throw new CodexHomeAccessError(
      ROLLOUT_NAME.test(name) ? "path-not-allowed" : "bad-rollout-name",
    );
  }
  return dated;
}

function normalizeRoot(root: string): string {
  const normalized = resolve(root);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/**
 * Builds the port over a Codex home. `fs` is injectable (default: real,
 * read-only operations). Under a test runner the owner's real default home is
 * refused outright, so a test can never read the real credentials directory.
 */
export function createCodexHomePort(options: {
  readonly root: string;
  readonly fs?: CodexFs;
}): CodexHomePort {
  const root = normalizeRoot(options.root);
  const fs = options.fs ?? defaultCodexFs;

  if (process.env.VITEST !== undefined && root === normalizeRoot(join(homedir(), ".codex"))) {
    throw new CodexHomeAccessError("real-home-under-test");
  }

  /** The real path of the home root, or null when it does not exist. */
  function realRoot(): string | null {
    try {
      return fs.realpath(root);
    } catch (error) {
      if (isMissing(error)) return null;
      throw unreadable();
    }
  }

  /** The real path of `<root>/sessions`, or null when it does not exist. */
  function realSessions(): string | null {
    try {
      return fs.realpath(join(root, SESSIONS_DIR));
    } catch (error) {
      if (isMissing(error)) return null;
      throw unreadable();
    }
  }

  /**
   * Resolves a syntactically valid rollout path to its real path, or null
   * when the file (or the sessions folder) does not exist. Throws "escape"
   * when the real path leaves the sessions folder or stops being a dated
   * rollout file.
   */
  function resolveRollout(candidate: unknown): string | null {
    validateRolloutPath(root, candidate);
    const sessions = realSessions();
    if (sessions === null) return null;
    let resolved: string;
    try {
      resolved = fs.realpath(candidate as string);
    } catch (error) {
      if (isMissing(error)) return null;
      throw unreadable();
    }
    const contained = checkPathContainmentResolved(resolved, sessions);
    if (!contained.contained) throw new CodexHomeAccessError("escape");
    if (datedTail(resolved.slice(sessions.length + 1)) === null) {
      throw new CodexHomeAccessError("escape");
    }
    return resolved;
  }

  function statFile(path: string): CodexFileStat | null {
    try {
      const stat = fs.stat(path);
      return stat.isFile ? stat : null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw unreadable();
    }
  }

  function readBounded(path: string, size: number, offset: number, cap: number): BoundedRead {
    const length = Math.min(cap, Math.max(0, size - offset));
    if (length === 0) return { bytes: Buffer.alloc(0), size };
    try {
      return { bytes: fs.readBytes(path, offset, length), size };
    } catch {
      throw unreadable();
    }
  }

  /** The real path of a top-level allowlisted file, or null when absent. */
  function resolveTopLevel(name: string): string | null {
    const base = realRoot();
    if (base === null) return null;
    const target = join(base, name);
    let resolved: string;
    try {
      resolved = fs.realpath(target);
    } catch (error) {
      if (isMissing(error)) return null;
      throw unreadable();
    }
    // A symlink that resolves to any other file is an escape, even one that
    // stays inside the home.
    if (resolved !== target) throw new CodexHomeAccessError("escape");
    return target;
  }

  return Object.freeze({
    stateDbPath(): string | null {
      const target = resolveTopLevel(CODEX_STATE_DB_NAME);
      if (target === null) return null;
      return statFile(target) === null ? null : target;
    },

    readNamed(name: string, maxBytes: number): BoundedRead | null {
      // The allowlist is checked FIRST: nothing else runs for a refused name.
      if (typeof name !== "string" || !READABLE.has(name)) {
        throw new CodexHomeAccessError("name-not-allowed");
      }
      assertSafeInteger(maxBytes, 1);
      const target = resolveTopLevel(name);
      if (target === null) return null;
      const stat = statFile(target);
      if (stat === null) return null;
      return readBounded(target, stat.size, 0, Math.min(maxBytes, MAX_NAMED_READ_BYTES));
    },

    listRolloutFiles(range: { readonly from: number; readonly to: number }): readonly RolloutRef[] {
      const { from, to } = range;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
        throw new CodexHomeAccessError("bad-argument");
      }
      const firstDay = Math.floor(from / DAY_MS) - 1;
      const lastDay = Math.floor(to / DAY_MS) + 1;
      if (lastDay - firstDay + 1 > MAX_ROLLOUT_LIST_DAYS) {
        throw new CodexHomeAccessError("bad-argument");
      }
      const sessions = realSessions();
      if (sessions === null) return [];
      const found: RolloutRef[] = [];
      for (let day = firstDay; day <= lastDay; day += 1) {
        const date = new Date(day * DAY_MS);
        const year = String(date.getUTCFullYear()).padStart(4, "0");
        const month = String(date.getUTCMonth() + 1).padStart(2, "0");
        const dom = String(date.getUTCDate()).padStart(2, "0");
        const dir = join(root, SESSIONS_DIR, year, month, dom);
        let resolvedDir: string;
        try {
          resolvedDir = fs.realpath(dir);
        } catch (error) {
          if (isMissing(error)) continue;
          throw unreadable();
        }
        if (!checkPathContainmentResolved(resolvedDir, sessions).contained) continue;
        let entries: readonly CodexDirEntry[];
        try {
          entries = fs.readDir(dir);
        } catch (error) {
          if (isMissing(error)) continue;
          throw unreadable();
        }
        const names = entries
          .filter(
            (entry) => entry.isFile && ROLLOUT_NAME.test(entry.name) && !entry.name.includes(".."),
          )
          .map((entry) => entry.name)
          .sort();
        for (const name of names) {
          if (found.length >= MAX_ROLLOUT_LIST) return found;
          found.push({ path: join(dir, name) });
        }
      }
      return found;
    },

    statRollout(ref: RolloutRef): { readonly size: number; readonly mtimeMs: number } | null {
      const resolved = resolveRollout(ref?.path);
      if (resolved === null) return null;
      const stat = statFile(resolved);
      return stat === null ? null : { size: stat.size, mtimeMs: stat.mtimeMs };
    },

    readRolloutRange(ref: RolloutRef, offset: number, maxBytes: number): BoundedRead {
      validateRolloutPath(root, ref?.path);
      assertSafeInteger(offset, 0);
      assertSafeInteger(maxBytes, 1);
      const resolved = resolveRollout(ref.path);
      if (resolved === null) throw unreadable();
      const stat = statFile(resolved);
      if (stat === null) throw unreadable();
      return readBounded(resolved, stat.size, offset, Math.min(maxBytes, MAX_ROLLOUT_READ_BYTES));
    },

    resolveSessionsFile(path: string): string | null {
      try {
        const resolved = resolveRollout(path);
        if (resolved === null) return null;
        return statFile(resolved) === null ? null : resolved;
      } catch {
        return null;
      }
    },
  });
}
