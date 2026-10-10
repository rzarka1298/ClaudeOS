import { ProjectIdSchema } from "@ccc/domain/projects.js";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TaskDateSchema,
  type TaskFrontmatter,
  type TaskPriority,
  type TaskStatus,
  TaskTagSchema,
  TaskTitleSchema,
} from "@ccc/domain/task-schema.js";
import { isValidZone, zonedLocalToInstant } from "@ccc/domain/task-time.js";
import { TASK_DESCRIPTION_MAX_LENGTH } from "@ccc/domain/tasks.js";
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

/** What an action will change, or why it cannot (field-keyed codes, before any write). */
type EditPlan =
  | { readonly ok: true; readonly changes: TaskChanges }
  | { readonly ok: false; readonly fields: Readonly<Record<string, string>> };

const plan = (changes: TaskChanges): EditPlan => ({ ok: true, changes });

async function defaultChanged(path: string): Promise<unknown> {
  return tasksApi().changed({ paths: [path] });
}

const STALE_STATUS = "stale-status";

/** The freshly read status is not one this transition may start from (the index may be stale). */
const stale = (): EditPlan => ({ ok: false, fields: { status: STALE_STATUS } });

const OPEN_STATUSES: readonly TaskStatus[] = ["inbox", "ready", "in-progress", "blocked"];

async function notify(deps: TaskActionDeps, path: string): Promise<boolean> {
  try {
    await (deps.changed ?? defaultChanged)(path);
    return true;
  } catch {
    // The vault watcher or the next rebuild catches the index up.
    return false;
  }
}

async function runEdit(
  deps: TaskActionDeps,
  target: TaskActionTarget,
  now: string,
  build: (current: TaskFrontmatter) => EditPlan,
): Promise<TaskActionResult> {
  let expected = target.expectedPriorContent;
  if (expected === undefined) {
    const read = await readTaskForEdit(deps.vault, target.file);
    if (read.kind === "unreadable") return read;
    expected = read.content;
  }
  const parsed = parseTaskContent(expected);
  if (parsed.kind === "unreadable") return parsed;

  const plan = build(parsed.task.frontmatter);
  if (!plan.ok) {
    // A stale-status refusal means the index disagrees with the note: tell the service.
    if (plan.fields.status === STALE_STATUS) await notify(deps, target.file.path);
    return { kind: "invalid", fields: plan.fields };
  }

  const path = target.file.path;
  // Recorded BEFORE the write: the vault's modify event for it can arrive before
  // the write's own promise resolves.
  deps.ownWrites?.record(path);
  const result = await updateTaskNote(deps.vault, target.file, expected, {
    now,
    changes: plan.changes,
  });
  if (result.kind !== "applied") {
    deps.ownWrites?.forget(path);
    // The note changed outside this action (or cannot be edited), and the watcher
    // may have dropped that event as an echo: make sure the index hears about it.
    if (result.kind === "conflict" || result.kind === "unreadable" || result.kind === "invalid") {
      await notify(deps, path);
    }
    return result;
  }
  // The note is already written; a failed notification is caught up by the watcher or a rebuild.
  const notified = await notify(deps, path);
  return { ...result, notified };
}

/** TASK-08: sets `done` and `completed`, advances `updated`, and changes nothing else. */
export function completeTask(
  deps: TaskActionDeps,
  target: TaskActionTarget,
  now: string,
): Promise<TaskActionResult> {
  return runEdit(deps, target, now, (current) =>
    OPEN_STATUSES.includes(current.status) ? plan({ status: "done", completed: now }) : stale(),
  );
}

/** Sets `ready` and clears `completed` (UI-SPEC R-17). */
export function reopenTask(
  deps: TaskActionDeps,
  target: TaskActionTarget,
  now: string,
): Promise<TaskActionResult> {
  return runEdit(deps, target, now, (current) =>
    current.status === "done" || current.status === "cancelled"
      ? plan({ status: "ready", completed: null })
      : stale(),
  );
}

/** D-36: a proposed task becomes `ready` and the decision is recorded as accepted at `now`. */
export function acceptTask(
  deps: TaskActionDeps,
  target: TaskActionTarget,
  now: string,
): Promise<TaskActionResult> {
  return runEdit(deps, target, now, (current) =>
    current.status === "proposed"
      ? plan({ status: "ready", decision: { outcome: "accepted", at: now } })
      : stale(),
  );
}

/** D-36: a proposed task becomes `cancelled` (the note is kept) and the decision is recorded as dismissed at `now`. */
export function dismissTask(
  deps: TaskActionDeps,
  target: TaskActionTarget,
  now: string,
): Promise<TaskActionResult> {
  return runEdit(deps, target, now, (current) =>
    current.status === "proposed"
      ? plan({ status: "cancelled", decision: { outcome: "dismissed", at: now } })
      : stale(),
  );
}

