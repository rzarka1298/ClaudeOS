// Schedule windows in an IANA zone, computed with Intl only (plan 07-05, D-19,
// research R5). Node 24 has no Temporal, so the local date of an instant and
// the instant of a local wall time are derived from `Intl.DateTimeFormat`
// offsets. Nothing here reads the machine zone or the clock: every function
// takes the instant and the zone as arguments.
//
// The window of an occurrence is the LOCAL DATE it belongs to. A DST change can
// therefore never open two windows for one date (both 01:30s of a fall-back day
// map to the same date), and a skipped day (Pacific/Apia, 2011-12-30) maps to
// the day after it.
//
// This file is pure and Node-free.

const HOUR_MS = 3_600_000;
/** Probe distance either side of a wall time: wider than any real offset change plus the offset itself. */
const PROBE_MS = 26 * HOUR_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();
const FORMATTER_CAP = 64;

function formatterFor(zone: string): Intl.DateTimeFormat {
  const cached = formatters.get(zone);
  if (cached !== undefined) return cached;
  // Throws RangeError for a zone Intl does not know.
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  if (formatters.size >= FORMATTER_CAP) formatters.clear();
  formatters.set(zone, created);
  return created;
}

interface WallParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function wallPartsOf(ms: number, zone: string): WallParts {
  if (!Number.isFinite(ms)) throw new RangeError("instant must be a finite number");
  const out: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  const { year, month, day, hour, minute, second } = out;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    [year, month, day, hour, minute, second].some((n) => !Number.isInteger(n))
  ) {
    throw new RangeError("could not read the local time in that zone");
  }
  return { year, month, day, hour, minute, second };
}

/** The local wall time as if it were UTC, in milliseconds. */
function wallAsUtcMs(parts: WallParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** The zone's offset from UTC in milliseconds at an instant (whole seconds). */
function offsetAt(ms: number, zone: string): number {
  const wholeSeconds = Math.floor(ms / 1000) * 1000;
  return wallAsUtcMs(wallPartsOf(wholeSeconds, zone)) - wholeSeconds;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/**
 * True when Intl accepts the zone, with `UTC` allowed explicitly (Intl's
 * supported-values list omits it). A string that only differs from a zone's
 * canonical spelling by case, and an offset string such as `+01:00`, are
 * refused, so one zone has one spelling inside a key. Never throws.
 */
export function isValidTimeZone(zone: string): boolean {
  if (typeof zone !== "string" || zone.length === 0) return false;
  if (zone === "UTC") return true;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions()
      .timeZone;
    if (typeof resolved !== "string") return false;
    if (resolved.includes(":") || resolved.startsWith("+") || resolved.startsWith("-")) {
      return false;
    }
    if (zone !== resolved && zone.toLowerCase() === resolved.toLowerCase()) return false;
    return true;
  } catch {
    return false;
  }
}

function requireZone(zone: string): void {
  if (!isValidTimeZone(zone)) throw new RangeError("not a valid time zone");
}

/** The local date (`YYYY-MM-DD`) of an instant in a zone. Throws RangeError for a bad zone or instant. */
export function windowDate(ms: number, zone: string): string {
  requireZone(zone);
  const { year, month, day } = wallPartsOf(ms, zone);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * The instant of a local wall time in a zone, in milliseconds.
 *
 * - An ordinary time resolves to its one instant.
 * - A fall-back overlap (the wall time happens twice) resolves to the FIRST
 *   occurrence.
 * - A spring-forward gap (the wall time never happens) moves forward by the
 *   gap, so 02:30 on a skipped hour becomes 03:30.
 *
 * Throws RangeError for a bad zone or an impossible wall time.
 */
export function wallToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
): number {
  requireZone(zone);
  for (const n of [year, month, day, hour, minute]) {
    if (!Number.isInteger(n)) throw new RangeError("wall time parts must be integers");
  }
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  const roundTrip = new Date(wall);
  if (
    year < 1000 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new RangeError("not a calendar wall time");
  }

  const offsetBefore = offsetAt(wall - PROBE_MS, zone);
  const offsetAfter = offsetAt(wall + PROBE_MS, zone);
  const valid: number[] = [];
  for (const offset of new Set([offsetBefore, offsetAfter])) {
    const candidate = wall - offset;
    if (candidate + offsetAt(candidate, zone) === wall) valid.push(candidate);
  }
  if (valid.length > 0) return Math.min(...valid);
  // A gap: the wall time never happened. The offset in force before the gap
  // carries it forward by the gap's length.
  return wall - offsetBefore;
}
