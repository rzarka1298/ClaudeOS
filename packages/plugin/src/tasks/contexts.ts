import type { ProjectId } from "@ccc/domain/ids.js";
import { ProjectIdSchema } from "@ccc/domain/projects.js";
import { isValidZone, resolvedZone } from "@ccc/domain/task-time.js";
import {
  TASK_DEFAULT_FILTER,
  TASK_PAGE_SIZE,
  TASK_PROJECT_PANEL_DEFAULT_FILTER,
  TASK_PROJECT_PANEL_FILTERS,
  type TaskContext,
  type TaskCountsResponse,
  TaskCountsResponseSchema,
  TaskErrorCodeSchema,
  type TaskFilter,
  type TaskListRequest,
  TaskListResponseSchema,
  type TaskRow,
} from "@ccc/domain/tasks.js";
import { type Signal, signal } from "@preact/signals";
import { tasksApi } from "./api.js";

/**
 * Two independent query contexts (plan 06-18; D-34, TASK-07, UI-SPEC R-11, S4).
 * The global Tasks destination owns one; each open project panel creates its
 * own. Every piece of state (filter, scope, project, rows, counts, cursor,
 * selection, busy, error) is a signal created INSIDE {@link createTasksContext},
 * so no two contexts can share one: operating a context cannot change another's
 * state, because there is nothing shared to change. The only module-level
 * things are the API holder (a function seam) and the exported global instance.
 *
 * Counts always follow their own context's scope and project, from the same
 * zone read as the list, so a chip count cannot disagree with its list.
 * A failed load keeps the last good rows, counts and selection and sets
 * `error`; an older response that arrives after a newer request is dropped.
 */

export type TasksContextKind = "global" | "project";

export interface TasksContextOptions {
  /** Reads the owner's IANA zone. Called once per load. Defaults to the runtime's own. */
  readonly zone?: () => string;
  /** The project a `project` context is fixed to. */
  readonly projectId?: string;
}

export interface TasksContext {
  readonly kind: TasksContextKind;
  readonly filter: Signal<TaskFilter>;
  /** `all`, `global` or `workspace:<id>`. Fixed to `all` in a project context. */
  readonly scope: Signal<string>;
  /** The project the list is narrowed to: fixed in a project context, the Project filter's choice in the global one. */
  readonly projectId: Signal<ProjectId | undefined>;
  readonly rows: Signal<readonly TaskRow[]>;
  readonly total: Signal<number>;
  readonly nextCursor: Signal<string | null>;
  readonly counts: Signal<TaskCountsResponse | null>;
  readonly selectedTaskId: Signal<string | null>;
  /** True while a request is in flight; the old rows stay visible meanwhile. */
  readonly busy: Signal<boolean>;
  /** A closed error code from the last failed load, cleared by the next success. */
  readonly error: Signal<string | null>;
  /** True when the Project filter has no project chosen: the page is empty by design. */
  readonly chooseProject: Signal<boolean>;
  /** Loads page one of the current filter and the counts. */
  load(): Promise<void>;
  /** Appends the next page, if there is one. */
  loadMore(): Promise<void>;
  /** Reloads page one, keeping the selection. */
  refresh(): Promise<void>;
  /** Changes the filter and reloads page one. */
  setFilter(filter: TaskFilter): Promise<void>;
  /** Sets the scope (global context only); the caller follows with `load()`. */
  setScope(scope: string): void;
  /** Sets the chosen project (global context only); the caller follows with `load()`. */
  setProject(projectId: string | undefined): void;
  select(taskId: string | null): void;
}

function errorCodeOf(error: unknown): string {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const parsed = TaskErrorCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : "unrecognised-response";
}

function readZone(supplied: (() => string) | undefined): string {
  let zone: string | undefined;
  try {
    zone = supplied?.();
  } catch {
    zone = undefined;
  }
  return zone !== undefined && isValidZone(zone) ? zone : resolvedZone();
}

