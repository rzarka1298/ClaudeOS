import type { TaskDueTodayResponse, TaskDueTodayRow } from "@ccc/domain/tasks.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import { connectionState } from "../connection-state.js";
import { configureTasksApi, type TasksApi } from "../tasks/api.js";
import { resetTasksGeneration, tasksGeneration } from "../tasks/events.js";
import { fakeTasksApi } from "../test-support/tasks-api-fake.js";
import { nowTick } from "../widgets/clock.js";
import { CONSTANT_STATE_WIDGET_IDS, widgetStateFor } from "../widgets/widget-data.js";
import {
  configureOverviewZone,
  dueTodayFeed,
  type FeedSnapshot,
  LIVE_WINDOW_MS,
  refreshDueToday,
  refreshOnTick,
  resetOverviewFeeds,
  startOverviewFeeds,
  TICK_REFRESH_MIN_GAP_MS,
  todayStateFor,
} from "./overview-feeds.js";

/**
 * The Overview feeds behind the Today card (plan 08-14). The mapping tests call
 * `todayStateFor` with explicit feeds, a connection and a clock, so no test
 * depends on the machine's zone or time; the refresh tests drive the module
 * with a fake tasks API and a pinned system clock.
 */

const ZONE = "America/Chicago";
/** 2026-10-22 13:00 in Chicago (CDT, UTC-5). */
const NOW = Date.parse("2026-10-22T18:00:00Z");
const LIVE: ConnectionState = { kind: "live" };

function row(
  partial: Partial<TaskDueTodayRow> & { taskId: string; title: string },
): TaskDueTodayRow {
  return partial;
}

function feed(
  value: TaskDueTodayResponse | null,
  extra: Partial<FeedSnapshot<TaskDueTodayResponse>> = {},
): FeedSnapshot<TaskDueTodayResponse> {
  return {
    settled: true,
    value,
    fetchedAt: value === null ? null : NOW - 1000,
    failed: false,
    ...extra,
  };
}

const REVIEW = row({
  taskId: "0mfk1a2b30000000000000001",
  title: "Review release notes",
  dueAt: "2026-10-22T22:00:00Z",
});

afterEach(() => {
  vi.useRealTimers();
  configureTasksApi(null);
  configureOverviewZone(null);
  resetOverviewFeeds();
  resetTasksGeneration();
  connectionState.value = { kind: "connecting" };
});

describe("Task 1 (tracer): the registry no longer treats Today as a constant", () => {
  it("Test 2: Today is not in CONSTANT_STATE_WIDGET_IDS, and it is a live signal", () => {
    expect(CONSTANT_STATE_WIDGET_IDS.has("today")).toBe(false);
    expect(CONSTANT_STATE_WIDGET_IDS.has("github-discoveries")).toBe(true);
  });
});

