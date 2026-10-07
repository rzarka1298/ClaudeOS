// Plan 06-18, Task 2: the two independent query contexts (D-34, TASK-07, UI-SPEC R-11).
import { resolvedZone } from "@ccc/domain/task-time.js";
import type { TaskListRequest, TaskListResponse } from "@ccc/domain/tasks.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskRow, taskRows } from "../test-support/task-view-fixtures.js";
import { configureTasksApi, type TasksApi, TasksApiError } from "./api.js";
import {
  contextSnapshot,
  createProjectTasksContext,
  createTasksContext,
  globalTasksContext,
} from "./contexts.js";

afterEach(() => configureTasksApi(null));

const ZERO_COUNTS = {
  all: 0,
  today: 0,
  upcoming: 0,
  overdue: 0,
  project: 0,
  proposed: 0,
  blocked: 0,
  completed: 0,
};
const PROJECT = "mfz0a1b2c0123456789abcdef";
const OTHER_PROJECT = "mfz0a1b2d0123456789abcdef";

function page(
  rows: ReturnType<typeof taskRows>,
  nextCursor: string | null = null,
  total = rows.length,
): TaskListResponse {
  return { rows, total, nextCursor, chooseProject: false };
}

function install(overrides: Partial<TasksApi> = {}) {
  const list = vi.fn((_request: TaskListRequest) => Promise.resolve(page(taskRows(3))));
  const counts = vi.fn((_request: unknown) =>
    Promise.resolve({ counts: { ...ZERO_COUNTS, today: 3, all: 9 }, open: 7 }),
  );
  configureTasksApi({ list, counts, ...overrides } as unknown as TasksApi);
  return { list, counts };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("Test 4: the contexts are independent", () => {
  it("operating one never changes any signal of the other, compared as full snapshots", async () => {
    install();
    const global = createTasksContext("global", { zone: () => "UTC" });
    const projectA = createProjectTasksContext(PROJECT, { zone: () => "UTC" });
    const projectB = createProjectTasksContext(OTHER_PROJECT, { zone: () => "UTC" });
    await projectA.load();
    await projectB.load();
    const before = { global: contextSnapshot(global), b: contextSnapshot(projectB) };
    const aBefore = contextSnapshot(projectA);

    global.select("x");
    global.setScope("workspace:mfz0a1b2c3d4e5f6g7h8i9j0k");
    await global.setFilter("overdue");
    await global.loadMore();
    expect(contextSnapshot(projectA)).toEqual(aBefore);
    expect(contextSnapshot(projectB)).toEqual(before.b);

    const globalAfter = contextSnapshot(global);
    projectA.select("y");
    await projectA.setFilter("blocked");
    expect(contextSnapshot(global)).toEqual(globalAfter);
    expect(contextSnapshot(projectB)).toEqual(before.b);
    expect(contextSnapshot(projectA)).not.toEqual(aBefore);
  });

  it("exposes a global context instance and a project factory that share no signal", () => {
    const project = createProjectTasksContext(PROJECT);
    expect(project.filter).not.toBe(globalTasksContext.filter);
    expect(project.rows).not.toBe(globalTasksContext.rows);
    expect(project.selectedTaskId).not.toBe(globalTasksContext.selectedTaskId);
    expect(globalTasksContext.filter.value).toBe("today");
    expect(project.filter.value).toBe("all");
  });
});

describe("Test 5: context behaviour", () => {
  it("loads page one with the context's filter, scope, zone and a page size of 25, and stores rows, total, cursor and counts", async () => {
    const { list, counts } = install();
    list.mockResolvedValueOnce(page(taskRows(3), "cur1", 40));
    const context = createTasksContext("global", { zone: () => "America/New_York" });
    await context.load();
    expect(list).toHaveBeenCalledWith({
      context: { scope: "all" },
      filter: "today",
      zone: "America/New_York",
      limit: 25,
    });
    expect(counts).toHaveBeenCalledWith({ context: { scope: "all" }, zone: "America/New_York" });
    expect(context.rows.value).toHaveLength(3);
    expect(context.total.value).toBe(40);
    expect(context.nextCursor.value).toBe("cur1");
    expect(context.counts.value?.counts.today).toBe(3);
    expect(context.busy.value).toBe(false);
    expect(context.error.value).toBeNull();
  });

  it("appends the next page on loadMore and ignores a repeat while none remains", async () => {
    const { list } = install();
    list.mockResolvedValueOnce(page(taskRows(2), "cur1", 3));
    const context = createTasksContext("global", { zone: () => "UTC" });
    await context.load();
    list.mockResolvedValueOnce(page([taskRow(3)], null, 3));
    await context.loadMore();
    expect(list.mock.calls[1]?.[0]).toMatchObject({ cursor: "cur1", filter: "today" });
    expect(context.rows.value.map((row) => row.title)).toEqual(["Task 1", "Task 2", "Task 3"]);
    expect(context.nextCursor.value).toBeNull();
    await context.loadMore();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps the old rows visible with the busy flag while a changed filter loads", async () => {
    const { list } = install();
    const context = createTasksContext("global", { zone: () => "UTC" });
    await context.load();
    const next = deferred<TaskListResponse>();
    list.mockReturnValueOnce(next.promise);
    const pending = context.setFilter("upcoming");
    expect(context.filter.value).toBe("upcoming");
    expect(context.rows.value).toHaveLength(3);
    expect(context.busy.value).toBe(true);
    next.resolve(page([taskRow(9)]));
    await pending;
    expect(context.rows.value.map((row) => row.title)).toEqual(["Task 9"]);
    expect(context.busy.value).toBe(false);
  });

  it("keeps last-good rows and sets an error when a load fails", async () => {
    const { list } = install();
    const context = createTasksContext("global", { zone: () => "UTC" });
    await context.load();
    list.mockRejectedValueOnce(new TasksApiError("service-disconnected"));
    await context.refresh();
    expect(context.rows.value).toHaveLength(3);
    expect(context.error.value).toBe("service-disconnected");
    expect(context.busy.value).toBe(false);
    list.mockResolvedValueOnce({ nonsense: true } as unknown as TaskListResponse);
    await context.refresh();
    expect(context.error.value).toBe("unrecognised-response");
    expect(context.rows.value).toHaveLength(3);
  });

  it("applies only the latest of two overlapping loads", async () => {
    const { list } = install();
    const context = createTasksContext("global", { zone: () => "UTC" });
    const slow = deferred<TaskListResponse>();
    list.mockReturnValueOnce(slow.promise);
    const first = context.load();
    list.mockResolvedValueOnce(page([taskRow(5)]));
    const second = context.setFilter("overdue");
    await second;
    slow.resolve(page([taskRow(1)]));
    await first;
    expect(context.rows.value.map((row) => row.title)).toEqual(["Task 5"]);
  });

  it("counts and lists follow the context's own scope and project", async () => {
    const { list, counts } = install();
    const project = createProjectTasksContext(PROJECT, { zone: () => "UTC" });
    await project.load();
    expect(list.mock.calls[0]?.[0]).toMatchObject({
      context: { scope: "all", projectId: PROJECT },
      filter: "all",
    });
    expect(counts.mock.calls[0]?.[0]).toMatchObject({
      context: { scope: "all", projectId: PROJECT },
    });

    const global = createTasksContext("global", { zone: () => "UTC" });
    global.setScope("global");
    await global.load();
    expect(list.mock.calls[1]?.[0]).toMatchObject({ context: { scope: "global" } });
    expect(counts.mock.calls[1]?.[0]).toMatchObject({ context: { scope: "global" } });
  });

  it("sends the chosen project to the list only under the Project filter, and never to the counts", async () => {
    const { list, counts } = install();
    const global = createTasksContext("global", { zone: () => "UTC" });
    global.setProject(PROJECT);
    await global.load();
    expect(list.mock.calls[0]?.[0]?.context).toEqual({ scope: "all" });
    await global.setFilter("project");
    expect(list.mock.calls[1]?.[0]?.context).toEqual({ scope: "all", projectId: PROJECT });
    for (const call of counts.mock.calls)
      expect((call[0] as { context: object }).context).toEqual({ scope: "all" });
  });

  it("loads nothing and says so when the Project filter has no chosen project", async () => {
    const { list, counts } = install();
    const global = createTasksContext("global", { zone: () => "UTC" });
    await global.setFilter("project");
    expect(list).not.toHaveBeenCalled();
    expect(counts).toHaveBeenCalled();
    expect(global.chooseProject.value).toBe(true);
    expect(global.rows.value).toEqual([]);
    expect(global.total.value).toBe(0);
  });
});

describe("Test 6: the zone", () => {
  it("is read once per load and sent on both requests", async () => {
    const { list, counts } = install();
    const zone = vi.fn(() => "Europe/Paris");
    await createTasksContext("global", { zone }).load();
    expect(zone).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]?.[0]?.zone).toBe("Europe/Paris");
    expect(counts.mock.calls[0]?.[0]).toMatchObject({ zone: "Europe/Paris" });
  });

  it("falls back to the runtime's resolved zone when the supplied one is invalid", async () => {
    const { list } = install();
    await createTasksContext("global", { zone: () => "Not/AZone" }).load();
    expect(list.mock.calls[0]?.[0]?.zone).toBe(resolvedZone());
  });
});
