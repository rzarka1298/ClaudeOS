import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ResearchListResponse, ResearchStatusResponse } from "@ccc/domain/research-routes.js";
import type { TaskDueTodayResponse } from "@ccc/domain/tasks.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureResearch } from "../research/api.js";
import { configureTasksApi } from "../tasks/api.js";
import { fakeResearchApi } from "../test-support/research-api-fake.js";
import { listOf, reportRow, unreadableRow } from "../test-support/research-view-fixtures.js";
import { fakeTasksApi } from "../test-support/tasks-api-fake.js";
import {
  automationFeed,
  configureOverviewZone,
  dueTodayFeed,
  latestReportFeed,
  refreshAutomation,
  refreshDueToday,
  refreshLatestReport,
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
  configureResearch(null);
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

/** Installs a research API with inert host ports (the feeds only read through `researchApi()`). */
function useResearch(api: ReturnType<typeof fakeResearchApi>): void {
  configureResearch({
    api,
    notify: () => undefined,
    openNote: () => false,
    copyText: () => false,
    requestRunNow: () => undefined,
  });
}

const NO_RUNS: ResearchStatusResponse = {
  lastSuccess: null,
  lastFailure: null,
  inFlight: null,
  latestUnknown: null,
  configuredSources: null,
  topicLabel: null,
};

describe("Task 2: automation, latest report and reset", () => {
  it("Test 1: a slow automation answer A never overwrites a fast answer B", async () => {
    const a = deferred<ResearchStatusResponse>();
    const b = deferred<ResearchStatusResponse>();
    const answers = [a, b];
    let next = 0;
    useResearch(fakeResearchApi({ status: vi.fn(() => (answers[next++] ?? b).promise) }));
    const first = refreshAutomation();
    const second = refreshAutomation();
    const answerB: ResearchStatusResponse = { ...NO_RUNS, topicLabel: "B" };
    b.resolve(answerB);
    await second;
    a.resolve({ ...NO_RUNS, topicLabel: "A" });
    await first;
    expect(automationFeed.value.value).toEqual(answerB);
  });

  it("Test 2: a slow latest-report answer A never overwrites B, and the page is mapped inside the fetcher", async () => {
    const a = deferred<ResearchListResponse>();
    const b = deferred<ResearchListResponse>();
    const answers = [a, b];
    let next = 0;
    useResearch(fakeResearchApi({ list: vi.fn(() => (answers[next++] ?? b).promise) }));
    const first = refreshLatestReport();
    const second = refreshLatestReport();
    const newest = reportRow(1);
    b.resolve(listOf([unreadableRow(), newest, unreadableRow("other.md")]));
    await second;
    a.resolve(listOf([reportRow(2)]));
    await first;
    expect(latestReportFeed.value.value).toEqual({ latest: newest, unreadableCount: 2 });
  });

  it("Test 3: three answers in flight, resetOverviewFeeds(), then all three resolve: every feed reads NEVER", async () => {
    const due = deferred<TaskDueTodayResponse>();
    const status = deferred<ResearchStatusResponse>();
    const list = deferred<ResearchListResponse>();
    configureTasksApi(fakeTasksApi([], { dueToday: vi.fn(() => due.promise) }));
    useResearch(
      fakeResearchApi({ status: vi.fn(() => status.promise), list: vi.fn(() => list.promise) }),
    );
    const all = [refreshDueToday(), refreshAutomation(), refreshLatestReport()];
    resetOverviewFeeds();
    due.resolve({ due: [], overdue: [] });
    status.resolve(NO_RUNS);
    list.resolve(listOf([reportRow(1)]));
    await Promise.all(all);
    const never = { settled: false, value: null, fetchedAt: null, failed: false };
    expect(dueTodayFeed.value).toEqual(never);
    expect(automationFeed.value).toEqual(never);
    expect(latestReportFeed.value).toEqual(never);
  });

  it("Test 4: the three module-level sequence counters are gone; each feed is one line over the helper", () => {
    const source = readFileSync(resolve(process.cwd(), "src/overview/overview-feeds.ts"), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(source).not.toMatch(/\b(dueSeq|automationSeq|reportSeq)\b/);
    expect(source.match(/\bsuperseding\(/g) ?? []).toHaveLength(3);
  });
});
