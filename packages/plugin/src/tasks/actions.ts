import type { TaskFrontmatter } from "@ccc/domain/task-schema.js";
import type { ManagedNoteFile } from "../conflict-safe.js";
import { tasksApi } from "./api.js";
import {
  parseTaskContent,
  readTaskForEdit,
  type TaskChanges,
  type TaskEditVault,
  type UpdateTaskResult,
  updateTaskNote,
} from "./task-update.js";

/**
 * The task actions (plan 06-18; D-36, D-37, TASK-08, T-06-24). Each is one
 * conflict-safe note edit followed by one notification to the service, and
 * nothing else: this module imports only the updater, the task API holder, the
 * domain and plain types. A completion can therefore not launch, terminate,
 * decide, fetch or reach a connector, and `complete.test.ts` proves it with
 * spies.
 *
 * Time arrives as an argument (an ISO string): nothing here reads the clock.
 * View code never imports these functions; containers receive them as props
 * from the wiring (06-23).
 */

/** What an action needs: the vault, how to tell the service, and an optional own-write ledger. */
export interface TaskActionDeps {
  readonly vault: TaskEditVault;
  /** Tells the service one note changed. Defaults to the task API holder's `changed`. */
  readonly changed?: (path: string) => Promise<unknown>;
  /** Marks a path as written by this plugin so the vault watcher drops its echo. */
  readonly ownWrites?: {
    record(path: string): void;
    forget(path: string): void;
  };
}

/** The note to edit and, when a form already read it, the content it read. */
export interface TaskActionTarget {
  readonly file: ManagedNoteFile;
  readonly expectedPriorContent?: string;
}

export type TaskActionResult =
  | (Extract<UpdateTaskResult, { kind: "applied" }> & { readonly notified: boolean })
  | Exclude<UpdateTaskResult, { kind: "applied" }>;

async function defaultChanged(path: string): Promise<unknown> {
  return tasksApi().changed({ paths: [path] });
}

async function runEdit(
  deps: TaskActionDeps,
  target: TaskActionTarget,
  now: string,
  changesFor: (current: TaskFrontmatter) => TaskChanges,
): Promise<TaskActionResult> {
  let expected = target.expectedPriorContent;
  if (expected === undefined) {
    const read = await readTaskForEdit(deps.vault, target.file);
    if (read.kind === "unreadable") return read;
    expected = read.content;
  }
  const parsed = parseTaskContent(expected);
  if (parsed.kind === "unreadable") return parsed;

  const path = target.file.path;
  // Recorded BEFORE the write: the vault's modify event for it can arrive before
  // the write's own promise resolves.
  deps.ownWrites?.record(path);
  const result = await updateTaskNote(deps.vault, target.file, expected, {
    now,
    changes: changesFor(parsed.task.frontmatter),
  });
  if (result.kind !== "applied") {
    deps.ownWrites?.forget(path);
    return result;
  }
  let notified = true;
  try {
    await (deps.changed ?? defaultChanged)(path);
  } catch {
    // The note is already written; the vault watcher or the next rebuild catches the index up.
    notified = false;
  }
  return { ...result, notified };
}

/** TASK-08: sets `done` and `completed`, advances `updated`, and changes nothing else. */
export function completeTask(
  deps: TaskActionDeps,
  target: TaskActionTarget,
  now: string,
): Promise<TaskActionResult> {
  return runEdit(deps, target, now, () => ({ status: "done", completed: now }));
}