describe("todayStateFor: tasks only (Task 1)", () => {
  it("is loading while connecting and nothing has been fetched", () => {
    const state = todayStateFor(
      { tasks: { settled: false, value: null, fetchedAt: null, failed: false } },
      { kind: "connecting" },
      NOW,
      ZONE,
    );
    expect(state).toEqual({ kind: "loading" });
  });

  it("is unavailable while disconnected and nothing has been fetched (the frame shows disconnected)", () => {
    const state = todayStateFor(
      { tasks: { settled: false, value: null, fetchedAt: null, failed: false } },
      { kind: "disconnected", reason: "closed" },
      NOW,
      ZONE,
    );
    expect(state).toEqual({ kind: "unavailable" });
  });

  it("is the frame error, never unavailable, when the feed failed while connected", () => {
    const state = todayStateFor(
      { tasks: { settled: true, value: null, fetchedAt: null, failed: true } },
      LIVE,
      NOW,
      ZONE,
    );
    expect(state.kind).toBe("error");
  });

  it("maps a due task to a ready, partial, live card dated by the fetch", () => {
    const state = todayStateFor({ tasks: feed({ due: [REVIEW], overdue: [] }) }, LIVE, NOW, ZONE);
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.freshness).toBe("live");
    expect(state.partiality.partial).toBe(true);
    expect(state.observedAt).toBe(new Date(NOW - 1000).toISOString());
    expect(state.data.tasks?.rows).toEqual([
      { taskId: REVIEW.taskId, title: REVIEW.title, meta: "Due 5:00 PM" },
    ]);
  });

  it("shows overdue rows first with `Overdue since {Mon D}`, and a dated row as `Due {Mon D}`", () => {
    const overdue = row({
      taskId: "0mfk1a2b30000000000000002",
      title: "Pay invoice",
      dueDate: "2026-10-18",
    });
    const dated = row({
      taskId: "0mfk1a2b30000000000000003",
      title: "File taxes",
      dueDate: "2026-10-22",
    });
    const state = todayStateFor(
      { tasks: feed({ due: [REVIEW, dated], overdue: [overdue] }) },
      LIVE,
      NOW,
      ZONE,
    );
    if (state.kind !== "ready") throw new Error("not ready");
    expect(state.data.tasks?.rows.map((task) => task.meta)).toEqual([
      "Overdue since Oct 18",
      "Due Oct 22",
      "Due 5:00 PM",
    ]);
  });

  it("orders the displayed rows by the owner's zone, not by the service's text key (FIX1A)", () => {
    // 2026-10-20T02:00Z is 21:00 on Oct 19 in Chicago: earlier than the all-day
    // Oct 20, though the service's text key puts the date first.
    const allDay = row({
      taskId: "0mfk1a2b30000000000000004",
      title: "All day",
      dueDate: "2026-10-20",
    });
    const lateNight = row({
      taskId: "0mfk1a2b30000000000000005",
      title: "Late night",
      dueAt: "2026-10-20T02:00:00Z",
    });
    const state = todayStateFor(
      { tasks: feed({ due: [], overdue: [allDay, lateNight] }) },
      LIVE,
      NOW,
      ZONE,
    );
    if (state.kind !== "ready") throw new Error("not ready");
    expect(state.data.tasks?.rows.map((task) => task.title)).toEqual(["Late night", "All day"]);
  });

  it("says Scheduled, never Due, for a task that is only scheduled today", () => {
    const scheduled = row({
      taskId: "0mfk1a2b30000000000000006",
      title: "Plan the week",
      scheduledAt: "2026-10-22T20:30:00Z",
    });
    const state = todayStateFor(
      { tasks: feed({ due: [scheduled], overdue: [] }) },
      LIVE,
      NOW,
      ZONE,
    );
    if (state.kind !== "ready") throw new Error("not ready");
    expect(state.data.tasks?.rows[0]?.meta).toBe("Scheduled 3:30 PM");
  });

  it("goes stale when the answer is older than the live window, and never live while disconnected", () => {
    const old = feed({ due: [REVIEW], overdue: [] }, { fetchedAt: NOW - LIVE_WINDOW_MS - 1 });
    const stale = todayStateFor({ tasks: old }, LIVE, NOW, ZONE);
    if (stale.kind !== "ready") throw new Error("not ready");
    expect(stale.freshness).toBe("stale");
    const fresh = feed({ due: [REVIEW], overdue: [] });
    const away = todayStateFor({ tasks: fresh }, { kind: "disconnected", reason: "x" }, NOW, ZONE);
    if (away.kind !== "ready") throw new Error("not ready");
    expect(away.freshness).toBe("stale");
  });

  it("keeps the last good rows when a refresh fails, marks the card stale and names the source", () => {
    const failed = feed({ due: [REVIEW], overdue: [] }, { failed: true });
    const state = todayStateFor({ tasks: failed }, LIVE, NOW, ZONE);
    if (state.kind !== "ready") throw new Error("not ready");
    expect(state.freshness).toBe("stale");
    expect(state.partiality.missingSources).toContain("Managed task store");
    expect(state.data.tasks?.rows).toHaveLength(1);
  });
});

