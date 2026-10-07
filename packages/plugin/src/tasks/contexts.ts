import type { TaskCountsResponse, TaskRow } from "@ccc/domain/tasks.js";
import { type Signal, signal } from "@preact/signals";

/** Skeleton: the implementation follows the RED commit (plan 06-18, Task 2). */
export interface TasksContextOptions {
  readonly zone?: () => string;
}
export interface TasksContext {
  readonly filter: Signal<string>;
  readonly rows: Signal<readonly TaskRow[]>;
  readonly counts: Signal<TaskCountsResponse | null>;
  readonly selectedTaskId: Signal<string | null>;
  readonly total: Signal<number>;
  readonly nextCursor: Signal<string | null>;
  readonly busy: Signal<boolean>;
  readonly error: Signal<string | null>;
  readonly chooseProject: Signal<boolean>;
  load(): Promise<void>;
  loadMore(): Promise<void>;
  refresh(): Promise<void>;
  setFilter(filter: string): Promise<void>;
  setScope(scope: string): void;
  setProject(projectId: string | undefined): void;
  select(taskId: string | null): void;
}
function skeleton(): TasksContext {
  return {
    filter: signal("today"),
    rows: signal([]),
    counts: signal(null),
    selectedTaskId: signal(null),
    total: signal(0),
    nextCursor: signal(null),
    busy: signal(false),
    error: signal(null),
    chooseProject: signal(false),
    load: () => Promise.resolve(),
    loadMore: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    setFilter: () => Promise.resolve(),
    setScope: () => {},
    setProject: () => {},
    select: () => {},
  };
}
export function createTasksContext(
  _kind: "global" | "project",
  _options: TasksContextOptions = {},
): TasksContext {
  return skeleton();
}
export function createProjectTasksContext(
  _projectId: string,
  _options: TasksContextOptions = {},
): TasksContext {
  return skeleton();
}
export const globalTasksContext: TasksContext = skeleton();
export function contextSnapshot(_context: TasksContext): Record<string, unknown> {
  return {};
}
