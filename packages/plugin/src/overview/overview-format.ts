import { zonedLocalToInstant } from "@ccc/domain/task-time.js";
import type { TaskDueTodayRow } from "@ccc/domain/tasks.js";
import type { TodayTask } from "../widgets/panels.js";

/**
 * The Overview's date, zone and ranking helpers (09-06, D-13). Moved out of overview-feeds.ts
 * unchanged so that file is about feeds, triggers and widget state: the cached `Intl` formatters,
 * the moment and label functions, the row meta lines and the display ranking. Used only by
 * overview-feeds.ts; nothing outside this folder imports it.
 */

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
export function rowMeta(
  row: TaskDueTodayRow,
  kind: "due" | "overdue",
  nowMs: number,
  zone: string,
): string {
  const due = dueMoment(row);
  if (kind === "overdue") {
    return due === null ? "Overdue" : `Overdue since ${dayLabel(due, nowMs, zone)}`;
  }
  // The due-today route also returns rows scheduled today whose deadline is
  // later: only a deadline that falls today reads `Due 5:00 PM`; otherwise the
  // row shows today's scheduled time, or the deadline's own date.
  if (due !== null && isToday(due, nowMs, zone)) return `Due ${dueLabel(due, nowMs, zone)}`;
  const scheduled = scheduledMoment(row);
  if (scheduled !== null) return `Scheduled ${dueLabel(scheduled, nowMs, zone)}`;
  if (due !== null) return `Due ${dayLabel(due, nowMs, zone)}`;
  return NO_DATE;
}

/** Whether a moment falls on today's calendar date in `zone`. */
function isToday(moment: Moment, nowMs: number, zone: string): boolean {
  const today = localDate(nowMs, zone);
  return moment.kind === "date" ? moment.date === today : localDate(moment.ms, zone) === today;
}

/** The label of the next open task: `Next due Oct 22`, or `Most recent open task` when it has no due value. */
export function nextOpenMeta(row: TaskDueTodayRow, nowMs: number, zone: string): string {
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
export function ranked(rows: readonly TaskDueTodayRow[], zone: string): readonly TaskDueTodayRow[] {
  return rows
    .map((row, index) => ({ row, index, rank: rankOf(row, zone) }))
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank < b.rank ? -1 : 1))
    .map((entry) => entry.row);
}

export function todayTask(row: TodayRowInput): TodayTask {
  return { taskId: row.row.taskId, title: row.row.title, meta: row.meta };
}

export interface TodayRowInput {
  readonly row: TaskDueTodayRow;
  readonly meta: string;
}

export function ms(iso: string): number {
  return Date.parse(iso);
}
