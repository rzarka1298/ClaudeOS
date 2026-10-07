import type {
  TaskAttentionRequest,
  TaskAttentionResponse,
  TaskChangedRequest,
  TaskChangedResponse,
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
  TaskRebuildResponse,
} from "@ccc/domain";
import type { SocketApiClient } from "./socket-api-client.js";

/** Skeleton (plan 06-20 Task 3, RED). */
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

export function createTasksClient(_client: SocketApiClient): TasksClient {
  const nothing = (): Promise<never> =>
    Promise.reject(new TaskRequestError(0, "unrecognised-response"));
  return {
    create: nothing,
    list: nothing,
    counts: nothing,
    get: nothing,
    changed: nothing,
    rebuild: nothing,
    attention: nothing,
    dueToday: nothing,
  };
}
