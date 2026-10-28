import { reportFreshness } from "@ccc/domain/research.js";
import type { ResearchListRow, ResearchStatusResponse } from "@ccc/domain/research-routes.js";
import { isValidZone, resolvedZone } from "@ccc/domain/task-time.js";
import type { TaskDueTodayResponse } from "@ccc/domain/tasks.js";
import { computed, effect, signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { type ConnectionState, connectionState } from "../connection-state.js";
import { researchApi } from "../research/api.js";
import { overviewResearchEpoch } from "../research/events.js";
import { tasksApi } from "../tasks/api.js";
import { tasksGeneration } from "../tasks/events.js";
import { failureCopy, isFailureCode } from "../view/research-copy.js";
import { safeLine } from "../view/research-format.js";
import { nowTick } from "../widgets/clock.js";
import type { WidgetState } from "../widgets/contract.js";
import type { TechIntelData, TodayAutomation, TodayData } from "../widgets/panels.js";
import { ms, nextOpenMeta, ranked, rowMeta, todayTask } from "./overview-format.js";
import { superseding } from "./superseding.js";

/**
 * The Overview's own feeds (plan 08-14; research B 2.4 and 2.6, D-20, D-21).
 *
 * The Today card reads two service routes the Overview used to leave alone:
 * the due-today route (due, overdue and the next open task) and the research
 * status route (automation failures). This module owns their
 * fetching, the last good answer of each and the pure mapping from both to a
 * `WidgetState<TodayData>`.
 *
 * Reads go through the existing `tasksApi()` / `researchApi()` holders, so
 * this file imports no client, no fixture, no harness module and no JSON. It
 * deliberately does NOT reuse the Research view's own `researchStatus` signal:
 * that one is reset when the last Research view unmounts (research B Pitfall
 * 5), and the Overview must keep its last good answer while no view is open.
 *
 * Nothing here awaits during render. The Overview reads one computed signal
 * synchronously (PERF-02, PERF-03); a request that never answers leaves the
 * card `loading` and delays nothing else.
 */

/** What one feed currently knows. */
export interface FeedSnapshot<T> {
  /** True once at least one attempt has finished, whatever its outcome. */
  readonly settled: boolean;
  /** The last answer that arrived. Kept when a later refresh fails, so a stale view stays readable. */
  readonly value: T | null;
  /** When `value` arrived (epoch ms), or `null` when none has. */
  readonly fetchedAt: number | null;
  /** True when the most recent attempt failed. */
  readonly failed: boolean;
}

const NEVER: FeedSnapshot<never> = { settled: false, value: null, fetchedAt: null, failed: false };

/** Due, overdue and the next open task, from `POST /tasks/due-today`. */
export const dueTodayFeed = signal<FeedSnapshot<TaskDueTodayResponse>>(NEVER);

/** The latest research run outcomes, from `POST /research/status`. */
export const automationFeed = signal<FeedSnapshot<ResearchStatusResponse>>(NEVER);

type ReadableReportRow = Extract<ResearchListRow, { readable: true }>;

/**
 * What the Technology card needs from the report list (plan 08-17, D-19): the
 * newest readable row of the first page, and how many rows of that page could
 * not be read. Both are `null`/zero for an empty list, which is a real answer
 * ("no reports yet"), never a failure.
 */
export interface LatestReportAnswer {
  readonly latest: ReadableReportRow | null;
  readonly unreadableCount: number;
}

/** The report list's first page, reduced to {@link LatestReportAnswer}, from `POST /research/list`. */
export const latestReportFeed = signal<FeedSnapshot<LatestReportAnswer>>(NEVER);

// ---------------------------------------------------------------------------
// Time zone seam

let zoneOverride: string | null = null;

/**
 * Pins the zone the due-today request and the row dates use (tests, and a
 * future zone setting). `null` restores the runtime's own zone. An invalid
 * zone is ignored rather than stored, because the route refuses it.
 */
export function configureOverviewZone(zone: string | null): void {
  zoneOverride = zone !== null && isValidZone(zone) ? zone : null;
}

function currentZone(): string {
  return zoneOverride ?? resolvedZone();
}

// ---------------------------------------------------------------------------
// Fetching

/** When a trigger last refreshed the feeds (epoch ms), for the tick gap rule. */
let lastRefreshAt = 0;

/**
 * Asks the service for the due-today feed. A later call supersedes an earlier
 * one still in flight (sequence token), so a slow answer can never overwrite a
 * newer one. A failure keeps the last good value and marks the feed failed.
 */
const dueToday = superseding(dueTodayFeed, () => tasksApi().dueToday({ zone: currentZone() }));

export function refreshDueToday(): Promise<void> {
  return dueToday.refresh();
}

/** Asks the service for the research status. Same contract as {@link refreshDueToday}. */
const automation = superseding(automationFeed, () => researchApi().status());

export function refreshAutomation(): Promise<void> {
  return automation.refresh();
}

/**
 * Asks the service for the first page of the report list and keeps the newest
 * readable row. Same contract as {@link refreshDueToday}: a later call
 * supersedes an earlier one in flight, and a failure keeps the last good value.
 * It reads through the `researchApi()` holder, never the Research view's own
 * `reportRows` signal, which is reset when the last Research view unmounts.
 */
const latestReport = superseding(latestReportFeed, async (): Promise<LatestReportAnswer> => {
  const page = await researchApi().list(undefined);
  return {
    latest: page.rows.find((row): row is ReadableReportRow => row.readable) ?? null,
    unreadableCount: page.rows.filter((row) => !row.readable).length,
  };
});

export function refreshLatestReport(): Promise<void> {
  return latestReport.refresh();
}

/** Refreshes every Overview feed. */
export function refreshOverviewFeeds(): void {
  void refreshDueToday();
  void refreshAutomation();
  void refreshLatestReport();
}

/** Clears every feed and invalidates answers still in flight (tests, and unload). */
export function resetOverviewFeeds(): void {
  dueToday.invalidate();
  automation.invalidate();
  latestReport.invalidate();
  dueTodayFeed.value = NEVER;
  automationFeed.value = NEVER;
  latestReportFeed.value = NEVER;
  lastRefreshAt = 0;
}

// ---------------------------------------------------------------------------
// Triggers

/**
 * The shortest gap between two tick-driven refreshes. The shared clock ticks
 * every 60 seconds; a refresh that a trigger (mount, going live, a task
 * change) already made less than this long ago is not repeated on the tick, so
 * the feeds are fetched at most once per tick and never twice in quick
 * succession without a trigger.
 */
export const TICK_REFRESH_MIN_GAP_MS = 45_000;

function refreshNow(): void {
  lastRefreshAt = Date.now();
  refreshOverviewFeeds();
}

const isLive = computed(() => connectionState.value.kind === "live");

/**
 * Starts the event-driven triggers and returns the function that stops them.
 * `isLive` and the task generation are read inside an `effect`, never in a
 * component render, so a change re-runs these effects and re-renders no card.
 *
 * - On start, and whenever the connection becomes live again: refresh.
 * - When `tasks.changed` advances the generation while live: refresh the
 *   due-today feed only (a task change says nothing about research runs).
 * - When a `research.updated` event advances the research epoch while live:
 *   refresh the automation and report feeds (plan 08-17).
 */
export function startOverviewFeeds(): () => void {
  let seenGeneration = tasksGeneration.peek();
  const stopLive = effect(() => {
    if (isLive.value) refreshNow();
  });
  // A `research.updated` event refreshes the research feeds even when no Research view is open
  // (research B 2.6). A task change says nothing about research, and a research event says
  // nothing about tasks, so each trigger refreshes only what it concerns.
  let seenEpoch = overviewResearchEpoch.peek();
  const stopEpoch = effect(() => {
    const epoch = overviewResearchEpoch.value;
    if (epoch === seenEpoch) return;
    seenEpoch = epoch;
    if (isLive.peek()) {
      lastRefreshAt = Date.now();
      void refreshAutomation();
      void refreshLatestReport();
    }
  });
  const stopGeneration = effect(() => {
    const generation = tasksGeneration.value;
    if (generation === seenGeneration) return;
    seenGeneration = generation;
    if (isLive.peek()) {
      lastRefreshAt = Date.now();
      void refreshDueToday();
    }
  });
  return () => {
    stopLive();
    stopEpoch();
    stopGeneration();
  };
}

/**
 * The tick trigger: refresh while live, at most once per shared 60-second tick.
 *
 * The due-today and automation feeds ride the tick. The latest-report feed does NOT (FIX3A
 * MAJOR-2): the service's report list does synchronous vault I/O (it opens report notes, which can
 * force iCloud downloads), so it is fetched only on mount, on going live and on a
 * `research.updated` epoch bump, never on a timer.
 */
export function refreshOnTick(): void {
  if (!isLive.peek()) return;
  if (Date.now() - lastRefreshAt < TICK_REFRESH_MIN_GAP_MS) return;
  lastRefreshAt = Date.now();
  void refreshDueToday();
  void refreshAutomation();
}

/**
 * Keeps the Overview's feeds current while it is mounted: the event-driven
 * triggers start on mount and stop on unmount, and each change of the shared
 * minute clock (`now`) is one tick. No timer of its own and no `main.ts`
 * wiring: the clock is the one the footers already use.
 */
export function useOverviewFeeds(now: number): void {
  useEffect(() => startOverviewFeeds(), []);
  // The first run is the mount itself; the trigger above has just refreshed, so the gap rule skips it.
  useEffect(() => refreshOnTick(), [now]);
}

// ---------------------------------------------------------------------------
// The Today mapping

/** Fetched within this long ago counts as current while connected: two ticks of the shared clock. */
export const LIVE_WINDOW_MS = 120_000;

const SOURCE_TASKS = "Managed task store";

/** What `todayStateFor` reads. */
export interface TodayFeeds {
  readonly tasks: FeedSnapshot<TaskDueTodayResponse>;
  readonly automation: FeedSnapshot<ResearchStatusResponse>;
}

/**
 * Maps the research status to the card's automation block (UI-SPEC S6).
 *
 * A failure shows only while it is newer than the newest success, so the count
 * is 0 or 1 and the copy is singular by construction. `interrupted` is not a
 * failure: it is a run that ended without reporting, as is a stale in-flight
 * run (`latestUnknown`); either shows as the unknown-run line, and only while
 * it is the newest run. The same rules as the Research view's own status
 * section (`view/research-status.tsx`), read from the same record.
 */
function automationOf(status: ResearchStatusResponse): TodayAutomation {
  const recorded = status.lastFailure;
  const failure = recorded !== null && isFailureCode(recorded.errorCode) ? recorded : null;
  const successAt = status.lastSuccess === null ? null : ms(status.lastSuccess.endedAt);

  const failureShows = failure !== null && (successAt === null || ms(failure.endedAt) > successAt);

  const unknownCandidates: string[] = [];
  if (status.latestUnknown !== null) unknownCandidates.push(status.latestUnknown.startedAt);
  if (recorded !== null && !isFailureCode(recorded.errorCode)) {
    unknownCandidates.push(recorded.endedAt);
  }
  let unknownRun = false;
  if (unknownCandidates.length > 0) {
    const newest = Math.max(...unknownCandidates.map(ms));
    unknownRun =
      (successAt === null || newest > successAt) &&
      (failure === null || newest > ms(failure.endedAt)) &&
      (status.inFlight === null || ms(status.inFlight.startedAt) <= newest);
  }

  return {
    failure: failureShows
      ? { endedAt: failure.endedAt, reason: failureCopy(failure.errorCode).reason ?? "" }
      : null,
    unknownRun,
  };
}

const SOURCE_AUTOMATION = "Automation runs";

/**
 * The Partial chip's description (UI-SPEC R-12): Calendar and Gmail are not
 * part of this version (declared on the widget's data keys, never listed as
 * missing), extended with the real feeds that did not respond.
 */
const NOT_IN_VERSION_SUMMARY = "Google Calendar and Gmail aren't part of this version";

function partialSummary(failed: readonly string[]): string {
  return failed.length === 0
    ? NOT_IN_VERSION_SUMMARY
    : `${NOT_IN_VERSION_SUMMARY}; ${failed.join(" and ")} didn't respond`;
}

/**
 * The Today card's state (research B 2.4), a pure function of the feeds, the
 * connection and the clock.
 *
 * - Either feed has not answered yet: `loading` while connecting or live,
 *   `unavailable` while disconnected (the frame turns that into
 *   `disconnected`). Both requests start together, so this is brief.
 * - Both feeds answered and neither ever held a value, while connected: `error`,
 *   never `unavailable`.
 * - Otherwise `ready`, always partial (Calendar and Gmail are not part of this
 *   version), dated by the newest fetch. A feed that failed keeps its last good
 *   value when it has one, otherwise its block is `null` and reads
 *   unavailable, never empty and never zero. `live` only while connected, no
 *   feed failed and the oldest answer is within {@link LIVE_WINDOW_MS}.
 * - `isEmpty` only when both feeds succeeded and there is no due row, no
 *   overdue row, no next open task (an absent one is unknown, not none), no
 *   failure and no unknown run (UI-SPEC R-13).
 */
export function todayStateFor(
  feeds: TodayFeeds,
  connection: ConnectionState,
  nowMs: number,
  zone: string = currentZone(),
): WidgetState<TodayData> {
  const { tasks, automation } = feeds;
  const settled = tasks.settled && automation.settled;
  if (!settled) {
    return connection.kind === "disconnected" ? { kind: "unavailable" } : { kind: "loading" };
  }
  if (tasks.value === null && automation.value === null) {
    return connection.kind === "live"
      ? { kind: "error", message: "Couldn't load today." }
      : connection.kind === "disconnected"
        ? { kind: "unavailable" }
        : { kind: "loading" };
  }

  const response = tasks.value;
  let taskBlock: TodayData["tasks"] = null;
  if (response !== null) {
    const overdue = ranked(response.overdue, zone).map((row) =>
      todayTask({ row, meta: rowMeta(row, "overdue", nowMs, zone) }),
    );
    // A task overdue and also scheduled today comes back in both arrays; show it
    // once, as overdue, so it neither repeats nor spends two rows of the budget.
    const overdueIds = new Set(response.overdue.map((row) => row.taskId));
    const due = ranked(
      response.due.filter((row) => !overdueIds.has(row.taskId)),
      zone,
    ).map((row) => todayTask({ row, meta: rowMeta(row, "due", nowMs, zone) }));
    const rows = [...overdue, ...due];
    const next = response.nextOpen;
    taskBlock = {
      rows,
      nextOpen:
        rows.length === 0 && next !== undefined && next !== null
          ? todayTask({ row: next, meta: nextOpenMeta(next, nowMs, zone) })
          : null,
    };
  }
  const automationBlock = automation.value === null ? null : automationOf(automation.value);

  const answered = [tasks, automation].filter((entry) => entry.value !== null);
  const fetchedTimes = answered.map((entry) => entry.fetchedAt ?? nowMs);
  const anyFailed = tasks.failed || automation.failed;
  const fresh =
    connection.kind === "live" &&
    !anyFailed &&
    fetchedTimes.every((at) => nowMs - at <= LIVE_WINDOW_MS);
  const failedSources = [
    ...(tasks.failed ? [SOURCE_TASKS] : []),
    ...(automation.failed ? [SOURCE_AUTOMATION] : []),
  ];

  const isEmpty =
    !anyFailed &&
    response !== null &&
    response.due.length === 0 &&
    response.overdue.length === 0 &&
    response.nextOpen === null &&
    automationBlock !== null &&
    automationBlock.failure === null &&
    !automationBlock.unknownRun;

  return {
    kind: "ready",
    data: { tasks: taskBlock, automation: automationBlock, nowMs },
    observedAt: new Date(Math.max(...fetchedTimes)).toISOString(),
    freshness: fresh ? "live" : "stale",
    partiality: {
      partial: true,
      missingSources: failedSources,
      summary: partialSummary(failedSources),
    },
    isEmpty,
  };
}

/** The Today card's live signal: replaces the permission-required constant in `widget-data.ts`. */
export const todayState = computed<WidgetState<TodayData>>(() =>
  todayStateFor(
    { tasks: dueTodayFeed.value, automation: automationFeed.value },
    connectionState.value,
    nowTick.value,
  ),
);

// ---------------------------------------------------------------------------
// The Technology and market intelligence mapping (plan 08-17, D-19)

const SOURCE_REPORTS = "Research reports";
const SOURCE_RESEARCH = "Research sources";

/**
 * How many of the run's sources did not contribute. The row's own count wins; a
 * partial row that carries none falls back to the difference of its totals.
 */
function unavailableSources(row: ReadableReportRow): number {
  return row.unavailableCount > 0
    ? row.unavailableCount
    : Math.max(0, row.sourceTotal - row.sourceCount);
}

/**
 * The Technology card's state (UI-SPEC S7), a pure function of the report feed,
 * the connection and the clock.
 *
 * - No answer yet: `loading` while connecting or live, `unavailable` while
 *   disconnected (the frame turns that into `disconnected`).
 * - Answered but never held a value, while connected: `error`.
 * - Otherwise `ready`, dated by the report's own generation time. A report is a
 *   stored artifact, so freshness is `cached` or `stale` (36 hours) from
 *   `reportFreshness` and never `live` (UI-SPEC R-14). An empty list is a real
 *   answer (`isEmpty`), and so is a page of only unreadable rows.
 * - Partial when the report itself is (`Research sources` did not all respond)
 *   and/or when the last refresh failed and the card shows the last good answer
 *   (`Research reports` did not respond). The chip summary says which.
 * - The title is neutralised here too (`safeLine`): the service already did it,
 *   and a response that reached the plugin without it still cannot reorder or
 *   hide anything.
 */
export function techIntelStateFor(
  feed: FeedSnapshot<LatestReportAnswer>,
  connection: ConnectionState,
  nowMs: number,
): WidgetState<TechIntelData> {
  if (!feed.settled) {
    return connection.kind === "disconnected" ? { kind: "unavailable" } : { kind: "loading" };
  }
  const answer = feed.value;
  if (answer === null) {
    return connection.kind === "live"
      ? { kind: "error", message: "Couldn't load technology and market intelligence." }
      : connection.kind === "disconnected"
        ? { kind: "unavailable" }
        : { kind: "loading" };
  }
  const latest = answer.latest;
  const freshness = latest === null ? "cached" : reportFreshness(latest.generatedAt, nowMs);
  const unavailable = latest?.partial ? unavailableSources(latest) : 0;

  const missingSources: string[] = [];
  const parts: string[] = [];
  if (feed.failed) {
    missingSources.push(SOURCE_REPORTS);
    parts.push(`${SOURCE_REPORTS} didn't respond`);
  }
  if (latest?.partial) {
    missingSources.push(SOURCE_RESEARCH);
    parts.push(
      unavailable > 0
        ? `${unavailable} of ${latest.sourceTotal} research sources were unavailable`
        : "Some research sources were unavailable",
    );
  }

  return {
    kind: "ready",
    data: {
      report:
        latest === null
          ? null
          : {
              noteId: latest.noteId,
              title: safeLine(latest.title),
              generatedAt: latest.generatedAt,
              partial: latest.partial,
              sourceCount: latest.sourceCount,
              sourceTotal: latest.sourceTotal,
              itemCount: latest.itemCount,
              unavailableCount: unavailable,
              stale: freshness === "stale",
            },
      unreadableCount: answer.unreadableCount,
    },
    observedAt:
      latest === null ? new Date(feed.fetchedAt ?? nowMs).toISOString() : latest.generatedAt,
    freshness,
    partiality:
      parts.length === 0
        ? { partial: false }
        : { partial: true, missingSources, summary: parts.join("; ") },
    isEmpty: latest === null,
  };
}

/** The Technology card's live signal: replaces the `unavailable` constant in `widget-data.ts`. */
export const techIntelState = computed<WidgetState<TechIntelData>>(() =>
  techIntelStateFor(latestReportFeed.value, connectionState.value, nowTick.value),
);
