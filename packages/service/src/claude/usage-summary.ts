import {
  CAPACITY_WINDOWS,
  type CapacityWindow,
  type EstimatedApiCost,
  type Freshness,
  type IntegrationInstallState,
  type PlanCapacity,
  type TokenActivity,
  USAGE_RANGES,
  type UsageRangeKind,
  type UsageSummary,
} from "@ccc/domain";
import {
  type CostSnapshot,
  latestCapacity,
  latestRunBySession,
  listCostSnapshots,
} from "@ccc/operational-store";
import type Database from "better-sqlite3";

/**
 * The one `UsageSummary` builder (PR-23, D-37..D-45). Three concepts are
 * computed separately, each with its own source, range and freshness:
 * - plan capacity, from the latest status-line windows (D-43);
 * - token activity, from local transcript aggregates (D-40, Task 2);
 * - estimated API-equivalent cost, from status-line snapshots where they
 *   cover a whole session inside the range, else list prices (D-42).
 * Unavailable is a variant with a reason and never a number (D-38,
 * USAGE-06). Pure over the store: every clock and time zone is an argument.
 */

/** What the service remembers about status-line reports since it started (in memory only). */
export interface StatusLineObservation {
  /** The newest valid snapshot's `observedAt`, or null before the first. */
  readonly lastValidAt: string | null;
  /** Whether that newest valid snapshot carried any rate-limit window. */
  readonly lastHadLimits: boolean;
  /**
   * When a snapshot last failed its schema, or null. Cleared by the next
   * valid snapshot, so non-null means the newest report was invalid.
   */
  readonly lastInvalidAt: string | null;
  /** The version that snapshot named, when it named one that looks like a version. */
  readonly lastInvalidVersion: string | null;
}

export const EMPTY_STATUS_LINE_OBSERVATION: StatusLineObservation = Object.freeze({
  lastValidAt: null,
  lastHadLimits: false,
  lastInvalidAt: null,
  lastInvalidVersion: null,
});

/** A value observed this recently is `live` (the 10-minute rule, ADR-0002). */
export const LIVE_WINDOW_MS = 10 * 60 * 1000;
/** Older than live but this recent is `cached`; older still is `stale`. */
export const CACHED_WINDOW_MS = 6 * 60 * 60 * 1000;

/** ADR-0002 freshness from an observation's age. A future observation counts as live. */
export function freshnessAt(observedAt: string, now: Date): Exclude<Freshness, "unavailable"> {
  const age = now.getTime() - Date.parse(observedAt);
  if (age <= LIVE_WINDOW_MS) return "live";
  if (age <= CACHED_WINDOW_MS) return "cached";
  return "stale";
}

const FRESHNESS_ORDER: readonly Exclude<Freshness, "unavailable">[] = ["live", "cached", "stale"];

