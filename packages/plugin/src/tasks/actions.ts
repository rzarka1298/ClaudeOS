import type { ManagedNoteFile } from "../conflict-safe.js";
import type { TaskEditVault, UpdateTaskResult } from "./task-update.js";

/** Skeleton: the implementation follows the RED commit (plan 06-18, Task 1). */
export interface TaskActionDeps {
  readonly vault: TaskEditVault;
  readonly changed?: (path: string) => Promise<unknown>;
}
export interface TaskActionTarget {
  readonly file: ManagedNoteFile;
  readonly expectedPriorContent?: string;
}
export type TaskActionResult =
  | (Extract<UpdateTaskResult, { kind: "applied" }> & { readonly notified: boolean })
  | Exclude<UpdateTaskResult, { kind: "applied" }>;

export function completeTask(
  _deps: TaskActionDeps,
  _target: TaskActionTarget,
  _now: string,
): Promise<TaskActionResult> {
  return Promise.resolve({ kind: "unreadable", reason: "not-implemented" });
}
