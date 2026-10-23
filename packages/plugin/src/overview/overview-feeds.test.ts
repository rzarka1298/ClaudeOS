import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResearchStatusResponse } from "@ccc/domain/research-routes.js";
import type { TaskDueTodayResponse, TaskDueTodayRow } from "@ccc/domain/tasks.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import { connectionState } from "../connection-state.js";
import { configureResearch, type ResearchApi } from "../research/api.js";
import { overviewResearchEpoch } from "../research/events.js";
import { configureTasksApi, type TasksApi } from "../tasks/api.js";
import { resetTasksGeneration, tasksGeneration } from "../tasks/events.js";
import { fakeResearchApi } from "../test-support/research-api-fake.js";
import {
  iso,
  listOf,
  RESEARCH_NOW_MS,
  reportRow,
  unreadableRow,
} from "../test-support/research-view-fixtures.js";
import { fakeTasksApi } from "../test-support/tasks-api-fake.js";
import { nowTick } from "../widgets/clock.js";
import { CONSTANT_STATE_WIDGET_IDS, widgetStateFor } from "../widgets/widget-data.js";
import {
  automationFeed,
  configureOverviewZone,
  dueTodayFeed,
  type FeedSnapshot,
  type LatestReportAnswer,
  LIVE_WINDOW_MS,
  latestReportFeed,
  refreshAutomation,
  refreshDueToday,
  refreshLatestReport,
  refreshOnTick,
  resetOverviewFeeds,
  startOverviewFeeds,
  TICK_REFRESH_MIN_GAP_MS,
  techIntelStateFor,
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

const NO_RUNS: ResearchStatusResponse = {
  lastSuccess: null,
  lastFailure: null,
  inFlight: null,
  latestUnknown: null,
  configuredSources: null,
  topicLabel: null,
};

function autoFeed(
  value: ResearchStatusResponse | null,
  extra: Partial<FeedSnapshot<ResearchStatusResponse>> = {},
): FeedSnapshot<ResearchStatusResponse> {
  return {
    settled: true,
    value,
    fetchedAt: value === null ? null : NOW - 500,
    failed: false,
    ...extra,
  };
}

/**
 * A `lastFailure` record. The code is typed as a string on purpose: a newer
 * service may send a code this build does not know, and the card must still
 * show a fixed reason for it (never the remote string).
 */
function failed(
  runId: string,
  endedAt: string,
  errorCode: string,
): ResearchStatusResponse["lastFailure"] {
  return { runId, endedAt, errorCode } as ResearchStatusResponse["lastFailure"];
}

const AUTO_OK = autoFeed(NO_RUNS);
const UNSETTLED_AUTO: FeedSnapshot<ResearchStatusResponse> = {
  settled: false,
  value: null,
  fetchedAt: null,
  failed: false,
};

/** Both feeds for `todayStateFor`; the automation feed is clean unless a test says otherwise. */
function both(
  tasks: FeedSnapshot<TaskDueTodayResponse>,
  automation: FeedSnapshot<ResearchStatusResponse> = AUTO_OK,
) {
  return { tasks, automation };
}

const REVIEW = row({
  taskId: "0mfk1a2b30000000000000001",
  title: "Review release notes",
  dueAt: "2026-10-22T22:00:00Z",
});

afterEach(() => {
  vi.useRealTimers();
  configureTasksApi(null);
  configureResearch(null);
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
      both({ settled: false, value: null, fetchedAt: null, failed: false }, UNSETTLED_AUTO),
      { kind: "connecting" },
      NOW,
      ZONE,
    );
    expect(state).toEqual({ kind: "loading" });
  });

  it("is unavailable while disconnected and nothing has been fetched (the frame shows disconnected)", () => {
    const state = todayStateFor(
      both({ settled: false, value: null, fetchedAt: null, failed: false }, UNSETTLED_AUTO),
      { kind: "disconnected", reason: "closed" },
      NOW,
      ZONE,
    );
    expect(state).toEqual({ kind: "unavailable" });
  });

  it("is the frame error, never unavailable, when the feed failed while connected", () => {
    const state = todayStateFor(
      both(
        { settled: true, value: null, fetchedAt: null, failed: true },
        autoFeed(null, { failed: true }),
      ),
      LIVE,
      NOW,
      ZONE,
    );
    expect(state.kind).toBe("error");
  });

  it("maps a due task to a ready, partial, live card dated by the fetch", () => {
    const state = todayStateFor(both(feed({ due: [REVIEW], overdue: [] })), LIVE, NOW, ZONE);
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.freshness).toBe("live");
    expect(state.partiality.partial).toBe(true);
    // Dated by the newest answer: the automation feed arrived 500 ms ago, the task feed 1000 ms ago.
    expect(state.observedAt).toBe(new Date(NOW - 500).toISOString());
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
      both(feed({ due: [REVIEW, dated], overdue: [overdue] })),
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
      both(feed({ due: [], overdue: [allDay, lateNight] })),
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
    const state = todayStateFor(both(feed({ due: [scheduled], overdue: [] })), LIVE, NOW, ZONE);
    if (state.kind !== "ready") throw new Error("not ready");
    expect(state.data.tasks?.rows[0]?.meta).toBe("Scheduled 3:30 PM");
  });

  it("shows today's scheduled time, not a later deadline, for a task scheduled today and due later (Codex wave 3)", () => {
    const later = row({
      taskId: "0mfk1a2b30000000000000007",
      title: "Draft the report",
      scheduledAt: "2026-10-22T14:00:00Z",
      dueAt: "2026-10-23T22:00:00Z",
    });
    const state = todayStateFor(both(feed({ due: [later], overdue: [] })), LIVE, NOW, ZONE);
    if (state.kind !== "ready") throw new Error("not ready");
    expect(state.data.tasks?.rows[0]?.meta).toBe("Scheduled 9:00 AM");
  });

  it("names the deadline's date when a row has only a deadline that is not today", () => {
    const tomorrow = row({
      taskId: "0mfk1a2b30000000000000008",
      title: "Send the draft",
      dueDate: "2026-10-23",
    });
    const state = todayStateFor(both(feed({ due: [tomorrow], overdue: [] })), LIVE, NOW, ZONE);
    if (state.kind !== "ready") throw new Error("not ready");
    expect(state.data.tasks?.rows[0]?.meta).toBe("Due Oct 23");
  });

  it("shows a task that is both overdue and scheduled today once, as overdue (Codex wave 3)", () => {
    const both_ = row({
      taskId: "0mfk1a2b30000000000000009",
      title: "Fix the build",
      dueDate: "2026-10-20",
      scheduledDate: "2026-10-22",
    });
    const state = todayStateFor(
      both(feed({ due: [both_, REVIEW], overdue: [both_] })),
      LIVE,
      NOW,
      ZONE,
    );
    if (state.kind !== "ready") throw new Error("not ready");
    const rows = state.data.tasks?.rows ?? [];
    expect(rows.map((task) => task.title)).toEqual(["Fix the build", "Review release notes"]);
    expect(rows[0]?.meta).toBe("Overdue since Oct 20");
  });

  it("goes stale when the answer is older than the live window, and never live while disconnected", () => {
    const old = feed({ due: [REVIEW], overdue: [] }, { fetchedAt: NOW - LIVE_WINDOW_MS - 1 });
    const stale = todayStateFor(both(old), LIVE, NOW, ZONE);
    if (stale.kind !== "ready") throw new Error("not ready");
    expect(stale.freshness).toBe("stale");
    const fresh = feed({ due: [REVIEW], overdue: [] });
    const away = todayStateFor(both(fresh), { kind: "disconnected", reason: "x" }, NOW, ZONE);
    if (away.kind !== "ready") throw new Error("not ready");
    expect(away.freshness).toBe("stale");
  });

  it("keeps the last good rows when a refresh fails, marks the card stale and names the source", () => {
    const failed = feed({ due: [REVIEW], overdue: [] }, { failed: true });
    const state = todayStateFor(both(failed), LIVE, NOW, ZONE);
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
    configureTasksApi(fake);
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
    configureTasksApi(fake);

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
    configureTasksApi(fake);
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
    configureTasksApi(fake);

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

// ---------------------------------------------------------------------------
// Task 2: next open task, the automation line, feed failures, the empty rule
// ---------------------------------------------------------------------------

function ready(
  tasks: FeedSnapshot<TaskDueTodayResponse>,
  automation: FeedSnapshot<ResearchStatusResponse> = AUTO_OK,
  connection: ConnectionState = LIVE,
) {
  const state = todayStateFor(both(tasks, automation), connection, NOW, ZONE);
  if (state.kind !== "ready") throw new Error(`expected ready, got ${state.kind}`);
  return state;
}

const NEXT = row({
  taskId: "0mfk1a2b30000000000000009",
  title: "Plan the Q4 review",
  dueAt: "2026-10-25T15:00:00Z",
});
const UNDATED = row({ taskId: "0mfk1a2b3000000000000000a", title: "Tidy the inbox" });
const FAILED_AT = "2026-10-22T16:00:00Z";
const OK_RUN = {
  runId: "run-ok",
  endedAt: "2026-10-22T10:00:00Z",
  outcome: "success" as const,
  sourceCount: 3,
  sourceTotal: 3,
  reportNoteId: "0mfk1a2b3000000000000000b",
};

describe("Task 2, Test 1: the next open task", () => {
  it("a dated next open task reads `Next due {Mon D}` when nothing is due or overdue", () => {
    const state = ready(feed({ due: [], overdue: [], nextOpen: NEXT }));
    expect(state.data.tasks?.rows).toEqual([]);
    expect(state.data.tasks?.nextOpen).toEqual({
      taskId: NEXT.taskId,
      title: NEXT.title,
      meta: "Next due Oct 25",
    });
  });

  it("an undated next open task reads `Most recent open task`", () => {
    const state = ready(feed({ due: [], overdue: [], nextOpen: UNDATED }));
    expect(state.data.tasks?.nextOpen?.meta).toBe("Most recent open task");
  });

  it("is absent whenever any row is due or overdue", () => {
    const withDue = ready(feed({ due: [REVIEW], overdue: [], nextOpen: NEXT }));
    expect(withDue.data.tasks?.nextOpen).toBeNull();
    const withOverdue = ready(
      feed({
        due: [],
        overdue: [
          row({ taskId: "0mfk1a2b3000000000000000c", title: "Late", dueDate: "2026-10-01" }),
        ],
        nextOpen: NEXT,
      }),
    );
    expect(withOverdue.data.tasks?.nextOpen).toBeNull();
  });

  it("an absent nextOpen (an older service) shows no block and is not treated as empty", () => {
    const state = ready(feed({ due: [], overdue: [] }));
    expect(state.data.tasks?.nextOpen).toBeNull();
    expect(state.isEmpty).toBe(false);
  });

  it("shows the year when the next due date is in another year", () => {
    const later = row({
      taskId: "0mfk1a2b3000000000000000d",
      title: "Renew",
      dueDate: "2027-01-05",
    });
    const state = ready(feed({ due: [], overdue: [], nextOpen: later }));
    expect(state.data.tasks?.nextOpen?.meta).toBe("Next due Jan 5, 2027");
  });
});

describe("Task 2, Test 2: the automation line", () => {
  const empty = feed({ due: [], overdue: [] });

  it("no failure and no unknown run", () => {
    expect(ready(empty).data.automation).toEqual({ failure: null, unknownRun: false });
  });

  it("a failure with no success reads the Phase 7 reason", () => {
    const status = {
      ...NO_RUNS,
      lastFailure: failed("run-1", FAILED_AT, "summariser-unconfigured"),
    };
    expect(ready(empty, autoFeed(status)).data.automation).toEqual({
      failure: { endedAt: FAILED_AT, reason: "the summariser isn't set up" },
      unknownRun: false,
    });
  });

  it("a failure newer than the newest success still counts", () => {
    const status = {
      ...NO_RUNS,
      lastSuccess: OK_RUN,
      lastFailure: failed("run-2", FAILED_AT, "all-sources-failed"),
    };
    expect(ready(empty, autoFeed(status)).data.automation?.failure?.reason).toBe(
      "no source could be fetched",
    );
  });

  it("a success newer than the failure leaves no failure line", () => {
    const status = {
      ...NO_RUNS,
      lastSuccess: { ...OK_RUN, endedAt: "2026-10-22T17:00:00Z" },
      lastFailure: failed("run-2", FAILED_AT, "all-sources-failed"),
    };
    expect(ready(empty, autoFeed(status)).data.automation).toEqual({
      failure: null,
      unknownRun: false,
    });
  });

  it("an unknown error code is a failure with the forward-compatible reason, never a remote string", () => {
    const status = {
      ...NO_RUNS,
      lastFailure: failed("run-3", FAILED_AT, "something-new"),
    };
    expect(ready(empty, autoFeed(status)).data.automation?.failure?.reason).toBe(
      "something went wrong",
    );
  });

  it("a latest unknown run is its own line, while it is the newest run", () => {
    const status = { ...NO_RUNS, latestUnknown: { runId: "run-4", startedAt: FAILED_AT } };
    expect(ready(empty, autoFeed(status)).data.automation).toEqual({
      failure: null,
      unknownRun: true,
    });
  });

  it("an unknown run older than a success is not shown", () => {
    const status = {
      ...NO_RUNS,
      lastSuccess: { ...OK_RUN, endedAt: "2026-10-22T17:00:00Z" },
      latestUnknown: { runId: "run-4", startedAt: FAILED_AT },
    };
    expect(ready(empty, autoFeed(status)).data.automation?.unknownRun).toBe(false);
  });

  it("an interrupted run is unknown, never a failure", () => {
    const status = {
      ...NO_RUNS,
      lastFailure: failed("run-5", FAILED_AT, "interrupted"),
    };
    expect(ready(empty, autoFeed(status)).data.automation).toEqual({
      failure: null,
      unknownRun: true,
    });
  });

  it("carries the clock the relative time is read against", () => {
    expect(ready(empty).data.nowMs).toBe(NOW);
  });
});

describe("Task 2, Tests 3 and 4: feed failures and the honest empty rule", () => {
  const empty = feed({ due: [], overdue: [], nextOpen: null });

  it("a failed tasks feed is `null`, never an empty list, while the automation block still maps", () => {
    const state = ready({ settled: true, value: null, fetchedAt: null, failed: true }, AUTO_OK);
    expect(state.data.tasks).toBeNull();
    expect(state.data.automation).toEqual({ failure: null, unknownRun: false });
    expect(state.isEmpty).toBe(false);
    expect(state.freshness).toBe("stale");
    expect(state.partiality.missingSources).toContain("Managed task store");
  });

  it("a failed automation feed is `null` while the tasks still map, and the chip names it", () => {
    const state = ready(feed({ due: [REVIEW], overdue: [] }), autoFeed(null, { failed: true }));
    expect(state.data.automation).toBeNull();
    expect(state.data.tasks?.rows).toHaveLength(1);
    expect(state.isEmpty).toBe(false);
    expect(state.partiality.missingSources).toContain("Automation runs");
  });

  it("both feeds failing while connected is the frame error, never unavailable", () => {
    const state = todayStateFor(
      both(
        { settled: true, value: null, fetchedAt: null, failed: true },
        autoFeed(null, { failed: true }),
      ),
      LIVE,
      NOW,
      ZONE,
    );
    expect(state.kind).toBe("error");
  });

  it("stays loading until both feeds have answered once", () => {
    const state = todayStateFor(
      both(feed({ due: [REVIEW], overdue: [] }), UNSETTLED_AUTO),
      LIVE,
      NOW,
      ZONE,
    );
    expect(state).toEqual({ kind: "loading" });
  });

  it("is empty only when both feeds succeeded and there is nothing to show", () => {
    expect(ready(empty).isEmpty).toBe(true);
  });

  it("is not empty with a next open task, a due row, a failure or an unknown run", () => {
    expect(ready(feed({ due: [], overdue: [], nextOpen: NEXT })).isEmpty).toBe(false);
    expect(ready(feed({ due: [REVIEW], overdue: [], nextOpen: null })).isEmpty).toBe(false);
    const failing = {
      ...NO_RUNS,
      lastFailure: failed("run-1", FAILED_AT, "all-sources-failed"),
    };
    expect(ready(empty, autoFeed(failing)).isEmpty).toBe(false);
    const unknown = { ...NO_RUNS, latestUnknown: { runId: "run-4", startedAt: FAILED_AT } };
    expect(ready(empty, autoFeed(unknown)).isEmpty).toBe(false);
  });

  it("an older service that sends no nextOpen is not empty, however clean the rest", () => {
    expect(ready(feed({ due: [], overdue: [] })).isEmpty).toBe(false);
  });

  it("a failed refresh of a feed that once answered empty is not empty", () => {
    expect(ready({ ...empty, failed: true }).isEmpty).toBe(false);
  });
});

describe("Task 2, Test 5 (honesty): no state holds a false calendar line", () => {
  it("no Today data mentions the calendar-empty, commitments or scheduled-or-due phrases", () => {
    const states = [
      ready(feed({ due: [], overdue: [], nextOpen: null })),
      ready(feed({ due: [REVIEW], overdue: [], nextOpen: NEXT })),
      ready({ settled: true, value: null, fetchedAt: null, failed: true }),
    ];
    for (const state of states) {
      const text = JSON.stringify(state.data);
      expect(text).not.toContain("Nothing else on the calendar today.");
      expect(text).not.toContain("commitments unavailable");
      expect(text).not.toContain("Nothing is scheduled or due today.");
    }
  });
});

describe("Task 2: the automation feed and the triggers (Test 6)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    nowTick.value = NOW;
  });

  function wire() {
    const status = vi.fn(() => Promise.resolve(NO_RUNS));
    const api: ResearchApi = {
      run: () => Promise.reject(new Error("unused")),
      status,
      list: () => Promise.reject(new Error("unused")),
      report: () => Promise.reject(new Error("unused")),
    };
    configureResearch({
      api,
      notify: () => undefined,
      openNote: () => false,
      copyText: () => false,
      requestRunNow: () => undefined,
    });
    const tasks = fakeTasksApi([], {
      dueToday: vi.fn(() => Promise.resolve({ due: [], overdue: [] })),
    });
    configureTasksApi(tasks);
    return { status, dueToday: tasks.dueToday };
  }

  it("stores the status answer with its fetch time, and a failure keeps the last good one", async () => {
    const { status } = wire();
    await refreshAutomation();
    expect(automationFeed.value).toEqual({
      settled: true,
      value: NO_RUNS,
      fetchedAt: NOW,
      failed: false,
    });
    status.mockImplementation(() => Promise.reject(new Error("down")));
    await refreshAutomation();
    expect(automationFeed.value).toMatchObject({ failed: true, value: NO_RUNS, fetchedAt: NOW });
  });

  it("going live refreshes both feeds; tasks.changed refreshes only the task feed; a tick refreshes both", () => {
    const { status, dueToday } = wire();
    const stop = startOverviewFeeds();
    connectionState.value = LIVE;
    expect([dueToday.mock.calls.length, status.mock.calls.length]).toEqual([1, 1]);

    tasksGeneration.value = 3;
    expect([dueToday.mock.calls.length, status.mock.calls.length]).toEqual([2, 1]);

    vi.setSystemTime(NOW + 60_000);
    refreshOnTick();
    expect([dueToday.mock.calls.length, status.mock.calls.length]).toEqual([3, 2]);
    stop();
  });

  it("never refreshes twice within a minute without a trigger", () => {
    const { status, dueToday } = wire();
    connectionState.value = LIVE;
    const stop = startOverviewFeeds();
    for (let seconds = 1; seconds < 45; seconds += 4) {
      vi.setSystemTime(NOW + seconds * 1000);
      refreshOnTick();
    }
    expect([dueToday.mock.calls.length, status.mock.calls.length]).toEqual([1, 1]);
    stop();
  });

  it("an unconfigured research API leaves the automation feed failed and the card never ready alone", async () => {
    await refreshAutomation();
    expect(automationFeed.value).toMatchObject({ settled: true, value: null, failed: true });
  });
});

