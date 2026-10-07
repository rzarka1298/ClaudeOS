import { statSync } from "node:fs";
import { join } from "node:path";
import type { TaskRebuildResponse } from "@ccc/domain";
import {
  InvalidTaskIndexError,
  rebuildTaskIndex,
  type TaskIndexRecord,
  upsertTask,
} from "@ccc/operational-store";
import { regenerateIndex, scanTaskNotes, type TaskAttention } from "@ccc/vault-repo";
import type Database from "better-sqlite3";
import { toIndexRecord } from "./record.js";
import type { AttentionList, TaskLog, TaskResult, TaskTimers } from "./types.js";

/**
 * The rebuild and the startup walk (plan 06-20; D-31, D-37, T-06-21, T-06-23).
 *
 * One walk reads every tasks folder with the 06-15 scanner, replaces the index
 * with the valid tasks in one transaction, stores the attention list (duplicate
 * ids, id-less and unreadable notes, none of them indexed, none of them given an
 * id), and refreshes each tasks folder's constant-size summary index. A walk
 * never creates, renames, rewrites or deletes a task note: the only files it
 * writes are those summary indexes.
 *
 * A storm of rescan requests costs one walk: requests coalesce into a single
 * deferred walk, and a rebuild inside the minimum interval of the last walk
 * answers with that walk's result instead of walking again.
 */

/** A rescan is deferred at least this long, so a burst of events lands in one walk. */
export const RESCAN_DEBOUNCE_MS = 250;
/** The default minimum time between two walks. */
export const DEFAULT_MIN_WALK_INTERVAL_MS = 5_000;

export interface ReindexDeps {
  readonly db: Database.Database;
  readonly getVaultRoot: () => string | null;
  readonly attention: AttentionList;
  readonly now: () => Date;
  readonly log: TaskLog;
  /** Called once after each successful walk (the service announces tasks.changed). */
  readonly onChanged: () => void;
  readonly minIntervalMs?: number | undefined;
  readonly timers?: TaskTimers | undefined;
}

export interface Reindexer {
  /** Walks now, whatever the interval. The startup walk. */
  walk(): TaskResult<TaskRebuildResponse>;
  /** Walks unless one finished inside the minimum interval, then returns that result. */
  rebuild(): TaskResult<TaskRebuildResponse>;
  /** Queues one deferred walk; any number of calls before it runs cost one walk. */
  requestRescan(): void;
  /** Cancels a pending deferred walk. */
  dispose(): void;
}

const realTimers: TaskTimers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function createReindexer(deps: ReindexDeps): Reindexer {
  const minInterval = deps.minIntervalMs ?? DEFAULT_MIN_WALK_INTERVAL_MS;
  const timers = deps.timers ?? realTimers;
  let lastRunAt: number | null = null;
  let lastResult: TaskResult<TaskRebuildResponse> | null = null;
  let timer: unknown = null;
  let disposed = false;

  function cancelTimer(): void {
    if (timer === null) return;
    timers.clearTimeout(timer);
    timer = null;
  }

  /** The vault root, or null when none is set up or it is not mounted: that must never empty the index. */
  function usableRoot(): string | null {
    const root = deps.getVaultRoot();
    return root === null || root.length === 0 || !isDirectory(root) ? null : root;
  }

  function walk(): TaskResult<TaskRebuildResponse> {
    const root = usableRoot();
    if (root === null) return { ok: false, code: "vault-not-set-up" };
    try {
      const scan = scanTaskNotes(root);
      const attention: TaskAttention[] = [...scan.attention];
      const records: TaskIndexRecord[] = scan.tasks.map((task) =>
        toIndexRecord(task.path, task.frontmatter, task.contentHash),
      );
      let indexed = records.length;
      try {
        rebuildTaskIndex(deps.db, records);
      } catch (error: unknown) {
        if (!(error instanceof InvalidTaskIndexError)) throw error;
        // One record the index refuses must not take the others down: index one by one.
        rebuildTaskIndex(deps.db, []);
        indexed = 0;
        scan.tasks.forEach((task, position) => {
          const record = records[position] as TaskIndexRecord;
          try {
            upsertTask(deps.db, record);
            indexed += 1;
          } catch (inner: unknown) {
            if (!(inner instanceof InvalidTaskIndexError)) throw inner;
            attention.push({
              reason: "unreadable",
              paths: [task.path],
              detail: "task note could not be indexed",
            });
          }
        });
      }
      deps.attention.set(attention);

      for (const [folderKey, counts] of Object.entries(scan.folderCounts)) {
        try {
          regenerateIndex(join(root, ...folderKey.split("/")), {
            vaultRoot: root,
            taskCounts: counts,
          });
        } catch (error: unknown) {
          deps.log.warn(
            { fn: "walk", errorName: error instanceof Error ? error.name : typeof error },
            "tasks summary index not refreshed",
          );
        }
      }

      const result: TaskResult<TaskRebuildResponse> = {
        ok: true,
        value: {
          tasks: indexed,
          attention: attention.reduce((sum, entry) => sum + entry.paths.length, 0),
        },
      };
      lastRunAt = deps.now().getTime();
      lastResult = result;
      deps.onChanged();
      return result;
    } catch (error: unknown) {
      deps.log.error(
        { fn: "walk", errorName: error instanceof Error ? error.name : typeof error },
        "task walk failed",
      );
      return { ok: false, code: "write-failed" };
    }
  }

  return {
    walk,
    rebuild() {
      if (usableRoot() === null) return { ok: false, code: "vault-not-set-up" };
      if (
        lastResult !== null &&
        lastRunAt !== null &&
        deps.now().getTime() - lastRunAt < minInterval
      ) {
        // Answered from the cache: a queued rescan still has work to reconcile.
        return lastResult;
      }
      cancelTimer();
      return walk();
    },
    requestRescan() {
      if (disposed || timer !== null) return;
      const since =
        lastRunAt === null ? Number.POSITIVE_INFINITY : deps.now().getTime() - lastRunAt;
      const wait = Math.max(RESCAN_DEBOUNCE_MS, minInterval - since);
      timer = timers.setTimeout(() => {
        timer = null;
        walk();
      }, wait);
    },
    dispose() {
      disposed = true;
      cancelTimer();
    },
  };
}
