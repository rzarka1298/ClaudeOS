import type { TaskActionResult, TaskSaveInput } from "./actions.js";
import type { ReadTaskResult } from "./task-update.js";

/**
 * The one seam through which the Tasks views edit a note (plan 06-22; D-35,
 * D-36, TASK-04, TASK-05, TASK-08, T-06-24). The views never touch the vault,
 * the service client or `obsidian`: a row or pane action calls one of the seven
 * functions below, and the wiring plan (06-23) supplies the implementation
 * built on `tasks/actions.ts` and the Obsidian vault.
 *
 * Until it is configured every function answers as if the note could not be
 * reached (the `read-failed` outcome), so a view mounted without a host can
 * neither write nor pretend it did. Nothing here forces a write: a conflict is
 * returned to the caller, never merged.
 */

/** The note an action targets, by vault-relative path, and the content a form read from it. */
export interface TaskNoteTarget {
  readonly path: string;
  /** Present when a form already read the note; the write is checked against it. */
  readonly expectedPriorContent?: string | undefined;
}

export interface TaskActionsPort {
  readonly complete: (target: TaskNoteTarget) => Promise<TaskActionResult>;
  readonly reopen: (target: TaskNoteTarget) => Promise<TaskActionResult>;
  readonly accept: (target: TaskNoteTarget) => Promise<TaskActionResult>;
  readonly dismiss: (target: TaskNoteTarget) => Promise<TaskActionResult>;
  readonly save: (target: TaskNoteTarget, input: TaskSaveInput) => Promise<TaskActionResult>;
  readonly readForEdit: (path: string) => Promise<ReadTaskResult>;
  readonly openNote: (path: string) => void;
}

const UNAVAILABLE = { kind: "unreadable", reason: "read-failed" } as const;

const unavailableAction = (): Promise<TaskActionResult> => Promise.resolve(UNAVAILABLE);

const UNAVAILABLE_PORT: TaskActionsPort = {
  complete: unavailableAction,
  reopen: unavailableAction,
  accept: unavailableAction,
  dismiss: unavailableAction,
  save: unavailableAction,
  readForEdit: () => Promise.resolve(UNAVAILABLE),
  openNote: () => undefined,
};

let current: TaskActionsPort = UNAVAILABLE_PORT;

/** Installs the port the views reach (or, with `null`, restores the unavailable default). */
export function configureTaskActionsPort(port: TaskActionsPort | null): void {
  current = port ?? UNAVAILABLE_PORT;
}

/** The configured port: exactly the seven functions, nothing else. */
export function taskActionsPort(): TaskActionsPort {
  return {
    complete: (target) => current.complete(target),
    reopen: (target) => current.reopen(target),
    accept: (target) => current.accept(target),
    dismiss: (target) => current.dismiss(target),
    save: (target, input) => current.save(target, input),
    readForEdit: (path) => current.readForEdit(path),
    openNote: (path) => current.openNote(path),
  };
}