describe("FIX3A MAJOR-2: the latest-report feed never refreshes on the tick (the service's list does sync vault I/O)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    nowTick.value = NOW;
  });

  function wire() {
    const list = vi.fn(() => Promise.resolve(listOf([reportRow(0)])));
    const status = vi.fn(() => Promise.resolve(NO_RUNS));
    configureResearch({
      api: fakeResearchApi({ list, status }),
      notify: () => undefined,
      openNote: () => false,
      copyText: () => false,
      requestRunNow: () => undefined,
    });
    const tasks = fakeTasksApi([], {
      dueToday: vi.fn(() => Promise.resolve({ due: [], overdue: [] })),
    });
    configureTasksApi(tasks);
    return { list, status, dueToday: tasks.dueToday };
  }

  it("mount while live and going live fetch the list once each; N ticks fetch it zero more times", () => {
    const { list, status, dueToday } = wire();
    connectionState.value = LIVE;
    const stop = startOverviewFeeds();
    expect(list).toHaveBeenCalledTimes(1);
    for (let minute = 1; minute <= 10; minute += 1) {
      vi.setSystemTime(NOW + minute * 60_000);
      refreshOnTick();
    }
    expect(list).toHaveBeenCalledTimes(1);
    // The other two feeds are still tick-refreshed (10 ticks plus the mount).
    expect(status).toHaveBeenCalledTimes(11);
    expect(dueToday).toHaveBeenCalledTimes(11);

    connectionState.value = { kind: "disconnected", reason: "x" };
    connectionState.value = LIVE;
    expect(list).toHaveBeenCalledTimes(2);
    stop();
  });

  it("a research.updated epoch bump while live fetches the list exactly once", () => {
    const { list } = wire();
    connectionState.value = LIVE;
    const stop = startOverviewFeeds();
    expect(list).toHaveBeenCalledTimes(1);
    overviewResearchEpoch.value = overviewResearchEpoch.peek() + 1;
    expect(list).toHaveBeenCalledTimes(2);
    vi.setSystemTime(NOW + 120_000);
    refreshOnTick();
    expect(list).toHaveBeenCalledTimes(2);
    stop();
  });

  it("the source of refreshOnTick names no report refresh", () => {
    const text = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "overview-feeds.ts"),
      "utf8",
    );
    const start = text.indexOf("export function refreshOnTick");
    const body = text.slice(start, text.indexOf("\n}\n", start));
    expect(body).not.toContain("refreshLatestReport");
    expect(body).not.toContain("refreshNow");
    expect(body).not.toContain("refreshOverviewFeeds");
  });
});

