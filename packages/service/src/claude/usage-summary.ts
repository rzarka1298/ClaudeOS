import {
  estimateCostUsd,
  PRICE_TABLE_EFFECTIVE_FROM,
  type RecognitionVerdict,
} from "@ccc/collectors";
import {
  CAPACITY_WINDOWS,
  type CapacityWindow,
  type CostBasis,
  type EstimatedApiCost,
  type Freshness,
  type IntegrationInstallState,
  type PlanCapacity,
  type SessionRun,
  type SessionUsage,
  type TokenActivity,
  type TokenCounters,
  USAGE_RANGES,
  type UsageRangeKind,
  type UsageScope,
  type UsageSummary,
} from "@ccc/domain";
import {
  type AnalysisToggle,
  type CostSnapshot,
  latestCapacity,
  latestRunBySession,
  listCostSnapshots,
  listRegisteredProjects,
  listToggleLog,
  queryCoverage,
  queryTokenActivity,
  type TokenActivityRows,
  USAGE_BUCKET_MS,
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
  /** The exclusive UTC quarter-hour bucket bound covering `end` (the store queries [start, queryEnd)). */
  readonly queryEnd: string;
}

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
  const queryEndMs =
    Math.floor(now.getTime() / USAGE_BUCKET_MS) * USAGE_BUCKET_MS + USAGE_BUCKET_MS;
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
/** `missingSources` names for a partial cost. */
const UNPRICED_MODELS = "unpriced-models";
const TRANSCRIPT_COVERAGE = "transcript-coverage";

const ZERO: TokenCounters = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

function counterTotal(c: TokenCounters): number {
  return c.input + c.output + c.cacheWrite + c.cacheRead;
}

function subtract(a: TokenCounters, b: TokenCounters): TokenCounters {
  return {
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
  };
}

/** List prices over per-model counters: an unlisted model is excluded and named, never priced at zero. */
function priceByModel(byModel: Iterable<readonly [string, TokenCounters]>): {
  usd: number;
  excludedModels: ReadonlySet<string>;
  hasTokens: boolean;
} {
  let usd = 0;
  let hasTokens = false;
  const excludedModels = new Set<string>();
  for (const [model, counters] of byModel) {
    if (counterTotal(counters) === 0) continue;
    hasTokens = true;
    const estimate = estimateCostUsd(model, counters);
    if (estimate.kind === "priced") usd += estimate.usd;
    else excludedModels.add(model);
  }
  return { usd, excludedModels, hasTokens };
}

function latestObservedAt(snapshots: readonly CostSnapshot[]): string | null {
  return snapshots.reduce<string | null>(
    (latest, s) => (newer(s.observedAt, latest) ? s.observedAt : latest),
    null,
  );
}

/**
 * The cost for one range (D-42, USAGE-03). A session's own status-line
 * estimate stands for it only when the session lies wholly inside the
 * range; list prices cover the rest of the range's token activity. The
 * basis is always stated: `claude-code-estimates`, `list-prices` or
 * `mixed`. An unlisted model is excluded and counted, and marks the cost
 * partial. With token activity unavailable, only the status line's
 * estimates can speak, and the result is partial (a session without a
 * snapshot is unknown); with neither, the cost is unavailable.
 */
