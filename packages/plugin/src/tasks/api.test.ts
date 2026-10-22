// Plan 06-18, Task 2, Test 8: the task API holder.
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureTasksApi, type TasksApi, TasksApiError, tasksApi } from "./api.js";

afterEach(() => configureTasksApi(null));

const FUNCTIONS = [
  "create",
  "list",
  "counts",
  "get",
  "changed",
  "rebuild",
  "attention",
  "dueToday",
];

describe("Test 8: the task API holder", () => {
  it("exposes create, list, counts, get, changed, rebuild, attention and dueToday only", () => {
    expect(Object.keys(tasksApi()).sort()).toEqual([...FUNCTIONS].sort());
  });

  it("rejects every function with service-disconnected until configured", async () => {
    const api = tasksApi() as unknown as Record<string, (request?: unknown) => Promise<unknown>>;
    for (const name of FUNCTIONS) {
      const failure = await (api[name]?.({}) ?? Promise.resolve()).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TasksApiError);
      expect((failure as TasksApiError).code).toBe("service-disconnected");
    }
  });

  it("routes through a configured API, and restores the default on null", async () => {
    const changed = vi.fn(() => Promise.resolve({ accepted: 1, generation: 2 }));
    configureTasksApi({ changed } as unknown as TasksApi);
    await expect(tasksApi().changed({ paths: [] })).resolves.toEqual({
      accepted: 1,
      generation: 2,
    });
    expect(changed).toHaveBeenCalledTimes(1);
    configureTasksApi(null);
    await expect(tasksApi().changed({ rescan: true })).rejects.toBeInstanceOf(TasksApiError);
  });
});

describe("08-03 Task 3 Test 2: dueToday carries nextOpen unchanged", () => {
  const request = { zone: "UTC" };
  const next = {
    taskId: "abcdefghi0123456789abcdef",
    title: "Plan the offsite",
    dueDate: "2026-10-12",
  };

  it("resolves the field exactly as the service sent it, including null", async () => {
    for (const nextOpen of [next, null]) {
      const response = { due: [], overdue: [], nextOpen };
      const dueToday = vi.fn(() => Promise.resolve(response));
      configureTasksApi({ dueToday } as unknown as TasksApi);
      const result = await tasksApi().dueToday(request);
      expect(result).toBe(response);
      expect(result.nextOpen).toEqual(nextOpen);
      expect(dueToday).toHaveBeenCalledWith(request);
    }
  });

  it("an older service that omits it leaves nextOpen undefined, which means unknown, never no open task", async () => {
    const response = { due: [], overdue: [] };
    configureTasksApi({ dueToday: () => Promise.resolve(response) } as unknown as TasksApi);
    const result = await tasksApi().dueToday(request);
    expect("nextOpen" in result).toBe(false);
    expect(result.nextOpen).toBeUndefined();
    expect(result.nextOpen).not.toBeNull();
  });
});
