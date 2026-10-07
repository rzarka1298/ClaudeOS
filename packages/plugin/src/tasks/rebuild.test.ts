import { afterEach, describe, expect, it, vi } from "vitest";
import { TASK_ZONE } from "../test-support/task-view-fixtures.js";
import { fakeTasksApi } from "../test-support/tasks-api-fake.js";
import { configureTasksApi } from "./api.js";
import { createTasksContext } from "./contexts.js";
import { loadAttention, rebuildTaskIndex, tasksAttention, tasksRebuilding } from "./rebuild.js";

afterEach(() => {
  configureTasksApi(null);
  tasksAttention.items.value = [];
  tasksAttention.total.value = 0;
});

describe("Test 9: rebuildTaskIndex", () => {
  it("sets the rebuilding signal, rebuilds, reloads the context and attention, and returns the numbers", async () => {
    const api = fakeTasksApi([]);
    api.rebuild.mockResolvedValue({ tasks: 7, attention: 2 });
    api.attention.mockResolvedValue({
      items: [{ path: "global/tasks/a.md", reason: "missing-id", otherPaths: [] }],
      total: 1,
      nextCursor: null,
    });
    configureTasksApi(api);
    const context = createTasksContext("global", { zone: () => TASK_ZONE });
    const pending = rebuildTaskIndex(context);
    expect(tasksRebuilding.value).toBe(true);
    expect(await pending).toEqual({ tasks: 7, attention: 2 });
    expect(tasksRebuilding.value).toBe(false);
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.attention).toHaveBeenCalledTimes(1);
    expect(tasksAttention.total.value).toBe(1);
  });

  it("returns the same promise to a second call while one runs", async () => {
    const api = fakeTasksApi([]);
    configureTasksApi(api);
    const context = createTasksContext("global", { zone: () => TASK_ZONE });
    const first = rebuildTaskIndex(context);
    const second = rebuildTaskIndex(context);
    expect(second).toBe(first);
    await first;
    expect(api.rebuild).toHaveBeenCalledTimes(1);
  });

  it("clears the flag when the rebuild fails and rethrows", async () => {
    const api = fakeTasksApi([]);
    api.rebuild.mockRejectedValue(new Error("down"));
    configureTasksApi(api);
    await expect(rebuildTaskIndex(createTasksContext("global"))).rejects.toThrow("down");
    expect(tasksRebuilding.value).toBe(false);
  });

  it("keeps the last good attention entries when a load fails", async () => {
    const api = fakeTasksApi([]);
    configureTasksApi(api);
    tasksAttention.items.value = [
      { path: "global/tasks/a.md", reason: "unreadable", otherPaths: [] },
    ];
    api.attention.mockRejectedValue(new Error("x"));
    await loadAttention();
    expect(tasksAttention.items.value).toHaveLength(1);
    expect(tasksAttention.error.value).not.toBeNull();
    vi.restoreAllMocks();
  });
});
