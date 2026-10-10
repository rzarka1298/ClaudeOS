import {
  TASK_ATTENTION_PATH,
  TASK_CHANGED_PATH,
  TASK_COUNTS_PATH,
  TASK_CREATE_PATH,
  TASK_DUE_TODAY_PATH,
  TASK_GET_PATH,
  TASK_LIST_PATH,
  TASK_REBUILD_PATH,
  type TaskAttentionRequest,
  TaskAttentionRequestSchema,
  type TaskAttentionResponse,
  TaskAttentionResponseSchema,
  type TaskChangedRequest,
  TaskChangedRequestSchema,
  type TaskChangedResponse,
  TaskChangedResponseSchema,
  type TaskCountsRequest,
  TaskCountsRequestSchema,
  type TaskCountsResponse,
  TaskCountsResponseSchema,
  type TaskCreateRequest,
  TaskCreateRequestSchema,
  type TaskCreateResponse,
  TaskCreateResponseSchema,
  type TaskDueTodayRequest,
  TaskDueTodayRequestSchema,
  type TaskDueTodayResponse,
  TaskDueTodayResponseSchema,
  TaskErrorBodySchema,
  type TaskErrorCode,
  type TaskGetRequest,
  TaskGetRequestSchema,
  type TaskGetResponse,
  TaskGetResponseSchema,
  type TaskListRequest,
  TaskListRequestSchema,
  type TaskListResponse,
  TaskListResponseSchema,
  TaskRebuildRequestSchema,
  type TaskRebuildResponse,
  TaskRebuildResponseSchema,
} from "@ccc/domain";
import type { SocketApiClient } from "./socket-api-client.js";
import { SocketUnreachableError } from "./socket-api-client.js";

/**
 * The task routes through one typed, validated client (plan 06-20, D-28,
 * PATTERNS Group G). Modelled on `approvals-client.ts`: one generic poster,
 * thin wrappers, and errors that carry only a status and a closed code. The
 * plugin owns all copy, so no server text, socket path or schema message ever
 * reaches a caller.
 *
 * The value exports of this package pull in Node HTTP, so the plugin receives
 * these functions by injection and never imports them from view code.
 */

/**
 * Thrown by every function in this module. `message` mirrors `code` so a bare
 * log line is meaningful; no caller may treat it as user-facing copy.
 */
export class TaskRequestError extends Error {
  readonly status: number;
  readonly code: TaskErrorCode;

  constructor(status: number, code: TaskErrorCode) {
    super(code);
    this.name = "TaskRequestError";
    this.status = status;
    this.code = code;
  }
}

export interface TasksClient {
  create(request: TaskCreateRequest): Promise<TaskCreateResponse>;
  list(request: TaskListRequest): Promise<TaskListResponse>;
  counts(request: TaskCountsRequest): Promise<TaskCountsResponse>;
  get(request: TaskGetRequest): Promise<TaskGetResponse>;
  changed(request: TaskChangedRequest): Promise<TaskChangedResponse>;
  rebuild(): Promise<TaskRebuildResponse>;
  attention(request?: TaskAttentionRequest): Promise<TaskAttentionResponse>;
  dueToday(request: TaskDueTodayRequest): Promise<TaskDueTodayResponse>;
}

interface Parser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

/**
 * Validates an outgoing body against its strict schema before any request: an
 * extra key, a path outside the task note rule or an id that is not an id never
 * leaves the process. The failure carries a fixed code, not the schema's message.
 */
function outgoing<T>(schema: Parser<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new TaskRequestError(0, "invalid-body");
  return parsed.data;
}

/**
 * The one place a task route's response becomes a value or a
 * {@link TaskRequestError}. A transport failure maps by `errno` (`ETIMEDOUT` to
 * `timeout`, anything else to `service-disconnected`); a non-200 body maps to its
 * closed code, or to `unrecognised-response` when it names none; a 200 body that
 * fails `schema` is `unrecognised-response`.
 */
async function requestTask<T>(
  client: SocketApiClient,
  path: string,
  body: unknown,
  schema: Parser<T>,
): Promise<T> {
  let res: { status: number; body: unknown };
  try {
    res = await client.request<unknown>({ method: "POST", path, body });
  } catch (error) {
    if (error instanceof SocketUnreachableError) {
      throw new TaskRequestError(
        0,
        error.errno === "ETIMEDOUT" ? "timeout" : "service-disconnected",
      );
    }
    throw error;
  }
  if (res.status !== 200) {
    const closed = TaskErrorBodySchema.safeParse(res.body);
    throw new TaskRequestError(
      res.status,
      closed.success ? closed.data.error : "unrecognised-response",
    );
  }
  const parsed = schema.safeParse(res.body);
  if (!parsed.success) throw new TaskRequestError(res.status, "unrecognised-response");
  return parsed.data;
}

export function createTasksClient(client: SocketApiClient): TasksClient {
  return {
    // `async` so an invalid request rejects rather than throwing before a promise exists.
    create: async (request) =>
      requestTask(
        client,
        TASK_CREATE_PATH,
        outgoing(TaskCreateRequestSchema, request),
        TaskCreateResponseSchema,
      ),
    list: async (request) =>
      requestTask(
        client,
        TASK_LIST_PATH,
        outgoing(TaskListRequestSchema, request),
        TaskListResponseSchema,
      ),
    counts: async (request) =>
      requestTask(
        client,
        TASK_COUNTS_PATH,
        outgoing(TaskCountsRequestSchema, request),
        TaskCountsResponseSchema,
      ),
    get: async (request) =>
      requestTask(
        client,
        TASK_GET_PATH,
        outgoing(TaskGetRequestSchema, request),
        TaskGetResponseSchema,
      ),
    changed: async (request) =>
      requestTask(
        client,
        TASK_CHANGED_PATH,
        outgoing(TaskChangedRequestSchema, request),
        TaskChangedResponseSchema,
      ),
    rebuild: async () =>
      requestTask(
        client,
        TASK_REBUILD_PATH,
        outgoing(TaskRebuildRequestSchema, {}),
        TaskRebuildResponseSchema,
      ),
    attention: async (request) =>
      requestTask(
        client,
        TASK_ATTENTION_PATH,
        outgoing(TaskAttentionRequestSchema, request ?? {}),
        TaskAttentionResponseSchema,
      ),
    dueToday: async (request) =>
      requestTask(
        client,
        TASK_DUE_TODAY_PATH,
        outgoing(TaskDueTodayRequestSchema, request),
        TaskDueTodayResponseSchema,
      ),
  };
}