describe("Task 3: Today's partiality says what is not part of this version", () => {
  const SUMMARY = "Google Calendar and Gmail aren't part of this version";
  const empty = feed({ due: [], overdue: [], nextOpen: null });

  it("always partial; Calendar and Gmail are not in missingSources, they are declared not-in-version", () => {
    const state = ready(empty);
    expect(state.partiality).toEqual({ partial: true, missingSources: [], summary: SUMMARY });
  });

  it("extends the summary with the names of the real feeds that did not respond", () => {
    const tasksDown = ready({ settled: true, value: null, fetchedAt: null, failed: true });
    expect(tasksDown.partiality).toEqual({
      partial: true,
      missingSources: ["Managed task store"],
      summary: `${SUMMARY}; Managed task store didn't respond`,
    });
    const both = ready(
      { settled: true, value: null, fetchedAt: null, failed: true },
      autoFeed(NO_RUNS, { failed: true }),
    );
    expect(both.partiality.summary).toBe(
      `${SUMMARY}; Managed task store and Automation runs didn't respond`,
    );
    expect(both.partiality.missingSources).toEqual(["Managed task store", "Automation runs"]);
  });

  it("is plain and slash-free (PRIV-04)", () => {
    const state = ready(empty, autoFeed(NO_RUNS, { failed: true }));
    expect(state.partiality.summary).not.toMatch(/[\\/]/);
  });
});

