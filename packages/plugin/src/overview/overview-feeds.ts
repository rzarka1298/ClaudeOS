import { isValidZone, resolvedZone, zonedLocalToInstant } from "@ccc/domain/task-time.js";
import type { TaskDueTodayResponse, TaskDueTodayRow } from "@ccc/domain/tasks.js";
import { computed, effect, signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { type ConnectionState, connectionState } from "../connection-state.js";
import { tasksApi } from "../tasks/api.js";
import { tasksGeneration } from "../tasks/events.js";
import { nowTick } from "../widgets/clock.js";
import type { WidgetState } from "../widgets/contract.js";
import type { TodayData, TodayTask } from "../widgets/panels.js";

/**
 * The Overview's own feeds (plan 08-14; research B 2.4 and 2.6, D-20, D-21).
 *
 * The Today card reads two service routes the Overview used to leave alone:
 * the due-today route (due, overdue and the next open task) and, from task 2,
 * the research status route (automation failures). This module owns their
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

let dueSeq = 0;

/** When a trigger last refreshed the feeds (epoch ms), for the tick gap rule. */
let lastRefreshAt = 0;

/**
 * Asks the service for the due-today feed. A later call supersedes an earlier
 * one still in flight (sequence token), so a slow answer can never overwrite a
 * newer one. A failure keeps the last good value and marks the feed failed.
 */
export async function refreshDueToday(): Promise<void> {
  const seq = ++dueSeq;
  let answer: TaskDueTodayResponse | null = null;
  try {
    answer = await tasksApi().dueToday({ zone: currentZone() });
  } catch {
    answer = null;
  }
  if (seq !== dueSeq) return;
  const previous = dueTodayFeed.peek();
  dueTodayFeed.value =
    answer === null
      ? { ...previous, settled: true, failed: true }
      : { settled: true, value: answer, fetchedAt: Date.now(), failed: false };
}

/** Refreshes every Overview feed. */
export function refreshOverviewFeeds(): void {
  void refreshDueToday();
}

/** Clears every feed and invalidates answers still in flight (tests, and unload). */
export function resetOverviewFeeds(): void {
  dueSeq += 1;
  dueTodayFeed.value = NEVER;
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
 */
export function startOverviewFeeds(): () => void {
  let seenGeneration = tasksGeneration.peek();
  const stopLive = effect(() => {
    if (isLive.value) refreshNow();
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
    stopGeneration();
  };
}

/** The tick trigger: refresh while live, at most once per shared 60-second tick. */
export function refreshOnTick(): void {
  if (!isLive.peek()) return;
  if (Date.now() - lastRefreshAt < TICK_REFRESH_MIN_GAP_MS) return;
  refreshNow();
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

/** The text a formatter would otherwise print when a value cannot be parsed. */
const NO_DATE = "No date";

const formatters = new Map<string, Intl.DateTimeFormat>();
const FORMATTER_CACHE_LIMIT = 32;

function formatter(key: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  const cached = formatters.get(key);
  if (cached !== undefined) return cached;
  const created = make();
  if (formatters.size >= FORMATTER_CACHE_LIMIT) formatters.clear();
  formatters.set(key, created);
  return created;
}

/** `YYYY-MM-DD` of an instant on the wall clock of `zone`. */
function localDate(ms: number, zone: string): string {
  const parts = formatter(
    `date|${zone}`,
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        calendar: "gregory",
        numberingSystem: "latn",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
  ).formatToParts(new Date(ms));
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** `Oct 5`, or `Oct 5, 2027` when the year is not the current one. */
function monthDay(date: Date, zone: string, withYear: boolean): string {
  return formatter(
    `month-day|${zone}|${withYear}`,
    () =>
      new Intl.DateTimeFormat("en", {
        timeZone: zone,
        month: "short",
        day: "numeric",
        ...(withYear ? { year: "numeric" } : {}),
      }),
  ).format(date);
}

/** `5:00 PM`, with any no-break space the locale data uses made an ordinary space. */
function timeOfDay(date: Date, zone: string): string {
  return formatter(
    `time|${zone}`,
    () => new Intl.DateTimeFormat("en", { timeZone: zone, hour: "numeric", minute: "2-digit" }),
  )
    .format(date)
    .replace(/\s+/g, " ");
}

/**
 * A due or scheduled value as the card sees it: a calendar date (which no
 * zone can move) or an instant.
 */
type Moment =
  | { readonly kind: "date"; readonly date: string }
  | { readonly kind: "instant"; readonly ms: number };

function momentOf(date: string | undefined, instant: string | undefined): Moment | null {
  if (date !== undefined) return { kind: "date", date };
  if (instant !== undefined) {
    const ms = Date.parse(instant);
    if (!Number.isNaN(ms)) return { kind: "instant", ms };
  }
  return null;
}

function dueMoment(row: TaskDueTodayRow): Moment | null {
  return momentOf(row.dueDate, row.dueAt);
}

function scheduledMoment(row: TaskDueTodayRow): Moment | null {
  return momentOf(row.scheduledDate, row.scheduledAt);
}

/** `Oct 22` of a moment; a date is a calendar date and is never shifted by the zone. */
function dayLabel(moment: Moment, nowMs: number, zone: string): string {
  const currentYear = Number(localDate(nowMs, zone).slice(0, 4));
  if (moment.kind === "date") {
    const withYear = Number(moment.date.slice(0, 4)) !== currentYear;
    return monthDay(new Date(`${moment.date}T00:00:00Z`), "UTC", withYear);
  }
  const withYear = Number(localDate(moment.ms, zone).slice(0, 4)) !== currentYear;
  return monthDay(new Date(moment.ms), zone, withYear);
}

/** `5:00 PM` for an instant, `Oct 22` for a date. */
function dueLabel(moment: Moment, nowMs: number, zone: string): string {
  return moment.kind === "instant"
    ? timeOfDay(new Date(moment.ms), zone)
    : dayLabel(moment, nowMs, zone);
}

/**
 * The row's meta line: `Due 5:00 PM` or `Due Oct 22` for a due-today row,
 * `Overdue since Oct 18` for an overdue one (the word `Overdue` is always
 * present, UI-SPEC S6). A row that is only scheduled says `Scheduled …`, never
 * `Due`, because the due-today route also returns tasks scheduled for today.
 */
function rowMeta(
  row: TaskDueTodayRow,
  kind: "due" | "overdue",
  nowMs: number,
  zone: string,
): string {
  const due = dueMoment(row);
  if (kind === "overdue") {
    return due === null ? "Overdue" : `Overdue since ${dayLabel(due, nowMs, zone)}`;
  }
  if (due !== null) return `Due ${dueLabel(due, nowMs, zone)}`;
  const scheduled = scheduledMoment(row);
  if (scheduled !== null) return `Scheduled ${dueLabel(scheduled, nowMs, zone)}`;
  return NO_DATE;
}

/** The label of the next open task: `Next due Oct 22`, or `Most recent open task` when it has no due value. */
function nextOpenMeta(row: TaskDueTodayRow, nowMs: number, zone: string): string {
  const due = dueMoment(row);
  return due === null ? "Most recent open task" : `Next due ${dayLabel(due, nowMs, zone)}`;
}

/**
 * The instant a row is due, for ordering what the card shows. A calendar date
 * is the start of that day in the owner's zone; the service ranks dates and
 * instants with one text key (`due_sort`), which compares a UTC instant with a
 * local date as text and can put a task up to a day out of order when the two
 * kinds meet (FIX1A). Ordering the displayed rows here makes the card's own
 * order exact whatever the service sent. Unknown values sort last.
 */
function rankOf(row: TaskDueTodayRow, zone: string): number {
  const moment = dueMoment(row) ?? scheduledMoment(row);
  if (moment === null) return Number.POSITIVE_INFINITY;
  if (moment.kind === "instant") return moment.ms;
  const start = zonedLocalToInstant(moment.date, "00:00", zone);
  return start === null ? Number.POSITIVE_INFINITY : Date.parse(start);
}

/** A stable sort by {@link rankOf}; equal ranks keep the service's order. */
function ranked(rows: readonly TaskDueTodayRow[], zone: string): readonly TaskDueTodayRow[] {
  return rows
    .map((row, index) => ({ row, index, rank: rankOf(row, zone) }))
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank < b.rank ? -1 : 1))
    .map((entry) => entry.row);
}

function todayTask(row: TodayRowInput): TodayTask {
  return { taskId: row.row.taskId, title: row.row.title, meta: row.meta };
}

interface TodayRowInput {
  readonly row: TaskDueTodayRow;
  readonly meta: string;
}

/** What `todayStateFor` reads. */
export interface TodayFeeds {
  readonly tasks: FeedSnapshot<TaskDueTodayResponse>;
}

/**
 * The Today card's state (research B 2.4), a pure function of the feeds, the
 * connection and the clock.
 *
 * - Nothing fetched yet: `loading` while connecting or live, `unavailable` while
 *   disconnected (the frame turns that into `disconnected`).
 * - Every feed failed while connected: `error`, never `unavailable`.
 * - Otherwise `ready`, always partial (Calendar and Gmail are not part of this
 *   version), dated by the newest fetch; `live` only while connected, every
 *   feed answered and the oldest answer is within {@link LIVE_WINDOW_MS}.
 */
export function todayStateFor(
  feeds: TodayFeeds,
  connection: ConnectionState,
  nowMs: number,
  zone: string = currentZone(),
): WidgetState<TodayData> {
  const { tasks } = feeds;
  if (tasks.value === null) {
    if (tasks.settled && connection.kind === "live") {
      return { kind: "error", message: "Couldn't load today." };
    }
    return connection.kind === "disconnected" ? { kind: "unavailable" } : { kind: "loading" };
  }

  const response = tasks.value;
  const overdue = ranked(response.overdue, zone).map((row) =>
    todayTask({ row, meta: rowMeta(row, "overdue", nowMs, zone) }),
  );
  const due = ranked(response.due, zone).map((row) =>
    todayTask({ row, meta: rowMeta(row, "due", nowMs, zone) }),
  );
  const rows = [...overdue, ...due];
  const nextOpen =
    rows.length === 0 && response.nextOpen !== undefined && response.nextOpen !== null
      ? todayTask({
          row: response.nextOpen,
          meta: nextOpenMeta(response.nextOpen, nowMs, zone),
        })
      : null;

  const fetchedAt = tasks.fetchedAt ?? nowMs;
  const fresh = connection.kind === "live" && !tasks.failed && nowMs - fetchedAt <= LIVE_WINDOW_MS;
  const missingSources = tasks.failed ? [SOURCE_TASKS] : [];

  return {
    kind: "ready",
    data: { tasks: { rows, nextOpen } },
    observedAt: new Date(fetchedAt).toISOString(),
    freshness: fresh ? "live" : "stale",
    partiality: { partial: true, missingSources: ["Google Calendar", "Gmail", ...missingSources] },
    isEmpty: false,
  };
}

/** The Today card's live signal: replaces the permission-required constant in `widget-data.ts`. */
export const todayState = computed<WidgetState<TodayData>>(() =>
  todayStateFor({ tasks: dueTodayFeed.value }, connectionState.value, nowTick.value),
);
