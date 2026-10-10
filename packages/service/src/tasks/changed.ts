import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkPathContainment,
  isTaskNotePath,
  TASK_CHANGED_MAX_PATHS,
  TASK_FILE_MAX_BYTES,
  type TaskChangedRequest,
  type TaskChangedResponse,
} from "@ccc/domain";
import {
  getTask,
  getTaskByPath,
  InvalidTaskIndexError,
  removeTaskByPath,
  upsertTask,
} from "@ccc/operational-store";
import { hashTaskNoteBytes, parseTaskNote, TaskNoteError } from "@ccc/vault-repo";
import type Database from "better-sqlite3";
import { toIndexRecord } from "./record.js";
import type { TaskLog, TaskResult } from "./types.js";

/**
 * The changed route's logic (plan 06-20; D-35, research Pattern 13, T-06-20,
 * T-06-22).
 *
 * THIS MODULE NEVER WRITES A NOTE. It reads a named note's bytes, parses its
 * frontmatter, and updates the disposable index; the only vault-repo functions
 * it imports are readers. That is what makes the loop modify, changed, write,
 * modify unreachable: the plugin edits a note it holds in an editor buffer, the
 * service learns of it here, and nothing is ever written back. The no-write
 * test watches every branch with a vault snapshot, spies on the writers and
 * counters on the file system write functions.
 *
 * Every path goes through three gates in a fixed order, and a path that fails
 * one never reaches the next: the task note path rule (a pure check, no file
 * system call), real-path containment inside the vault (symlinks resolved),
 * then the read.
 */

export interface ChangedDeps {
  readonly db: Database.Database;
  readonly getVaultRoot: () => string | null;
  readonly log: TaskLog;
  /** Queues one deferred, coalesced walk. */
  readonly requestRescan: () => void;
  /** Publishes tasks.changed and returns the new generation. */
  readonly announce: () => number;
  /** The current generation, for a call that changed nothing. */
  readonly generation: () => number;
  /** The id the last scan found shared by this path's note and another, if it did. */
  readonly knownDuplicateId?: (path: string) => string | undefined;
}

interface Outcome {
  readonly refused?: true;
  /** The index changed, so connected clients must re-query. */
  readonly changed?: boolean;
  /** The note could not be indexed as it stands; a walk will list it. */
  readonly rescan?: boolean;
}

/** The scope a task note path implies. */
function scopeOfPath(path: string): string {
  return path.startsWith("global/") ? "global" : `workspace:${path.split("/")[1] ?? ""}`;
}

function absolute(root: string, path: string): string {
  return join(root, ...path.split("/"));
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function applyChanged(
  deps: ChangedDeps,
  request: TaskChangedRequest,
): TaskResult<TaskChangedResponse> {
  const paths = request.paths ?? [];
  if (paths.length > TASK_CHANGED_MAX_PATHS) return { ok: false, code: "invalid-body" };
  if (paths.length === 0 && request.rescan !== true) return { ok: false, code: "invalid-body" };

  let rescan = request.rescan === true;
  let changed = false;
  let accepted = 0;

  if (paths.length > 0) {
    const root = deps.getVaultRoot();
    if (root === null || root.length === 0) return { ok: false, code: "vault-not-set-up" };
    const seen = new Set<string>();
    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      // Gate 1: the path rule. Pure; no file system call.
      if (!isTaskNotePath(path)) continue;
      const outcome = applyOne(deps, root, path);
      if (outcome.refused === true) continue;
      accepted += 1;
      if (outcome.changed === true) changed = true;
      if (outcome.rescan === true) rescan = true;
    }
    if (accepted === 0 && request.rescan !== true) return { ok: false, code: "invalid-path" };
  }

  if (rescan) deps.requestRescan();
  return {
    ok: true,
    value: { accepted, generation: changed ? deps.announce() : deps.generation() },
  };
}

function applyOne(deps: ChangedDeps, root: string, path: string): Outcome {
  const target = absolute(root, path);
  // Gate 2: real-path containment, symlinks resolved. A note that resolves
  // outside the vault is refused whether or not it exists.
  if (!checkPathContainment(target, root).contained) return { refused: true };

  // Gate 3: the read.
  let bytes: Buffer;
  try {
    const stat = lstatSync(target);
    // The scan ignores symbolic links, so a link is never a task note here either.
    if (stat.isSymbolicLink()) return removed(deps, path);
    if (!stat.isFile() || stat.size > TASK_FILE_MAX_BYTES) return unreadable(deps, path);
    bytes = readFileSync(target);
  } catch (error: unknown) {
    if (isMissing(error)) return removed(deps, path);
    return unreadable(deps, path);
  }

  const hash = hashTaskNoteBytes(bytes);
  const indexed = getTaskByPath(deps.db, path);
  // The whole-file hash differs after ANY edit, metadata included; an equal one is a no-op.
  if (indexed !== null && indexed.contentHash === hash) return { changed: false };

  let parsed: ReturnType<typeof parseTaskNote>;
  try {
    parsed = parseTaskNote(bytes.toString("utf8"));
  } catch (error: unknown) {
    if (error instanceof TaskNoteError) return unreadable(deps, path);
    throw error;
  }
  const { frontmatter } = parsed;
  if (frontmatter.scope !== scopeOfPath(path)) return unreadable(deps, path);

  // The last scan already excluded this id as ambiguous: no copy may be
  // indexed until a walk reconciles them.
  if (deps.knownDuplicateId?.(path) === frontmatter.id) {
    return { changed: removeTaskByPath(deps.db, path), rescan: true };
  }

  // A second note with the same id: neither copy is indexed (T-06-21). A holder
  // whose file is gone is a rename in flight, not a duplicate.
  const holder = getTask(deps.db, frontmatter.id);
  if (holder !== null && holder.path !== path) {
    removeTaskByPath(deps.db, holder.path);
    if (existsSync(absolute(root, holder.path))) {
      removeTaskByPath(deps.db, path);
      return { changed: true, rescan: true };
    }
  }

  try {
    upsertTask(deps.db, toIndexRecord(path, frontmatter, hash));
  } catch (error: unknown) {
    if (error instanceof InvalidTaskIndexError) return unreadable(deps, path);
    throw error;
  }
  return { changed: true };
}

/**
 * A note that is gone. A copy the last walk excluded as a duplicate has no row,
 * so deleting it changes nothing here, yet the surviving copy must become
 * visible again: that needs a walk.
 */
function removed(deps: ChangedDeps, path: string): Outcome {
  const changed = removeTaskByPath(deps.db, path);
  return deps.knownDuplicateId?.(path) === undefined ? { changed } : { changed, rescan: true };
}

/** A note that cannot be indexed as it stands: drop any row for it and let a walk list it. */
function unreadable(deps: ChangedDeps, path: string): Outcome {
  return { changed: removeTaskByPath(deps.db, path), rescan: true };
}
