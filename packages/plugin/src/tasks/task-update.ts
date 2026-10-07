import type {
  TaskDecision,
  TaskFrontmatter,
  TaskPriority,
  TaskStatus,
} from "@ccc/domain/task-schema.js";
import type { ManagedNoteFile, ProcessableVault } from "../conflict-safe.js";

/** Skeleton: the implementation follows the RED commit (plan 06-18, Task 1). */
export type TaskUnreadableReason = string;
export interface TaskChanges {
  readonly title?: string;
  readonly description?: string;
  readonly status?: TaskStatus;
  readonly priority?: TaskPriority | null;
  readonly due?: string | null;
  readonly scheduled?: string | null;
  readonly completed?: string | null;
  readonly projectId?: string | null;
  readonly tags?: readonly string[];
  readonly decision?: TaskDecision | null;
}
export interface TaskEdit {
  readonly now: string;
  readonly changes: TaskChanges;
}
export interface ParsedTask {
  readonly frontmatter: TaskFrontmatter;
  readonly body: string;
  readonly passthrough: readonly (readonly [string, unknown])[];
}
export type TaskEditVault = ProcessableVault & {
  read(file: ManagedNoteFile): Promise<string>;
};
export type ReadTaskResult =
  | { readonly kind: "ok"; readonly content: string; readonly task: ParsedTask }
  | { readonly kind: "unreadable"; readonly reason: TaskUnreadableReason };
export type UpdateTaskResult =
  | { readonly kind: "applied"; readonly content: string; readonly task: TaskFrontmatter }
  | { readonly kind: "conflict" }
  | { readonly kind: "unreadable"; readonly reason: TaskUnreadableReason }
  | { readonly kind: "invalid"; readonly fields: Readonly<Record<string, string>> };

export function parseTaskContent(_content: string): ReadTaskResult {
  return { kind: "unreadable", reason: "not-implemented" };
}
export function readTaskForEdit(
  _vault: TaskEditVault,
  _file: ManagedNoteFile,
): Promise<ReadTaskResult> {
  return Promise.resolve({ kind: "unreadable", reason: "not-implemented" });
}
export function updateTaskNote(
  _vault: ProcessableVault,
  _file: ManagedNoteFile,
  _expectedPriorContent: string,
  _edit: TaskEdit,
): Promise<UpdateTaskResult> {
  return Promise.resolve({ kind: "unreadable", reason: "not-implemented" });
}