/**
 * A due or scheduled value from the form: a local calendar date and, for a due
 * value, an optional local time. An empty date clears the key.
 */
export interface TaskDueInput {
  readonly date: string;
  readonly time?: string | null | undefined;
}

/**
 * The edit form's changes. An absent field is left alone; `null` clears an
 * optional field. `zone` is the owner's IANA zone, used only to turn a local
 * date and time into an offset instant.
 */
export interface TaskSaveInput {
  readonly zone: string;
  readonly title?: string;
  readonly description?: string;
  readonly status?: TaskStatus;
  readonly priority?: TaskPriority | null;
  readonly due?: TaskDueInput | null;
  readonly scheduled?: TaskDueInput | null;
  readonly projectId?: string | null;
  readonly tags?: readonly string[];
}

/** The most tags one task carries (the schema bound). */
const TASK_MAX_TAGS = 20;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `undefined` leaves the key, `null` clears it, a string is the value to store; a code string in `error` rejects the field. */
function dueValue(
  input: TaskDueInput | null,
  zone: string,
): { readonly value: string | null } | { readonly error: string } {
  if (input === null || input.date.trim() === "") return { value: null };
  const date = input.date.trim();
  if (!DATE_ONLY.test(date) || !TaskDateSchema.safeParse(date).success) {
    return { error: "invalid-date" };
  }
  // A calendar date that does not exist (February 31st) is refused by the instant converter.
  if (zonedLocalToInstant(date, "12:00", zone) === null) return { error: "invalid-date" };
  const time = input.time?.trim() ?? "";
  if (time === "") return { value: date };
  const instant = zonedLocalToInstant(date, time, zone);
  return instant === null ? { error: "invalid-time" } : { value: instant };
}

function normaliseTags(tags: readonly string[]): { tags: string[] } | { error: string } {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/^#/, "");
    if (tag === "" || seen.has(tag)) continue;
    if (!TaskTagSchema.safeParse(tag).success) return { error: "invalid-tag" };
    seen.add(tag);
    out.push(tag);
  }
  return out.length > TASK_MAX_TAGS ? { error: "too-many-tags" } : { tags: out };
}

function planSave(current: TaskFrontmatter, now: string, input: TaskSaveInput): EditPlan {
  const fields: Record<string, string> = {};
  const changes: {
    -readonly [K in keyof TaskChanges]: TaskChanges[K];
  } = {};

  if (input.title !== undefined) {
    if (TaskTitleSchema.safeParse(input.title).success) changes.title = input.title;
    else fields.title = input.title.trim() === "" ? "required" : "invalid";
  }
  if (input.description !== undefined) {
    if (input.description.length > TASK_DESCRIPTION_MAX_LENGTH) fields.description = "too-long";
    else if (input.description.includes("\0")) fields.description = "invalid";
    else changes.description = input.description;
  }
  if (input.priority !== undefined) {
    if (input.priority === null || TASK_PRIORITIES.includes(input.priority)) {
      changes.priority = input.priority;
    } else fields.priority = "invalid";
  }
  if (input.status !== undefined) {
    if (!TASK_STATUSES.includes(input.status)) {
      fields.status = "invalid";
    } else {
      changes.status = input.status;
      // R-17: Done sets `completed` when it was empty; leaving Done clears it.
      if (input.status === "done") {
        if (current.completed === undefined) changes.completed = now;
      } else if (current.completed !== undefined) {
        changes.completed = null;
      }
    }
  }
  for (const key of ["due", "scheduled"] as const) {
    const given = input[key];
    if (given === undefined) continue;
    // A scheduled value is a date; only a due value can carry a time.
    const result = dueValue(
      key === "scheduled" ? given && { date: given.date } : given,
      input.zone,
    );
    if ("error" in result) fields[key] = result.error;
    else changes[key] = result.value;
  }
  if (input.projectId !== undefined) {
    if (input.projectId === null || input.projectId === "") changes.projectId = null;
    else if (ProjectIdSchema.safeParse(input.projectId).success)
      changes.projectId = input.projectId;
    else fields.projectId = "invalid";
  }
  if (input.tags !== undefined) {
    const result = normaliseTags(input.tags);
    if ("error" in result) fields.tags = result.error;
    else changes.tags = result.tags;
  }
  if (!isValidZone(input.zone)) fields.zone = "invalid";
  return Object.keys(fields).length > 0 ? { ok: false, fields } : { ok: true, changes };
}

/**
 * Applies the edit form's changes (D-36, TASK-04, TASK-05). Validation runs
 * before any read-modify-write, so a rejected field costs no write and no
 * notification; the result is `invalid` with a code per field.
 */
export function saveTask(
  deps: TaskActionDeps,
  target: TaskActionTarget,
  now: string,
  input: TaskSaveInput,
): Promise<TaskActionResult> {
  return runEdit(deps, target, now, (current) => planSave(current, now, input));
}
