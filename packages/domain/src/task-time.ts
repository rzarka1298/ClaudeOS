import { TaskDateSchema } from "./task-schema.js";

/**
 * Local-day bounds, due-date normalisation and zone conversion for tasks (plan
 * 06-05; D-33, research Pattern 12, spike S10).
 *
 * `Intl` only: no date library and no Node module, so this file is reachable
 * from the plugin's browser bundle. Nothing here reads the clock or the machine
 * zone: callers pass `now` and an IANA zone (the request carries the zone,
 * because a long-lived service cannot assume its own default stays current when
 * the owner travels, assumption A6).
 *
 * A day is not always 24 hours and does not always start at midnight: a
 * spring-forward day is 23 hours, a fall-back day is 25, and in a few zones the
 * clock skips local midnight (America/Sao_Paulo on 2018-11-04 starts the day at
 * 01:00). The functions below find real instants, so none of that is assumed.
 */

const SECOND_MS = 1000;
const HOUR_MS = 3_600_000;

/** A conservative shape for an IANA zone name; Intl then decides whether it exists. */
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

const formatters = new Map<string, Intl.DateTimeFormat>();
const FORMATTER_CACHE_LIMIT = 64;

/** True when `zone` names a zone this runtime knows. Never throws. Offset strings such as `+05:00` are not zones. */
export function isValidZone(zone: string): boolean {
  if (typeof zone !== "string" || !ZONE_SHAPE.test(zone)) return false;
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

/** The runtime's own zone: the callers' default when a request carries none. Falls back to UTC. */
export function resolvedZone(): string {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidZone(zone) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

function formatterFor(zone: string): Intl.DateTimeFormat {
  const cached = formatters.get(zone);
  if (cached !== undefined) return cached;
  // Intl throws a RangeError for an unknown zone, which is what callers see.
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    calendar: "gregory",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  if (formatters.size >= FORMATTER_CACHE_LIMIT) formatters.clear();
  formatters.set(zone, formatter);
  return formatter;
}

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function wallClock(zone: string, ms: number): WallClock {
  const values: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? Number.NaN,
    month: values.month ?? Number.NaN,
    day: values.day ?? Number.NaN,
    hour: values.hour ?? Number.NaN,
    minute: values.minute ?? Number.NaN,
    second: values.second ?? Number.NaN,
  };
}

/** The zone's offset from UTC at an instant, in milliseconds, at whole-second resolution. */
function offsetAt(zone: string, ms: number): number {
  const wall = wallClock(zone, ms);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(ms / SECOND_MS) * SECOND_MS;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function dateKey(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function localDateAt(zone: string, ms: number): string {
  const wall = wallClock(zone, ms);
  return dateKey(wall.year, wall.month, wall.day);
}

/**
 * The first whole second whose local date is `year-month-day` or later. For a
 * normal day that is local midnight; where the clock skips midnight it is the
 * first valid time of the day. A binary search over the window in which every
 * zone's day must begin (offsets run from UTC-12 to UTC+14), so it needs no
 * assumption about transitions.
 */
function firstInstantOfLocalDate(zone: string, year: number, month: number, day: number): number {
  const key = dateKey(year, month, day);
  const midnightUtc = Date.UTC(year, month - 1, day);
  let lo = midnightUtc - 15 * HOUR_MS; // local date is earlier than `key`
  let hi = midnightUtc + 13 * HOUR_MS; // local date is `key` or later
  while (hi - lo > SECOND_MS) {
    const mid = lo + Math.floor((hi - lo) / (2 * SECOND_MS)) * SECOND_MS;
    if (localDateAt(zone, mid) >= key) hi = mid;
    else lo = mid;
  }
  return hi;
}

export interface LocalDayBounds {
  /** The local calendar date of `now` in the zone, `YYYY-MM-DD`. */
  readonly localDate: string;
  /** The UTC instant the local day starts, an ISO string. Inclusive. */
  readonly startsAt: string;
  /** The UTC instant the next local day starts, an ISO string. Exclusive. */
  readonly endsAt: string;
}

/**
 * The local date and the UTC bounds of the local day that contains `now`, in an
 * IANA zone. Computed ONCE per request by the caller, so a list and the counts
 * for the same request can never disagree about where today ends (D-33). The
 * day is 23 hours on a spring-forward day, 25 on a fall-back day, and starts
 * when the zone's day really starts.
 *
 * @throws RangeError for an unknown zone or an invalid date. Callers validate
 * the zone with {@link isValidZone} first and answer a bad request themselves.
 */
export function localDayBounds(now: Date, zone: string): LocalDayBounds {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError("localDayBounds needs a valid date");
  }
  if (!isValidZone(zone)) {
    throw new RangeError("localDayBounds needs a known time zone");
  }
  const today = wallClock(zone, now.getTime());
  const start = firstInstantOfLocalDate(zone, today.year, today.month, today.day);
  const nextDay = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  const end = firstInstantOfLocalDate(
    zone,
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
  );
  return {
    localDate: dateKey(today.year, today.month, today.day),
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
  };
}

export interface NormalisedDue {
  /** Set for an all-day value, otherwise null. */
  readonly date: string | null;
  /** Set for an instant (UTC ISO), otherwise null. */
  readonly instant: string | null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Splits a task's `due` or `scheduled` value into two mutually exclusive
 * columns: a calendar date (all-day, never given a time, never moved by a
 * later time-zone change) or a UTC instant. The authored string stays in the
 * note; this is only what the index stores. Returns null for anything that is
 * neither a calendar date nor an offset instant.
 */
export function normaliseDue(value: string): NormalisedDue | null {
  if (!TaskDateSchema.safeParse(value).success) return null;
  if (DATE_ONLY.test(value)) return { date: value, instant: null };
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return { date: null, instant: new Date(ms).toISOString() };
}

/**
 * The sort key of a due value: the calendar date itself, or the UTC instant.
 * Compared as strings, a date-only value sorts before any instant on the same
 * day, which is the intended order. Null for an invalid value.
 */
export function dueSortKey(value: string): string | null {
  const normalised = normaliseDue(value);
  if (normalised === null) return null;
  return normalised.date ?? normalised.instant;
}

const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/** `+HH:MM` or `-HH:MM`, or `Z` for a zero offset. Null when the offset has a sub-minute part. */
function offsetSuffix(offsetMs: number): string | null {
  if (offsetMs === 0) return "Z";
  if (offsetMs % (60 * SECOND_MS) !== 0) return null;
  const sign = offsetMs < 0 ? "-" : "+";
  const minutes = Math.abs(offsetMs) / (60 * SECOND_MS);
  return `${sign}${pad(Math.floor(minutes / 60), 2)}:${pad(minutes % 60, 2)}`;
}

/** An instant written as the zone's wall clock plus its numeric offset. */
function formatInZone(zone: string, ms: number): string {
  const whole = Math.floor(ms / SECOND_MS) * SECOND_MS;
  const offset = offsetAt(zone, whole);
  const suffix = offsetSuffix(offset);
  if (suffix === null) return `${new Date(whole).toISOString().slice(0, 19)}Z`;
  return `${new Date(whole + offset).toISOString().slice(0, 19)}${suffix}`;
}

/**
 * Turns a form's local date and time in an IANA zone into an offset instant
 * string such as `2026-10-05T15:00:00-04:00`, which the task schema accepts.
 *
 * - A time that does not exist (inside a spring-forward gap) moves forward to
 *   the first valid instant after the gap.
 * - A time that happens twice (the fall-back overlap) takes its first occurrence.
 *
 * Returns null for an invalid date, an invalid time (`HH:MM` or `HH:MM:SS`) or
 * an unknown zone. Never reads the machine zone.
 */
export function zonedLocalToInstant(date: string, time: string, zone: string): string | null {
  if (!isValidZone(zone) || !DATE_ONLY.test(date)) return null;
  const parts = LOCAL_TIME.exec(time);
  if (parts === null) return null;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    return null;
  }
  const wall = Date.UTC(
    year,
    month - 1,
    day,
    Number(parts[1]),
    Number(parts[2]),
    Number(parts[3] ?? "0"),
  );

  // An offset is right for this wall time when the instant it implies really has that offset.
  const before = offsetAt(zone, wall - 36 * HOUR_MS);
  const after = offsetAt(zone, wall + 36 * HOUR_MS);
  const valid = [...new Set([before, after])]
    .map((offset) => ({ offset, instant: wall - offset }))
    .filter(({ offset, instant }) => offsetAt(zone, instant) === offset)
    .map(({ instant }) => instant);
  if (valid.length > 0) return formatInZone(zone, Math.min(...valid));

  // No offset fits: the wall time falls in a gap. Find the transition and use it.
  let hi = wall - before;
  if (offsetAt(zone, hi) === before) return null;
  let lo = hi - 25 * HOUR_MS;
  if (offsetAt(zone, lo) !== before) return null;
  while (hi - lo > SECOND_MS) {
    const mid = lo + Math.floor((hi - lo) / (2 * SECOND_MS)) * SECOND_MS;
    if (offsetAt(zone, mid) === before) lo = mid;
    else hi = mid;
  }
  return formatInZone(zone, hi);
}