export function createTasksContext(
  kind: TasksContextKind,
  options: TasksContextOptions = {},
): TasksContext {
  const fixedProject =
    kind === "project" && options.projectId !== undefined
      ? ProjectIdSchema.parse(options.projectId)
      : undefined;
  const filter = signal<TaskFilter>(
    kind === "project" ? TASK_PROJECT_PANEL_DEFAULT_FILTER : TASK_DEFAULT_FILTER,
  );
  const scope = signal("all");
  const projectId = signal<ProjectId | undefined>(fixedProject);
  const rows = signal<readonly TaskRow[]>([]);
  const total = signal(0);
  const nextCursor = signal<string | null>(null);
  const counts = signal<TaskCountsResponse | null>(null);
  const selectedTaskId = signal<string | null>(null);
  const busy = signal(false);
  const error = signal<string | null>(null);
  const chooseProject = signal(false);
  let sequence = 0;
  let loadingMore = false;

  /** The context a LIST request names: the global one narrows by project only under the Project filter. */
  function listContext(): TaskContext {
    const project = projectId.peek();
    const narrow = kind === "project" || filter.peek() === "project";
    return {
      scope: scope.peek(),
      ...(narrow && project !== undefined ? { projectId: project } : {}),
    };
  }

  /** The context a COUNTS request names: a project panel's counts are narrowed to it; the global ones are not. */
  function countsContext(): TaskContext {
    const project = projectId.peek();
    return {
      scope: scope.peek(),
      ...(kind === "project" && project !== undefined ? { projectId: project } : {}),
    };
  }

  async function load(): Promise<void> {
    const mine = ++sequence;
    loadingMore = false;
    busy.value = true;
    const zone = readZone(options.zone);
    const currentFilter = filter.peek();
    const needsProject = currentFilter === "project" && projectId.peek() === undefined;
    const api = tasksApi();
    const listRequest: TaskListRequest = {
      context: listContext(),
      filter: currentFilter,
      zone,
      limit: TASK_PAGE_SIZE,
    };
    const [listResult, countsResult] = await Promise.allSettled([
      needsProject ? Promise.resolve(null) : api.list(listRequest),
      api.counts({ context: countsContext(), zone }),
    ]);
    if (mine !== sequence) return;

    let failure: string | null = null;
    if (listResult.status === "rejected") {
      failure = errorCodeOf(listResult.reason);
    } else if (listResult.value === null) {
      rows.value = [];
      total.value = 0;
      nextCursor.value = null;
      chooseProject.value = true;
    } else {
      const parsed = TaskListResponseSchema.safeParse(listResult.value);
      if (parsed.success) {
        rows.value = parsed.data.rows;
        total.value = parsed.data.total;
        nextCursor.value = parsed.data.nextCursor;
        chooseProject.value = parsed.data.chooseProject;
      } else {
        failure = "unrecognised-response";
      }
    }
    if (countsResult.status === "rejected") {
      failure ??= errorCodeOf(countsResult.reason);
    } else {
      const parsed = TaskCountsResponseSchema.safeParse(countsResult.value);
      if (parsed.success) counts.value = parsed.data;
      else failure ??= "unrecognised-response";
    }
    error.value = failure;
    busy.value = false;
  }

  async function loadMore(): Promise<void> {
    const cursor = nextCursor.peek();
    if (cursor === null || loadingMore) return;
    loadingMore = true;
    const mine = ++sequence;
    busy.value = true;
    try {
      const response = await tasksApi().list({
        context: listContext(),
        filter: filter.peek(),
        zone: readZone(options.zone),
        cursor,
        limit: TASK_PAGE_SIZE,
      });
      if (mine !== sequence) return;
      const parsed = TaskListResponseSchema.safeParse(response);
      if (!parsed.success) {
        error.value = "unrecognised-response";
        return;
      }
      const have = new Set(rows.peek().map((row) => row.id));
      rows.value = [...rows.peek(), ...parsed.data.rows.filter((row) => !have.has(row.id))];
      total.value = parsed.data.total;
      nextCursor.value = parsed.data.nextCursor;
      error.value = null;
    } catch (cause) {
      if (mine === sequence) error.value = errorCodeOf(cause);
    } finally {
      if (mine === sequence) {
        loadingMore = false;
        busy.value = false;
      }
    }
  }

  return {
    kind,
    filter,
    scope,
    projectId,
    rows,
    total,
    nextCursor,
    counts,
    selectedTaskId,
    busy,
    error,
    chooseProject,
    load,
    loadMore,
    refresh: load,
    setFilter(next) {
      if (kind === "project" && !(TASK_PROJECT_PANEL_FILTERS as readonly string[]).includes(next)) {
        return Promise.resolve();
      }
      filter.value = next;
      return load();
    },
    setScope(next) {
      if (kind === "global") scope.value = next;
    },
    setProject(next) {
      // A value that is not a project id is treated as no choice, never stored.
      if (kind === "global") {
        projectId.value = next === undefined ? undefined : ProjectIdSchema.safeParse(next).data;
      }
    },
    select(taskId) {
      selectedTaskId.value = taskId;
    },
  };
}

/** The project panel's context: fixed to one project, with the panel's own default filter. */
export function createProjectTasksContext(
  projectId: string,
  options: Omit<TasksContextOptions, "projectId"> = {},
): TasksContext {
  return createTasksContext("project", { ...options, projectId });
}

/** The global Tasks destination's context. */
export const globalTasksContext: TasksContext = createTasksContext("global");

/** Every signal's current value as plain data, for tests that compare whole contexts. */
export function contextSnapshot(context: TasksContext): Record<string, unknown> {
  return {
    kind: context.kind,
    filter: context.filter.peek(),
    scope: context.scope.peek(),
    projectId: context.projectId.peek(),
    rows: context.rows.peek(),
    total: context.total.peek(),
    nextCursor: context.nextCursor.peek(),
    counts: context.counts.peek(),
    selectedTaskId: context.selectedTaskId.peek(),
    busy: context.busy.peek(),
    error: context.error.peek(),
    chooseProject: context.chooseProject.peek(),
  };
}
