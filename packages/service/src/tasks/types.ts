import type { TaskCreateRequest, TaskCreateResponse, TaskErrorCode } from "@ccc/domain";
import type Database from "better-sqlite3";
import type { EventBus } from "../events/event-bus.js";

/**
 * The task services' contracts (plan 06-20; D-28, D-35, D-37).
 *
 * The route layer talks to {@link TaskServices} and nothing else: it never
 * sees the vault, the index or the clock. Every service function answers a
 * {@link TaskResult}, so a refusal is a closed code and never a message that
 * could name a path, a title or a payload (T-06-27).
 */

/** A value, or one closed error code. */
export type TaskResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: TaskErrorCode };

/**
 * The logger shape the task services use. Callers hand it a route or function
 * name and an error class name, never a title, a path, a body or an error
 * object (an error's message can carry a path).
 */
export interface TaskLog {
  warn(fields: Readonly<Record<string, unknown>>, message?: string): void;
  error(fields: Readonly<Record<string, unknown>>, message?: string): void;
}

/** Everything the task services are built from. Injected so tests own the vault, the clock and the bus. */
export interface TaskServicesDeps {
  /** The operational store's database (the disposable task index lives here). */
  readonly db: Database.Database;
  /** The managed vault root, or null when no vault has been set up. */
  readonly getVaultRoot: () => string | null;
  /** Only `publish` is needed: a task change is announced as one `tasks.changed` event. */
  readonly eventBus: Pick<EventBus, "publish">;
  /** The clock. A function so a test can move it. */
  readonly now: () => Date;
  readonly log: TaskLog;
}

export interface TaskServices {
  /** Writes a new manual task note, indexes it and announces the change (TASK-03, D-35). */
  create(request: TaskCreateRequest): TaskResult<TaskCreateResponse>;
}
