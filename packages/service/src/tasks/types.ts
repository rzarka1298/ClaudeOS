import type {
  TaskAttentionRequest,
  TaskAttentionResponse,
  TaskCountsRequest,
  TaskCountsResponse,
  TaskCreateRequest,
  TaskCreateResponse,
  TaskDueTodayRequest,
  TaskDueTodayResponse,
  TaskErrorCode,
  TaskGetRequest,
  TaskGetResponse,
  TaskListRequest,
  TaskListResponse,
} from "@ccc/domain";
import type { TaskAttention } from "@ccc/vault-repo";
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
  /** Where the attention list lives. Defaults to a fresh in-memory list; a test injects a fixture. */
  readonly attention?: AttentionList | undefined;
}

/**
 * The notes the last walk could not index (duplicate ids, no id, unreadable).
 * Held in memory only: it is rebuilt by every walk, and the attention route
 * reads it without touching the file system.
 */
export interface AttentionList {
  get(): readonly TaskAttention[];
  set(list: readonly TaskAttention[]): void;
}

/** A request whose zone may be absent for an internal caller; the routes' schemas always require it. */
export type WithOptionalZone<T extends { readonly zone: string }> = Omit<T, "zone"> & {
  readonly zone?: string | undefined;
};

export interface TaskServices {
  /** Writes a new manual task note, indexes it and announces the change (TASK-03, D-35). */
  create(request: TaskCreateRequest): TaskResult<TaskCreateResponse>;
  /** One page of a filter in a context; the day bounds come from one computation (D-33). */
  list(request: WithOptionalZone<TaskListRequest>): TaskResult<TaskListResponse>;
  /** Every chip count for a context, from the same day bounds a list would use. */
  counts(request: WithOptionalZone<TaskCountsRequest>): TaskResult<TaskCountsResponse>;
  /** One task's indexed detail. */
  get(request: TaskGetRequest): TaskResult<TaskGetResponse>;
  /** The due-today and overdue feed (D-38). */
  dueToday(request: WithOptionalZone<TaskDueTodayRequest>): TaskResult<TaskDueTodayResponse>;
  /** One page of the attention list. Never reads the file system. */
  attention(request: TaskAttentionRequest): TaskResult<TaskAttentionResponse>;
}
