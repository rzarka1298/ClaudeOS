import type { TaskRow } from "@ccc/domain/tasks.js";

/**
 * The date phrase of a task row (UI-SPEC "List rows", "Number and time
 * formatting", D-33): `Due today`, `Due Oct 5`, `Due Oct 5, 3:00 PM`,
 * `Scheduled Oct 6`, `Overdue — due Oct 2`.
 *
 * Pure functions of an explicit `nowMs` and an IANA zone, never of the machine
 * clock or zone, so a unit test and a screenshot do not depend on when or where
 * they ran. `Intl` only, no date library, and no output ever contains a `/`
 * (the no-slash rule for Source panels). A date-only value is a calendar date,
 * not an instant: it is formatted as that date in UTC so no zone can move it,
 * and it never shows a time.
 */

export interface TaskDatePhrase {
  readonly text: string;
  /** True for the overdue phrase, which the row renders in weight 600 through a data hook. */
  readonly overdue: boolean;
}

/** A value the index kept apart: a calendar date, or an instant. */
type DateValue =
  | { readonly kind: "date"; readonly date: string }
  | { readonly kind: "instant"; readonly ms: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
const FORMATTER_CACHE_LIMIT = 64;

function formatter(key: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  const cached = formatters.get(key);
  if (cached !== undefined) return cached;
  const created = make();
  if (formatters.size >= FORMATTER_CACHE_LIMIT) formatters.clear();
  formatters.set(key, created);
  return created;
}

/** The zone itself, or UTC when the runtime does not know it. The caller validates; this never throws. */
function usableZone(zone: string): string {
  try {
    formatter(`probe|${zone}`, () => new Intl.DateTimeFormat("en", { timeZone: zone }));
    return zone;
  } catch {
    return "UTC";
  }
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

/** `Oct 5`, or `Oct 5, 2027` when `withYear`. */
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

/** `3:00 PM`, with any no-break space the locale data uses made an ordinary space. */
function timeOfDay(date: Date, zone: string): string {
  return formatter(
    `time|${zone}`,
    () => new Intl.DateTimeFormat("en", { timeZone: zone, hour: "numeric", minute: "2-digit" }),
  )
    .format(date)
    .replace(/\s+/g, " ");
}

function dayLabel(value: DateValue, zone: string, currentYear: number): string {
  if (value.kind === "date") {
    const withYear = Number(value.date.slice(0, 4)) !== currentYear;
    return monthDay(new Date(`${value.date}T00:00:00Z`), "UTC", withYear);
  }
  const withYear = Number(localDate(value.ms, zone).slice(0, 4)) !== currentYear;
  return monthDay(new Date(value.ms), zone, withYear);
}

function fullLabel(value: DateValue, zone: string, currentYear: number): string {
  const day = dayLabel(value, zone, currentYear);
  return value.kind === "date" ? day : `${day}, ${timeOfDay(new Date(value.ms), zone)}`;
}

function dateValue(date: string | undefined, instant: string | undefined): DateValue | null {
  if (date !== undefined) return { kind: "date", date };
  if (instant !== undefined) {
    const ms = Date.parse(instant);
    if (!Number.isNaN(ms)) return { kind: "instant", ms };
  }
  return null;
}

/**
 * The one date phrase of a row, or `null` when it has neither a due nor a
 * scheduled value. A due value wins over a scheduled one. `row.overdue` is the
 * service's own verdict (open and due before the start of the local day), so a
 * finished task with a past due date is not called overdue.
 */
export function formatTaskDatePhrase(
  row: TaskRow,
  nowMs: number,
  zone: string,
): TaskDatePhrase | null {
  const tz = usableZone(zone);
  const today = localDate(nowMs, tz);
  const currentYear = Number(today.slice(0, 4));

  const due = dateValue(row.dueDate, row.dueAt);
  if (due !== null) {
    if (row.overdue) {
      return { text: `Overdue — due ${dayLabel(due, tz, currentYear)}`, overdue: true };
    }
    if (due.kind === "date" && due.date === today) return { text: "Due today", overdue: false };
    return { text: `Due ${fullLabel(due, tz, currentYear)}`, overdue: false };
  }

  const scheduled = dateValue(row.scheduledDate, row.scheduledAt);
  if (scheduled !== null) {
    return { text: `Scheduled ${fullLabel(scheduled, tz, currentYear)}`, overdue: false };
  }
  return null;
}
