import { TASK_STATUSES, TASKS_FOLDER_NAME, type TaskStatus } from "@ccc/domain";

/**
 * The managed folder tree, quoted from the PRD and listed depth-first in that
 * document's own order. This array is the ONLY place the tree is written down:
 * setup's displayed plan, its executed writes and repair's walk all read it.
 */
export const MANAGED_FOLDERS = [
  "global",
  "global/raw",
  "global/wiki",
  "global/output",
  "workspaces",
  "inbox",
  "daily",
  "automation-runs",
  "system",
] as const;

/** The knowledge folders every workspace tree carries. */
export const WORKSPACE_LEAF_FOLDERS = ["raw", "wiki", "output"] as const;

/** Per-status task counts, one entry for every status. */
export type TaskStatusCounts = Readonly<Record<TaskStatus, number>>;

/** Counts for a folder holding no tasks. */
export function emptyTaskCounts(): TaskStatusCounts {
  return Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as TaskStatusCounts;
}

const WORKSPACE_TASKS_FOLDER = new RegExp(`^workspaces/[0-9a-z]{25}/${TASKS_FOLDER_NAME}$`);

/**
 * True for `global/tasks` and `workspaces/<id>/tasks`, and for nothing else: a
 * folder named `tasks` anywhere deeper is an ordinary folder. `folderKey` is
 * vault-relative and POSIX-separated.
 */
export function isTasksFolderPath(folderKey: string): boolean {
  return folderKey === `global/${TASKS_FOLDER_NAME}` || WORKSPACE_TASKS_FOLDER.test(folderKey);
}
