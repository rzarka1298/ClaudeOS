import type {
  TaskAttentionResponse,
  TaskCountsResponse,
  TaskGetResponse,
  TaskListResponse,
  TaskRow,
} from "@ccc/domain/tasks.js";
import { vi } from "vitest";
import { type TasksApi, TasksApiError } from "../tasks/api.js";
import { taskRow } from "./task-view-fixtures.js";

/** Counts used across the Tasks container tests: 12 open, 1 overdue, 2 proposed. */
export const COUNTS: TaskCountsResponse = {
  counts: {
    all: 10,
    today: 3,
    upcoming: 12,
    overdue: 1,
    project: 40,
    proposed: 2,
    blocked: 4,
    completed: 56,
  },
  open: 12,
};

export function listOf(rows: readonly TaskRow[], total = rows.length): TaskListResponse {
  return { rows: [...rows], total, nextCursor: null, chooseProject: false };
}

export const NO_ATTENTION: TaskAttentionResponse = { items: [], total: 0, nextCursor: null };

export type FakeTasksApi = { [K in keyof TasksApi]: ReturnType<typeof vi.fn> } & TasksApi;

/** A task API whose every function is a spy with a sensible default answer. */
export function fakeTasksApi(
  rows: readonly TaskRow[],
  overrides: Partial<TasksApi> = {},
): FakeTasksApi {
  const api = {
    create: vi.fn(() => Promise.resolve({ task: taskRow(99) })),
    list: vi.fn(() => Promise.resolve(listOf(rows))),
    counts: vi.fn(() => Promise.resolve(COUNTS)),
    get: vi.fn((): Promise<TaskGetResponse> => Promise.reject(new TasksApiError("not-found"))),
    changed: vi.fn(() => Promise.resolve({ accepted: 1, generation: 1 })),
    rebuild: vi.fn(() => Promise.resolve({ tasks: 5, attention: 0 })),
    attention: vi.fn(() => Promise.resolve(NO_ATTENTION)),
    dueToday: vi.fn(() => Promise.reject(new TasksApiError("service-disconnected"))),
    ...overrides,
  };
  return api as unknown as FakeTasksApi;
}