// ---------------------------------------------------------------------------
// Plan 08-17, Task 1 (tracer): the latest cited report and the Technology state
// ---------------------------------------------------------------------------

describe("08-17 Task 1: the latest-report feed and the Technology state", () => {
  const T_NOW = RESEARCH_NOW_MS;

  function answer(overrides: Partial<LatestReportAnswer> = {}): LatestReportAnswer {
    return {
      latest: reportRow(0, {
        generatedAt: iso(-180),
        sourceCount: 5,
        sourceTotal: 5,
        itemCount: 12,
      }),
      unreadableCount: 0,
      ...overrides,
    };
  }

  function reportFeed(
    value: LatestReportAnswer | null,
    extra: Partial<FeedSnapshot<LatestReportAnswer>> = {},
  ): FeedSnapshot<LatestReportAnswer> {
    return {
      settled: true,
      value,
      fetchedAt: value === null ? null : T_NOW - 1000,
      failed: false,
      ...extra,
    };
  }

  function readyTech(feedValue: FeedSnapshot<LatestReportAnswer>, connection = LIVE) {
    const state = techIntelStateFor(feedValue, connection, T_NOW);
    if (state.kind !== "ready") throw new Error(`expected ready, got ${state.kind}`);
    return state;
  }

  it("Test 2: tech-intel is not in CONSTANT_STATE_WIDGET_IDS", () => {
    expect(CONSTANT_STATE_WIDGET_IDS.has("tech-intel")).toBe(false);
  });

  it("refreshLatestReport asks for the first page and keeps the first readable row and the unreadable count", async () => {
    const newest = reportRow(0, { title: "Newest" });
    const list = vi.fn(() =>
      Promise.resolve(listOf([unreadableRow("a.md"), newest, reportRow(1), unreadableRow("b.md")])),
    );
    configureResearch({
      api: fakeResearchApi({ list }),
      notify: () => undefined,
      openNote: () => false,
      copyText: () => false,
      requestRunNow: () => undefined,
    });
    await refreshLatestReport();
    expect(list).toHaveBeenCalledExactlyOnceWith(undefined);
    const snapshot = latestReportFeed.value;
    expect(snapshot.settled).toBe(true);
    expect(snapshot.failed).toBe(false);
    expect(snapshot.value?.latest?.title).toBe("Newest");
    expect(snapshot.value?.unreadableCount).toBe(2);
  });

  it("a rejected refresh with nothing before it is failed with no value", async () => {
    await refreshLatestReport();
    expect(latestReportFeed.value).toMatchObject({ settled: true, value: null, failed: true });
  });

  it("is loading before the first answer while connecting, unavailable while disconnected", () => {
    const unsettled: FeedSnapshot<LatestReportAnswer> = {
      settled: false,
      value: null,
      fetchedAt: null,
      failed: false,
    };
    expect(techIntelStateFor(unsettled, { kind: "connecting" }, T_NOW)).toEqual({
      kind: "loading",
    });
    expect(techIntelStateFor(unsettled, { kind: "disconnected", reason: "x" }, T_NOW)).toEqual({
      kind: "unavailable",
    });
  });

  it("Test 1: a report from three hours ago is ready, cached, dated by its own generation time", () => {
    const state = readyTech(reportFeed(answer()));
    expect(state.freshness).toBe("cached");
    expect(state.observedAt).toBe(iso(-180));
    expect(state.isEmpty).toBe(false);
    expect(state.partiality).toEqual({ partial: false });
    expect(state.data.report).toMatchObject({
      noteId: reportRow(0).noteId,
      sourceCount: 5,
      sourceTotal: 5,
      itemCount: 12,
      partial: false,
      stale: false,
    });
  });

  it("Test 3: a report 37 hours old is stale and flagged stale, still readable", () => {
    const old = answer({
      latest: reportRow(0, { generatedAt: new Date(T_NOW - 37 * 3_600_000).toISOString() }),
    });
    const state = readyTech(reportFeed(old));
    expect(state.freshness).toBe("stale");
    expect(state.data.report?.stale).toBe(true);
    expect(state.isEmpty).toBe(false);
  });

  it("is cached just under 36 hours and stale at 36 hours", () => {
    const at = (hours: number, extra = 0) =>
      readyTech(
        reportFeed(
          answer({
            latest: reportRow(0, {
              generatedAt: new Date(T_NOW - hours * 3_600_000 + extra).toISOString(),
            }),
          }),
        ),
      ).freshness;
    expect(at(36, 1)).toBe("cached");
    expect(at(36)).toBe("stale");
  });

  it("never reports live, whatever the age or the connection", () => {
    for (const hours of [0, 1, 35, 36, 200]) {
      for (const connection of [LIVE, { kind: "connecting" } as ConnectionState]) {
        const latest = reportRow(0, {
          generatedAt: new Date(T_NOW - hours * 3_600_000).toISOString(),
        });
        const state = readyTech(reportFeed(answer({ latest })), connection);
        expect(state.freshness).not.toBe("live");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Plan 08-17, Task 2: partial, empty, unreadable, failed refresh, hostile titles
// ---------------------------------------------------------------------------

describe("08-17 Task 2: the Technology state in every case", () => {
  const T_NOW = RESEARCH_NOW_MS;

  function reportFeed(
    value: LatestReportAnswer | null,
    extra: Partial<FeedSnapshot<LatestReportAnswer>> = {},
  ): FeedSnapshot<LatestReportAnswer> {
    return {
      settled: true,
      value,
      fetchedAt: value === null ? null : T_NOW - 1000,
      failed: false,
      ...extra,
    };
  }

  function readyTech(feedValue: FeedSnapshot<LatestReportAnswer>, connection = LIVE) {
    const state = techIntelStateFor(feedValue, connection, T_NOW);
    if (state.kind !== "ready") throw new Error(`expected ready, got ${state.kind}`);
    return state;
  }

  const COMPLETE: LatestReportAnswer = {
    latest: reportRow(0, { generatedAt: iso(-180) }),
    unreadableCount: 0,
  };

  it("Test 1: an empty list is a ready, empty card with no unreadable rows", () => {
    const state = readyTech(reportFeed({ latest: null, unreadableCount: 0 }));
    expect(state.isEmpty).toBe(true);
    expect(state.data).toEqual({ report: null, unreadableCount: 0 });
    expect(state.freshness).not.toBe("live");
    expect(state.observedAt).toBe(new Date(T_NOW - 1000).toISOString());
  });

  it("Test 1: only unreadable rows is an empty card carrying the count", () => {
    const state = readyTech(reportFeed({ latest: null, unreadableCount: 3 }));
    expect(state.isEmpty).toBe(true);
    expect(state.data).toEqual({ report: null, unreadableCount: 3 });
  });

  it("Test 2: a partial report is partial, names Research sources, and summarises {u} of {m}", () => {
    const partial = reportRow(0, {
      generatedAt: iso(-60),
      partial: true,
      sourceCount: 5,
      sourceTotal: 6,
      unavailableCount: 1,
    });
    const state = readyTech(reportFeed({ latest: partial, unreadableCount: 0 }));
    expect(state.partiality).toEqual({
      partial: true,
      missingSources: ["Research sources"],
      summary: "1 of 6 research sources were unavailable",
    });
    expect(state.data.report?.partial).toBe(true);
    expect(state.partiality.summary).not.toMatch(/[\\/]/);
  });

  it("Test 2: a partial row with no unavailable count falls back to total minus contributed", () => {
    const partial = reportRow(0, {
      partial: true,
      sourceCount: 4,
      sourceTotal: 6,
      unavailableCount: 0,
    });
    const state = readyTech(reportFeed({ latest: partial, unreadableCount: 0 }));
    expect(state.partiality.summary).toBe("2 of 6 research sources were unavailable");
  });

  it("Test 3: a rejected first load is the frame error while connected, unavailable while disconnected, loading while connecting", () => {
    const failedFirst = reportFeed(null, { failed: true });
    expect(techIntelStateFor(failedFirst, LIVE, T_NOW)).toEqual({
      kind: "error",
      message: "Couldn't load technology and market intelligence.",
    });
    expect(techIntelStateFor(failedFirst, { kind: "disconnected", reason: "x" }, T_NOW)).toEqual({
      kind: "unavailable",
    });
    expect(techIntelStateFor(failedFirst, { kind: "connecting" }, T_NOW)).toEqual({
      kind: "loading",
    });
  });

  it("a failed refresh keeps the last report and names Research reports as not responding", () => {
    const state = readyTech(reportFeed(COMPLETE, { failed: true }));
    expect(state.data.report?.noteId).toBe(COMPLETE.latest?.noteId);
    expect(state.partiality).toEqual({
      partial: true,
      missingSources: ["Research reports"],
      summary: "Research reports didn't respond",
    });
    expect(state.freshness).not.toBe("live");
  });

  it("a failed refresh of a partial report names both", () => {
    const partial = reportRow(0, {
      partial: true,
      sourceCount: 5,
      sourceTotal: 6,
      unavailableCount: 1,
    });
    const state = readyTech(reportFeed({ latest: partial, unreadableCount: 0 }, { failed: true }));
    expect(state.partiality).toEqual({
      partial: true,
      missingSources: ["Research reports", "Research sources"],
      summary: "Research reports didn't respond; 1 of 6 research sources were unavailable",
    });
  });

  it("a failed refresh after an empty answer stays empty but is partial, not a clean empty", () => {
    const state = readyTech(reportFeed({ latest: null, unreadableCount: 0 }, { failed: true }));
    expect(state.isEmpty).toBe(true);
    expect(state.partiality.partial).toBe(true);
    expect(state.partiality.missingSources).toEqual(["Research reports"]);
  });

  it("Test 4: a hostile title is made safe before it reaches the card: bidi and control characters become visible tokens", () => {
    const hostile = reportRow(0, {
      title: "invoice‮gpj.exe [a](https://example.invalid) <img src=x>",
    });
    const state = readyTech(reportFeed({ latest: hostile, unreadableCount: 0 }));
    const title = state.data.report?.title ?? "";
    expect(title).not.toContain("‮");
    expect(title).toContain("[U+202E]");
    // Markup stays as literal text; the renderer, not the mapping, is what keeps it inert.
    expect(title).toContain("[a](https://example.invalid)");
  });

  it("is plain data: no link, no href, no markup is built from a report", () => {
    const state = readyTech(reportFeed(COMPLETE));
    expect(JSON.stringify(state.data)).not.toMatch(/href|<a |<img/i);
  });
});