/** The less fresh of two freshness values. */
export function worseFreshness(
  a: Exclude<Freshness, "unavailable">,
  b: Exclude<Freshness, "unavailable">,
): Exclude<Freshness, "unavailable"> {
  return FRESHNESS_ORDER.indexOf(a) >= FRESHNESS_ORDER.indexOf(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Local-time calendar arithmetic (D-45). No date library: Intl gives the
// wall-clock parts of an instant in a zone, and the zone offset follows.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
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

function wallClock(ms: number, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 1970,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** The zone's offset from UTC at `ms`, in milliseconds (east positive). */
function offsetAt(ms: number, timeZone: string): number {
  const wall = wallClock(ms, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** The local calendar date (YYYY-MM-DD) of an instant in `timeZone`. */
export function localDayOf(instant: string | number, timeZone: string): string {
  const ms = typeof instant === "number" ? instant : Date.parse(instant);
  const wall = wallClock(ms, timeZone);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** `day` moved by `delta` calendar days. */
export function addDays(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const moved = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + delta));
  return moved.toISOString().slice(0, 10);
}

/** The instant local midnight begins `day` in `timeZone` (DST-safe to one correction). */
export function localMidnight(day: string, timeZone: string): number {
  const [year, month, date] = day.split("-").map(Number);
  const guess = Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1);
  let result = guess - offsetAt(guess, timeZone);
  const corrected = guess - offsetAt(result, timeZone);
  if (corrected !== result) result = corrected;
  return result;
}

/** A summary range's stated bounds and its calendar days (D-45). */
export interface RangeBounds {
  /** Local midnight of the first day, as an ISO instant. */
  readonly start: string;
  /** The observation time: the range runs "– now". */
  readonly end: string;
  readonly firstDay: string;
  readonly lastDay: string;
  /** The exclusive UTC hour-bucket bound covering `end` (the store queries [start, queryEnd)). */
  readonly queryEnd: string;
}

const HOUR_MS = 3_600_000;

/**
 * Today since local midnight, the last seven local days including today,
 * and the calendar month so far, all in `timeZone` (D-45).
 */
export function rangeBounds(kind: UsageRangeKind, now: Date, timeZone: string): RangeBounds {
  const today = localDayOf(now.getTime(), timeZone);
  let firstDay: string;
  switch (kind) {
    case "today":
      firstDay = today;
      break;
    case "last-7-days":
      firstDay = addDays(today, -6);
      break;
    case "this-month":
      firstDay = `${today.slice(0, 8)}01`;
      break;
  }
  const startMs = Math.min(localMidnight(firstDay, timeZone), now.getTime());
  const queryEndMs = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS;
  return {
    start: new Date(startMs).toISOString(),
    end: now.toISOString(),
    firstDay,
    lastDay: today,
    queryEnd: new Date(queryEndMs).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Plan capacity (D-37, D-38, D-43)

export interface PlanCapacityInputs {
  readonly db: Database.Database;
  /** Whether the status-line wrapper is in the owner's Claude settings (PR-24). */
  readonly statusLineInstall: IntegrationInstallState;
  readonly observation: StatusLineObservation;
  readonly now: Date;
}

function isCapacityWindow(value: string): value is CapacityWindow {
  return (CAPACITY_WINDOWS as readonly string[]).includes(value);
}

function newer(a: string | null, b: string | null): boolean {
  if (a === null) return false;
  if (b === null) return true;
  return Date.parse(a) > Date.parse(b);
}

/**
 * Plan capacity: the latest observation per window, or an unavailable
 * reason. The reasons, in order:
 * 1. the newest status-line report failed its schema → `shape-changed`;
 * 2. the newest valid report carried no rate limits (and is no older than
 *    the stored windows) → `sign-in-no-limits`;
 * 3. stored windows exist → available;
 * 4. the wrapper is not installed → `wrapper-not-installed`;
 * 5. otherwise → `no-report-yet` (an unreadable settings file included:
 *    the service cannot claim the wrapper is absent).
 */
export function buildPlanCapacity(inputs: PlanCapacityInputs): PlanCapacity {
  const { observation, now } = inputs;
  if (observation.lastInvalidAt !== null) {
    return {
      kind: "unavailable",
      reason: "shape-changed",
      version: observation.lastInvalidVersion,
    };
  }
  const windows = latestCapacity(inputs.db).flatMap((row) =>
    isCapacityWindow(row.window) && row.resetsAt !== null
      ? [
          {
            window: row.window,
            usedPercent: Math.min(100, Math.max(0, row.usedPercent)),
            resetsAt: row.resetsAt,
            observedAt: row.observedAt,
          },
        ]
      : [],
  );
  const newestWindowAt = windows.reduce<string | null>(
    (newest, w) => (newer(w.observedAt, newest) ? w.observedAt : newest),
    null,
  );
  if (
    observation.lastValidAt !== null &&
    !observation.lastHadLimits &&
    !newer(newestWindowAt, observation.lastValidAt)
  ) {
    return { kind: "unavailable", reason: "sign-in-no-limits", version: null };
  }
  if (newestWindowAt !== null) {
    return {
      kind: "available",
      windows: windows.map(({ window, usedPercent, resetsAt }) => ({
        window,
        usedPercent,
        resetsAt,
      })),
      observedAt: newestWindowAt,
      source: "claude-code-status-line",
      freshness: freshnessAt(newestWindowAt, now),
      partiality: { partial: false },
    };
  }
  if (inputs.statusLineInstall === "not-installed") {
    return { kind: "unavailable", reason: "wrapper-not-installed", version: null };
  }
  return { kind: "unavailable", reason: "no-report-yet", version: null };
}

// ---------------------------------------------------------------------------
// Estimated cost (D-42)

/**
 * A session's lifetime for the cost basis rule: from its Run's start (or
 * the first snapshot, when no Run is known) to its end (or the latest
 * snapshot).
 */
function sessionLifetime(
  db: Database.Database,
  snapshot: CostSnapshot,
): { start: number; end: number } {
  const run = latestRunBySession(db, snapshot.claudeSessionId);
  const first = Date.parse(snapshot.firstObservedAt);
  const last = Date.parse(snapshot.observedAt);
  const runStart = run === null ? first : Date.parse(run.startedAt);
  const runEnd = run !== null && run.endedAt !== null ? Date.parse(run.endedAt) : last;
  return { start: Math.min(first, runStart), end: Math.max(last, runEnd) };
}

/**
 * The snapshots whose session lies wholly inside [start, end]: only these
 * may stand for their session's cost in the range (D-42, T-05-53). A
 * session straddling the range start would otherwise charge the whole
 * session to the range.
 */
export function snapshotsCovering(
  db: Database.Database,
  bounds: Pick<RangeBounds, "start" | "end">,
): CostSnapshot[] {
  const start = Date.parse(bounds.start);
  const end = Date.parse(bounds.end);
  return listCostSnapshots(db).filter((snapshot) => {
    const lifetime = sessionLifetime(db, snapshot);
    return lifetime.start >= start && lifetime.end <= end;
  });
}

const TRANSCRIPT_SOURCE = "local-transcript-analysis";

/**
 * The cost for one range. With token activity unavailable, only the status
 * line's own estimates can speak, and the result is partial (sessions
 * without a snapshot are unknown). Task 2 adds list prices over activity.
 */
export function buildRangeCost(
  db: Database.Database,
  kind: UsageRangeKind,
  bounds: RangeBounds,
  activity: TokenActivity,
  now: Date,
): EstimatedApiCost {
  const covered = snapshotsCovering(db, bounds);
  if (covered.length === 0 || activity.kind === "available") {
    return { kind: "unavailable", reason: "needs-activity-or-wrapper" };
  }
  const observedAt = covered.reduce(
    (latest, s) => (newer(s.observedAt, latest) ? s.observedAt : latest),
    covered[0]?.observedAt ?? now.toISOString(),
  );
  return {
    kind: "available",
    range: kind,
    bounds: { start: bounds.start, end: bounds.end },
    usd: covered.reduce((sum, s) => sum + s.totalCostUsd, 0),
    basis: "claude-code-estimates",
    priceTableDate: null,
    excludedModelCount: 0,
    observedAt,
    source: "claude-code-estimates-and-list-prices",
    freshness: freshnessAt(observedAt, now),
    partiality: { partial: true, missingSources: [TRANSCRIPT_SOURCE] },
  };
}

// ---------------------------------------------------------------------------
// The summary

export interface AnalysisState {
  readonly enabled: boolean;
  readonly firstScanPending: boolean;
}

export interface UsageSummaryInputs extends PlanCapacityInputs {
  readonly analysis: AnalysisState;
  readonly timeZone: string;
}

function rangeActivity(analysis: AnalysisState): TokenActivity {
  return analysis.enabled
    ? { kind: "unavailable", reason: "no-coverage", version: null }
    : { kind: "unavailable", reason: "analysis-off", version: null };
}

/** The whole summary published by `usage.updated` and `snapshot.state.usage`. */
export function buildUsageSummary(inputs: UsageSummaryInputs): UsageSummary {
  const { db, now, timeZone, analysis } = inputs;
  const range = (kind: UsageRangeKind) => {
    const bounds = rangeBounds(kind, now, timeZone);
    const activity = rangeActivity(analysis);
    return { activity, cost: buildRangeCost(db, kind, bounds, activity, now) };
  };
  const [today, last7, month] = USAGE_RANGES.map(range);
  if (today === undefined || last7 === undefined || month === undefined) {
    throw new Error("USAGE_RANGES must name three ranges");
  }
  return {
    capacity: buildPlanCapacity(inputs),
    ranges: { today, "last-7-days": last7, "this-month": month },
    analysis: { enabled: analysis.enabled, firstScanPending: analysis.firstScanPending },
    observedAt: now.toISOString(),
  };
}