export function buildRangeCost(
  db: Database.Database,
  kind: UsageScope,
  bounds: Pick<RangeBounds, "start" | "end" | "queryEnd">,
  activity: TokenActivity,
  now: Date,
): EstimatedApiCost {
  const covered = snapshotsCovering(db, bounds);
  const snapshotUsd = covered.reduce((sum, s) => sum + s.totalCostUsd, 0);
  const snapshotAt = latestObservedAt(covered);
  const common = {
    kind: "available" as const,
    range: kind,
    bounds: { start: bounds.start, end: bounds.end },
    source: "claude-code-estimates-and-list-prices" as const,
  };
  if (activity.kind !== "available") {
    if (snapshotAt === null) return { kind: "unavailable", reason: "needs-activity-or-wrapper" };
    return {
      ...common,
      usd: snapshotUsd,
      basis: "claude-code-estimates",
      priceTableDate: null,
      excludedModelCount: 0,
      observedAt: snapshotAt,
      freshness: freshnessAt(snapshotAt, now),
      partiality: { partial: true, missingSources: [TRANSCRIPT_SOURCE] },
    };
  }

  // The range's activity minus the covered sessions' own activity in it.
  const remaining = new Map(activity.byModel.map((row) => [row.model, row.counters] as const));
  for (const snapshot of covered) {
    const own = queryTokenActivity(db, {
      start: bounds.start,
      end: bounds.queryEnd,
      claudeSessionId: snapshot.claudeSessionId,
    });
    for (const row of own.byModel) {
      remaining.set(row.model, subtract(remaining.get(row.model) ?? ZERO, row.counters));
    }
  }
  const listed = priceByModel(remaining);
  const basis: CostBasis =
    snapshotAt === null ? "list-prices" : listed.hasTokens ? "mixed" : "claude-code-estimates";
  const missingSources = [
    ...(listed.excludedModels.size > 0 ? [UNPRICED_MODELS] : []),
    ...(activity.partiality.partial ? [TRANSCRIPT_COVERAGE] : []),
  ];
  return {
    ...common,
    usd: snapshotUsd + listed.usd,
    basis,
    priceTableDate: basis === "claude-code-estimates" ? null : PRICE_TABLE_EFFECTIVE_FROM,
    excludedModelCount: listed.excludedModels.size,
    observedAt: activity.observedAt,
    freshness:
      snapshotAt === null
        ? activity.freshness
        : worseFreshness(activity.freshness, freshnessAt(snapshotAt, now)),
    partiality: missingSources.length > 0 ? { partial: true, missingSources } : { partial: false },
  };
}

// ---------------------------------------------------------------------------
// Token activity and coverage (D-40, D-41, D-44, D-45)

export interface AnalysisState {
  readonly enabled: boolean;
  readonly firstScanPending: boolean;
}

/** What the transcript job knows: the format verdict, the oldest transcript, the last scan. */
export interface TranscriptFacts {
  readonly verdict: RecognitionVerdict;
  /** The earliest record (or file creation) among surviving transcripts, or null for none. */
  readonly oldestTranscriptAt: string | null;
  readonly lastScanAt: string | null;
}

export const NO_TRANSCRIPT_FACTS: TranscriptFacts = Object.freeze({
  verdict: { kind: "ok" } as const,
  oldestTranscriptAt: null,
  lastScanAt: null,
});

/** Claude Code's `cleanupPeriodDays` default when its settings name none (D-44). */
export const DEFAULT_CLEANUP_PERIOD_DAYS = 30;

export interface UsageSummaryInputs extends PlanCapacityInputs {
  readonly analysis: AnalysisState;
  readonly timeZone: string;
  /** Claude Code's transcript retention (default 30, minimum 1). */
  readonly cleanupPeriodDays: number;
  readonly transcripts: TranscriptFacts;
}

const DAY_MS = 86_400_000;

/**
 * The retention horizon (D-44): the later of now − cleanupPeriodDays and
 * the oldest surviving transcript, as a local calendar date. Null when no
 * transcript survives.
 */
export function retentionHorizon(
  now: Date,
  timeZone: string,
  cleanupPeriodDays: number,
  oldestTranscriptAt: string | null,
): string | null {
  if (oldestTranscriptAt === null) return null;
  const days = Number.isFinite(cleanupPeriodDays)
    ? Math.max(1, Math.floor(cleanupPeriodDays))
    : DEFAULT_CLEANUP_PERIOD_DAYS;
  const byRetention = localDayOf(now.getTime() - days * DAY_MS, timeZone);
  const byOldest = localDayOf(oldestTranscriptAt, timeZone);
  return byOldest > byRetention ? byOldest : byRetention;
}

/** A toggle log that reads "on" for every day: what a scan covered, whatever the toggle said. */
const ALWAYS_ON: readonly AnalysisToggle[] = [{ at: "1970-01-01T00:00:00.000Z", enabled: true }];

interface RangeCoverage {
  readonly horizonDate: string | null;
  readonly uncoveredDays: number;
  readonly analysisOffDays: number;
  /** Days a scan covered (the toggle aside); zero means no-coverage. */
  readonly scannedDays: number;
  readonly partial: boolean;
}

