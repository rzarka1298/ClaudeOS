import type { TaskRebuildResponse } from "@ccc/domain";
import type Database from "better-sqlite3";
import type { AttentionList, TaskLog, TaskResult, TaskTimers } from "./types.js";

/** Skeleton (plan 06-20 Task 3, RED). */
export interface ReindexDeps {
  readonly db: Database.Database;
  readonly getVaultRoot: () => string | null;
  readonly attention: AttentionList;
  readonly now: () => Date;
  readonly log: TaskLog;
  readonly onChanged: () => void;
  readonly minIntervalMs?: number | undefined;
  readonly timers?: TaskTimers | undefined;
}

export interface Reindexer {
  walk(): TaskResult<TaskRebuildResponse>;
  rebuild(): TaskResult<TaskRebuildResponse>;
  requestRescan(): void;
  dispose(): void;
}

export function createReindexer(_deps: ReindexDeps): Reindexer {
  const nothing = (): TaskResult<TaskRebuildResponse> => ({ ok: false, code: "write-failed" });
  return {
    walk: nothing,
    rebuild: nothing,
    requestRescan: () => undefined,
    dispose: () => undefined,
  };
}
