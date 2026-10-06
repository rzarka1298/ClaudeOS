import type { TaskFrontmatter } from "@ccc/domain";
import { emptyTaskCounts, type TaskStatusCounts } from "./managed-folders.js";

/** The fixed reasons a task note lands in the attention list. */
export type TaskAttentionReason = "duplicate-id" | "missing-id" | "unreadable";

/** One note the scan could not index, with every path involved. */
export interface TaskAttention {
  readonly reason: TaskAttentionReason;
  /** Vault-relative, POSIX-separated, sorted. */
  readonly paths: readonly string[];
  /** The shared id, for a duplicate. */
  readonly id?: string;
  /** A constant sentence; never quotes note text. */
  readonly detail: string;
}

/** One valid, unambiguous task. */
export interface ScannedTask {
  /** Vault-relative, POSIX-separated. */
  readonly path: string;
  readonly frontmatter: TaskFrontmatter;
  /** SHA-256 of the complete file bytes. */
  readonly contentHash: string;
}

/** What one scan found. */
export interface TaskScanResult {
  readonly tasks: readonly ScannedTask[];
  readonly attention: readonly TaskAttention[];
  /** Per-status counts over the valid tasks of every scope. */
  readonly counts: TaskStatusCounts;
  /** The same counts per tasks folder, keyed by vault-relative folder. */
  readonly folderCounts: Readonly<Record<string, TaskStatusCounts>>;
  /** Files skipped because their names are not valid task note names. */
  readonly skipped: number;
}

export function scanTaskNotes(_vaultRoot: string): TaskScanResult {
  return { tasks: [], attention: [], counts: emptyTaskCounts(), folderCounts: {}, skipped: 0 };
}