/**
 * Coverage for the local days [firstDay, lastDay]. Days before the
 * horizon, days analysis was off (from the toggle log) and days no scan
 * covered make the range partial. The scanner reads whole transcripts, so
 * a day analysis was off can still hold counted tokens once analysis is
 * back on; it is still reported as an analysis-off day (D-47), and only a
 * range with no scanned day at all is no-coverage.
 */
function rangeCoverage(
  db: Database.Database,
  firstDay: string,
  lastDay: string,
  horizon: string | null,
  toggles: readonly AnalysisToggle[],
  timeZone: string,
): RangeCoverage {
  const dayOf = (iso: string) => localDayOf(iso, timeZone);
  const days = queryCoverage(db, firstDay, lastDay, horizon, toggles, dayOf);
  const scanned = queryCoverage(db, firstDay, lastDay, horizon, ALWAYS_ON, dayOf);
  const count = (status: string) => days.filter((d) => d.status === status).length;
  return {
    horizonDate: horizon !== null && firstDay < horizon ? horizon : null,
    uncoveredDays: count("before-horizon") + count("not-scanned"),
    analysisOffDays: count("analysis-off"),
    scannedDays: scanned.filter((d) => d.status === "covered").length,
    partial: days.some((d) => d.status !== "covered"),
  };
}

/** Why activity is unavailable before any coverage is looked at: off, or the format changed. */
function blockedActivity(inputs: UsageSummaryInputs): TokenActivity | null {
  if (!inputs.analysis.enabled) {
    return { kind: "unavailable", reason: "analysis-off", version: null };
  }
  if (inputs.transcripts.verdict.kind === "unavailable") {
    return {
      kind: "unavailable",
      reason: "format-changed",
      version: inputs.transcripts.verdict.version,
    };
  }
  return null;
}

interface ActivityContext {
  readonly horizon: string | null;
  readonly toggles: readonly AnalysisToggle[];
  readonly projectNames: ReadonlyMap<string, string>;
}

function activityContext(inputs: UsageSummaryInputs): ActivityContext {
  return {
    horizon: retentionHorizon(
      inputs.now,
      inputs.timeZone,
      inputs.cleanupPeriodDays,
      inputs.transcripts.oldestTranscriptAt,
    ),
    toggles: listToggleLog(inputs.db),
    projectNames: new Map(listRegisteredProjects(inputs.db).map((p) => [p.projectId, p.name])),
  };
}

const MAX_KEY = 128;

function availableActivity(
  inputs: UsageSummaryInputs,
  context: ActivityContext,
  range: UsageScope,
  bounds: { start: string; end: string },
  rows: TokenActivityRows,
  coverage: RangeCoverage,
): TokenActivity {
  const { lastScanAt } = inputs.transcripts;
  return {
    kind: "available",
    range,
    bounds,
    totals: rows.totals,
    byProject: rows.byProject.map((row) => ({
      projectId: row.projectId,
      projectName:
        row.projectId === null ? null : (context.projectNames.get(row.projectId) ?? null),
      counters: row.counters,
    })),
    byModel: rows.byModel.filter((row) => row.model.length > 0 && row.model.length <= MAX_KEY),
    bySkill: rows.bySkill.filter((row) => row.name.length > 0 && row.name.length <= MAX_KEY),
    observedAt: lastScanAt ?? inputs.now.toISOString(),
    source: TRANSCRIPT_SOURCE,
    // Before this process's first scan the aggregates are what an earlier one left.
    freshness: lastScanAt === null ? "cached" : freshnessAt(lastScanAt, inputs.now),
    partiality: { partial: coverage.partial },
    coverage: {
      horizonDate: coverage.horizonDate,
      uncoveredDays: coverage.uncoveredDays,
      analysisOffDays: coverage.analysisOffDays,
    },
  };
}

