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
} from "@ccc/domain/tasks.js";

/**
 * The seam between task code and the service (plan 06-18, D-24's "components
 * never import the client" rule, the `approvals/api.ts` precedent). Containers
 * and actions call these plain functions; the wiring plan configures them from
 * the authenticated tasks client. The service client package is never imported
 * here, because its value exports pull in Node HTTP the browser-platform
 * bundle cannot resolve.
 */
export interface TasksApi {
  create(request: TaskCreateRequest): Promise<TaskCreateResponse>;
  list(request: TaskListRequest): Promise<TaskListResponse>;
  counts(request: TaskCountsRequest): Promise<TaskCountsResponse>;
  get(request: TaskGetRequest): Promise<TaskGetResponse>;
  changed(request: TaskChangedRequest): Promise<TaskChangedResponse>;
  rebuild(): Promise<TaskRebuildResponse>;
  attention(request: TaskAttentionRequest): Promise<TaskAttentionResponse>;
  dueToday(request: TaskDueTodayRequest): Promise<TaskDueTodayResponse>;
}

/** Closed error vocabulary the holder itself raises; the wiring maps client errors onto the same codes. */
export class TasksApiError extends Error {
  readonly code: TaskErrorCode;
  constructor(code: TaskErrorCode) {
    super(code);
    this.name = "TasksApiError";
    this.code = code;
  }
}

function disconnected(): Promise<never> {
  return Promise.reject(new TasksApiError("service-disconnected"));
}

/** The default until the host configures one: every call rejects as if the service were away. */
const DISCONNECTED_API: TasksApi = {
  create: disconnected,
  list: disconnected,
  counts: disconnected,
  get: disconnected,
  changed: disconnected,
  rebuild: disconnected,
  attention: disconnected,
  dueToday: disconnected,
};

let current: TasksApi = DISCONNECTED_API;

/** Installs the API the task code reaches (or, with `null`, restores the disconnected default). */
export function configureTasksApi(api: TasksApi | null): void {
  current = api ?? DISCONNECTED_API;
}

/** The currently configured API: exactly the eight functions, nothing else. */
export function tasksApi(): TasksApi {
  return {
    create: (request) => current.create(request),
    list: (request) => current.list(request),
    counts: (request) => current.counts(request),
    get: (request) => current.get(request),
    changed: (request) => current.changed(request),
    rebuild: () => current.rebuild(),
    attention: (request) => current.attention(request),
    dueToday: (request) => current.dueToday(request),
  };
}