describe("refreshDueToday and the feed (Task 1)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    configureOverviewZone(ZONE);
  });

  function use(api: Partial<TasksApi>): ReturnType<typeof fakeTasksApi> {
    const fake = fakeTasksApi([], api);
    configureTasksApi(fake as unknown as TasksApi);
    return fake;
  }

  it("asks for the owner's zone and stores the answer with its fetch time", async () => {
    const fake = use({ dueToday: vi.fn(() => Promise.resolve({ due: [REVIEW], overdue: [] })) });
    await refreshDueToday();
    expect(fake.dueToday).toHaveBeenCalledExactlyOnceWith({ zone: ZONE });
    expect(dueTodayFeed.value).toEqual({
      settled: true,
      value: { due: [REVIEW], overdue: [] },
      fetchedAt: NOW,
      failed: false,
    });
  });

  it("with the tasks API unconfigured the feed fails and the card never reports ready (Test 4)", async () => {
    connectionState.value = LIVE;
    await refreshDueToday();
    expect(dueTodayFeed.value).toMatchObject({ settled: true, value: null, failed: true });
    expect(widgetStateFor("today").value.kind).not.toBe("ready");
  });

  it("a later answer wins over a slower earlier one (sequence token)", async () => {
    let releaseFirst: (value: TaskDueTodayResponse) => void = () => undefined;
    const first = new Promise<TaskDueTodayResponse>((resolve) => {
      releaseFirst = resolve;
    });
    const dueToday = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(Promise.resolve({ due: [REVIEW], overdue: [] }));
    use({ dueToday });
    const slow = refreshDueToday();
    await refreshDueToday();
    releaseFirst({ due: [], overdue: [] });
    await slow;
    expect(dueTodayFeed.value.value).toEqual({ due: [REVIEW], overdue: [] });
  });

  it("a failed refresh keeps the last good value", async () => {
    use({ dueToday: vi.fn(() => Promise.resolve({ due: [REVIEW], overdue: [] })) });
    await refreshDueToday();
    use({ dueToday: vi.fn(() => Promise.reject(new Error("down"))) });
    await refreshDueToday();
    expect(dueTodayFeed.value).toMatchObject({
      failed: true,
      value: { due: [REVIEW], overdue: [] },
      fetchedAt: NOW,
    });
  });
});

describe("the triggers: mount, going live, tasks.changed and the shared tick (Task 1)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    nowTick.value = NOW;
  });

  it("refreshes on start only while live, again when the connection becomes live, and stops on dispose", async () => {
    const fake = fakeTasksApi([], {
      dueToday: vi.fn(() => Promise.resolve({ due: [], overdue: [] })),
    });
    configureTasksApi(fake as unknown as TasksApi);

    const stop = startOverviewFeeds();
    expect(fake.dueToday).not.toHaveBeenCalled();

    connectionState.value = LIVE;
    expect(fake.dueToday).toHaveBeenCalledTimes(1);

    // An equal state does not refresh again; leaving and re-entering live does.
    connectionState.value = { kind: "live" };
    expect(fake.dueToday).toHaveBeenCalledTimes(1);
    connectionState.value = { kind: "disconnected", reason: "x" };
    connectionState.value = LIVE;
    expect(fake.dueToday).toHaveBeenCalledTimes(2);

    stop();
    connectionState.value = { kind: "disconnected", reason: "x" };
    connectionState.value = LIVE;
    expect(fake.dueToday).toHaveBeenCalledTimes(2);
  });

  it("refreshes the due-today feed when tasks.changed advances the generation while live", () => {
    const fake = fakeTasksApi([], {
      dueToday: vi.fn(() => Promise.resolve({ due: [], overdue: [] })),
    });
    configureTasksApi(fake as unknown as TasksApi);
    connectionState.value = LIVE;
    const stop = startOverviewFeeds();
    expect(fake.dueToday).toHaveBeenCalledTimes(1);

    tasksGeneration.value = 5;
    expect(fake.dueToday).toHaveBeenCalledTimes(2);
    tasksGeneration.value = 5;
    expect(fake.dueToday).toHaveBeenCalledTimes(2);
    stop();
  });

  it("refreshes on a tick only while live and only after the minimum gap", () => {
    const fake = fakeTasksApi([], {
      dueToday: vi.fn(() => Promise.resolve({ due: [], overdue: [] })),
    });
    configureTasksApi(fake as unknown as TasksApi);

    refreshOnTick();
    expect(fake.dueToday).not.toHaveBeenCalled();

    connectionState.value = LIVE;
    const stop = startOverviewFeeds();
    expect(fake.dueToday).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + TICK_REFRESH_MIN_GAP_MS - 1);
    refreshOnTick();
    expect(fake.dueToday).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 60_000);
    refreshOnTick();
    expect(fake.dueToday).toHaveBeenCalledTimes(2);

    vi.setSystemTime(NOW + 60_000 + 1_000);
    refreshOnTick();
    expect(fake.dueToday).toHaveBeenCalledTimes(2);
    stop();
  });
});
