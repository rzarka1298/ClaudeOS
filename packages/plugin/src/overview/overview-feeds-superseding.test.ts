import type { TaskDueTodayResponse } from "@ccc/domain/tasks.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureTasksApi } from "../tasks/api.js";
import { fakeTasksApi } from "../test-support/tasks-api-fake.js";
import {
  configureOverviewZone,
  dueTodayFeed,
  refreshDueToday,
  resetOverviewFeeds,
} from "./overview-feeds.js";

/**
 * A slow answer never replaces a newer one on any Overview card (09-06, D-13, T-09-10). Each
 * feed is driven through its public refresher with two answers in flight, the first started
 * slow and resolved last.
 */

const NOW = Date.parse("2026-10-22T18:00:00Z");

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  configureOverviewZone("America/Chicago");
});

afterEach(() => {
  vi.useRealTimers();
  configureTasksApi(null);
  configureOverviewZone(null);
  resetOverviewFeeds();
});

describe("Task 1 (tracer): due today", () => {
  it("Test 2: a slow answer A started before a fast answer B never overwrites B", async () => {
    const a = deferred<TaskDueTodayResponse>();
    const b = deferred<TaskDueTodayResponse>();
    const answers = [a, b];
    let next = 0;
    configureTasksApi(fakeTasksApi([], { dueToday: vi.fn(() => (answers[next++] ?? b).promise) }));
    const first = refreshDueToday();
    const second = refreshDueToday();
    const answerB: TaskDueTodayResponse = {
      due: [{ taskId: "b".repeat(25), title: "B" }],
      overdue: [],
    };
    const answerA: TaskDueTodayResponse = {
      due: [{ taskId: "a".repeat(25), title: "A" }],
      overdue: [],
    };
    b.resolve(answerB);
    await second;
    a.resolve(answerA);
    await first;
    expect(dueTodayFeed.value.value).toEqual(answerB);
    expect(dueTodayFeed.value.failed).toBe(false);
  });
});