function buildRangeActivity(
  inputs: UsageSummaryInputs,
  context: ActivityContext,
  kind: UsageRangeKind,
  bounds: RangeBounds,
): TokenActivity {
  const blocked = blockedActivity(inputs);
  if (blocked !== null) return blocked;
  const coverage = rangeCoverage(
    inputs.db,
    bounds.firstDay,
    bounds.lastDay,
    context.horizon,
    context.toggles,
    inputs.timeZone,
  );
  if (coverage.scannedDays === 0) {
    return { kind: "unavailable", reason: "no-coverage", version: null };
  }
  const rows = queryTokenActivity(inputs.db, { start: bounds.start, end: bounds.queryEnd });
  return availableActivity(
    inputs,
    context,
    kind,
    { start: bounds.start, end: bounds.end },
    rows,
    coverage,
  );
}

// ---------------------------------------------------------------------------
// The summary and per-Session usage

/** The whole summary published by `usage.updated` and `snapshot.state.usage`. */
export function buildUsageSummary(inputs: UsageSummaryInputs): UsageSummary {
  const { db, now, timeZone, analysis } = inputs;
  const context = activityContext(inputs);
  const range = (kind: UsageRangeKind) => {
    const bounds = rangeBounds(kind, now, timeZone);
    const activity = buildRangeActivity(inputs, context, kind, bounds);
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

/** Every bucket: a Session's activity is filtered by its Claude session ID, not by time. */
const ALL_TIME = { start: "1970-01-01T00:00:00.000Z", end: "9999-12-31T00:00:00.000Z" } as const;

/**
 * Per-Session usage for the Agent runs detail pane (PR-23): the Session's
 * token activity (all of its Claude session's aggregates) and its cost,
 * its own status-line estimate where one exists, else list prices.
 */
export function buildSessionUsage(inputs: UsageSummaryInputs & { run: SessionRun }): SessionUsage {
  const { db, run, now, timeZone } = inputs;
  const endIso = run.endedAt ?? now.toISOString();
  const bounds =
    Date.parse(endIso) >= Date.parse(run.startedAt)
      ? { start: run.startedAt, end: endIso }
      : { start: run.startedAt, end: run.startedAt };
  const session = run.claudeSessionId;
  const context = activityContext(inputs);

  const blocked = blockedActivity(inputs);
  let activity: TokenActivity = blocked ?? {
    kind: "unavailable",
    reason: "no-coverage",
    version: null,
  };
  let rows: TokenActivityRows | null = null;
  if (blocked === null && session !== null) {
    const coverage = rangeCoverage(
      db,
      localDayOf(bounds.start, timeZone),
      localDayOf(bounds.end, timeZone),
      context.horizon,
      context.toggles,
      timeZone,
    );
    rows = queryTokenActivity(db, { ...ALL_TIME, claudeSessionId: session });
    if (coverage.scannedDays > 0 || counterTotal(rows.totals) > 0) {
      activity = availableActivity(inputs, context, "session", bounds, rows, coverage);
    }
  }

  const snapshot =
    session === null ? undefined : listCostSnapshots(db).find((s) => s.claudeSessionId === session);
  let cost: EstimatedApiCost;
  if (snapshot !== undefined) {
    cost = {
      kind: "available",
      range: "session",
      bounds,
      usd: snapshot.totalCostUsd,
      basis: "claude-code-estimates",
      priceTableDate: null,
      excludedModelCount: 0,
      observedAt: snapshot.observedAt,
      source: "claude-code-estimates-and-list-prices",
      freshness: freshnessAt(snapshot.observedAt, now),
      partiality: { partial: false },
    };
  } else if (activity.kind === "available" && rows !== null) {
    const listed = priceByModel(rows.byModel.map((row) => [row.model, row.counters] as const));
    const missingSources = [
      ...(listed.excludedModels.size > 0 ? [UNPRICED_MODELS] : []),
      ...(activity.partiality.partial ? [TRANSCRIPT_COVERAGE] : []),
    ];
    cost = {
      kind: "available",
      range: "session",
      bounds,
      usd: listed.usd,
      basis: "list-prices",
      priceTableDate: PRICE_TABLE_EFFECTIVE_FROM,
      excludedModelCount: listed.excludedModels.size,
      observedAt: activity.observedAt,
      source: "claude-code-estimates-and-list-prices",
      freshness: activity.freshness,
      partiality:
        missingSources.length > 0 ? { partial: true, missingSources } : { partial: false },
    };
  } else {
    cost = { kind: "unavailable", reason: "needs-activity-or-wrapper" };
  }
  return { runId: run.runId, activity, cost };
}
