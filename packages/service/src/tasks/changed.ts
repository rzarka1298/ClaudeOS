import type { TaskChangedRequest, TaskChangedResponse } from "@ccc/domain";
import type Database from "better-sqlite3";
import type { TaskLog, TaskResult } from "./types.js";

/** Skeleton (plan 06-20 Task 3, RED). */
export interface ChangedDeps {
  readonly db: Database.Database;
  readonly getVaultRoot: () => string | null;
  readonly log: TaskLog;
  readonly requestRescan: () => void;
  readonly announce: () => number;
  readonly generation: () => number;
}

export function applyChanged(
  _deps: ChangedDeps,
  _request: TaskChangedRequest,
): TaskResult<TaskChangedResponse> {
  return { ok: false, code: "write-failed" };
}
