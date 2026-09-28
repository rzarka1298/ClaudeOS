import type { TokenCounters } from "@ccc/domain";
import type Database from "better-sqlite3";

/**
 * Usage persistence (Phase 5, D-40..D-47): message-level dedup, hourly
 * token counters, transcript cursors, the coverage ledger, latest-wins
 * capacity and cost snapshots, collector settings and the analysis toggle
 * log. Counters and identifiers only — nothing here accepts or stores a
 * prompt, a reply, a tool input or file content (D-49). The service is the
 * only caller and never writes SQL itself.
 */

/**
 * One recognized transcript usage record, as the service hands it over
 * after attribution. Declared here structurally because the store may
 * import domain only, never collectors. `projectKey` null means
 * unclassified; `skillKey` null means no skill was named (D-45).
 */
export interface UsageRecordInput {
  readonly messageId: string;
  readonly claudeSessionId: string;
  /** An ISO 8601 instant; the record is bucketed by its UTC hour. */
  readonly timestamp: string;
  readonly model: string;
  readonly skillKey: string | null;
  readonly projectKey: string | null;
  readonly counters: TokenCounters;
}

/** Thrown by {@link recordUsage} before any write when a record is malformed. */
export class InvalidUsageRecordError extends Error {
  constructor(messageId: string, reason: string) {
    super(`Usage record ${JSON.stringify(messageId.slice(0, 64))} is invalid: ${reason}`);
    this.name = "InvalidUsageRecordError";
  }
}

/** UTC bounds, start inclusive and end exclusive, over hour buckets. */
export interface TokenActivityQuery {
  readonly start: string;
  readonly end: string;
  /** Restricts to one Claude session (the Agent runs detail pane). */
  readonly claudeSessionId?: string;
}

/** Totals plus the three breakdowns for a range (D-45). */
export interface TokenActivityRows {
  readonly totals: TokenCounters;
  /** `projectId` null is the unclassified group. */
  readonly byProject: ReadonlyArray<{ projectId: string | null; counters: TokenCounters }>;
  readonly byModel: ReadonlyArray<{ model: string; counters: TokenCounters }>;
  /** Only named skills; unnamed activity appears in no row here. */
  readonly bySkill: ReadonlyArray<{ name: string; counters: TokenCounters }>;
}

/**
 * How one calendar day stands in the coverage ledger (D-44, D-47):
 * - `before-horizon`: local transcripts no longer reach it;
 * - `analysis-off`: transcript analysis was off for some or all of it;
 * - `covered`: a scan covered it;
 * - `not-scanned`: none of the above yet.
 */
export type CoverageStatus = "covered" | "before-horizon" | "analysis-off" | "not-scanned";

export interface CoverageDay {
  readonly day: string;
  readonly status: CoverageStatus;
}

/** One transcript-analysis toggle, at an ISO instant. */
export interface AnalysisToggle {
  readonly at: string;
  readonly enabled: boolean;
}

/** A transcript scanner cursor (D-40). `inode` is text so a 64-bit inode survives. */
export interface TranscriptCursor {
  readonly inode: string;
  readonly size: number;
  readonly offset: number;
}

/** The latest plan-capacity observation for one window (D-43). */
export interface CapacitySnapshot {
  readonly window: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly observedAt: string;
  readonly claudeSessionId: string | null;
}

/** The latest status-line cost total for one Claude session (D-42). */
export interface CostSnapshot {
  readonly claudeSessionId: string;
  readonly totalCostUsd: number;
  readonly firstObservedAt: string;
  readonly observedAt: string;
}

const COUNTER_KEYS = ["input", "output", "cacheWrite", "cacheRead"] as const;

function hourBucketOf(timestamp: string): string | null {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return null;
  const hour = new Date(ms);
  hour.setUTCMinutes(0, 0, 0);
  return hour.toISOString();
}

function assertValidRecord(record: UsageRecordInput): string {
  if (record.messageId.length === 0) {
    throw new InvalidUsageRecordError(record.messageId, "empty message id");
  }
  for (const key of COUNTER_KEYS) {
    const value = record.counters[key];
    if (!(Number.isSafeInteger(value) && value >= 0)) {
      throw new InvalidUsageRecordError(record.messageId, `${key} is not a non-negative integer`);
    }
  }
  const bucket = hourBucketOf(record.timestamp);
  if (bucket === null) {
    throw new InvalidUsageRecordError(record.messageId, "unparsable timestamp");
  }
  return bucket;
}

/**
 * Counts each transcript message once (D-43, PR-11). All records are
 * validated first, so a malformed batch writes nothing. Then, in ONE
 * transaction, each `messageId` is inserted into `usage_seen_messages`
 * with INSERT OR IGNORE, and only when that insert changed a row are the
 * record's counters added into its hourly bucket. A message repeated over
 * many lines, or rescanned later, therefore adds its tokens exactly once.
 * Returns the number of records newly counted.
 */
export function recordUsage(
  db: Database.Database,
  records: readonly UsageRecordInput[],
  seenAt: string,
): number {
  const buckets = records.map(assertValidRecord);
  const markSeen = db.prepare(
    "INSERT OR IGNORE INTO usage_seen_messages (message_id, seen_at) VALUES (?, ?)",
  );
  const addCounters = db.prepare(
    `INSERT INTO usage_hourly
       (hour_bucket, claude_session_id, project_key, model, skill_key, input, output, cache_write, cache_read)
     VALUES (@hourBucket, @claudeSessionId, @projectKey, @model, @skillKey, @input, @output, @cacheWrite, @cacheRead)
     ON CONFLICT (hour_bucket, claude_session_id, project_key, model, skill_key) DO UPDATE SET
       input = input + excluded.input,
       output = output + excluded.output,
       cache_write = cache_write + excluded.cache_write,
       cache_read = cache_read + excluded.cache_read`,
  );
  return db.transaction(() => {
    let counted = 0;
    records.forEach((record, index) => {
      if (markSeen.run(record.messageId, seenAt).changes !== 1) return;
      addCounters.run({
        hourBucket: buckets[index],
        claudeSessionId: record.claudeSessionId,
        projectKey: record.projectKey ?? "",
        model: record.model,
        skillKey: record.skillKey ?? "",
        ...record.counters,
      });
      counted += 1;
    });
    return counted;
  })();
}

interface CounterSums {
  input: number | null;
  output: number | null;
  cache_write: number | null;
  cache_read: number | null;
}

function toCounters(row: CounterSums): TokenCounters {
  return {
    input: row.input ?? 0,
    output: row.output ?? 0,
    cacheWrite: row.cache_write ?? 0,
    cacheRead: row.cache_read ?? 0,
  };
}

const SUMS =
  "SUM(input) AS input, SUM(output) AS output, SUM(cache_write) AS cache_write, SUM(cache_read) AS cache_read";

/**
 * Totals and the by-project, by-model and by-skill breakdowns over hour
 * buckets in [start, end), optionally for one Claude session. The service
 * converts a local-time range to these UTC bounds (D-45); breakdown rows are
 * ordered by input tokens, largest first.
 */
export function queryTokenActivity(
  db: Database.Database,
  query: TokenActivityQuery,
): TokenActivityRows {
  const sessionClause =
    query.claudeSessionId === undefined ? "" : " AND claude_session_id = @session";
  const where = `WHERE hour_bucket >= @start AND hour_bucket < @end${sessionClause}`;
  const params = {
    start: query.start,
    end: query.end,
    ...(query.claudeSessionId === undefined ? {} : { session: query.claudeSessionId }),
  };
  const grouped = <K extends string>(column: string, alias: K, extraWhere = "") =>
    db
      .prepare(
        `SELECT ${column} AS ${alias}, ${SUMS} FROM usage_hourly ${where}${extraWhere}
         GROUP BY ${column} ORDER BY SUM(input) DESC, ${column}`,
      )
      .all(params) as Array<CounterSums & Record<K, string>>;

  const totals = db.prepare(`SELECT ${SUMS} FROM usage_hourly ${where}`).get(params) as CounterSums;
  return {
    totals: toCounters(totals),
    byProject: grouped("project_key", "key").map((row) => ({
      projectId: row.key === "" ? null : row.key,
      counters: toCounters(row),
    })),
    byModel: grouped("model", "key").map((row) => ({
      model: row.key,
      counters: toCounters(row),
    })),
    bySkill: grouped("skill_key", "key", " AND skill_key <> ''").map((row) => ({
      name: row.key,
      counters: toCounters(row),
    })),
  };
}

/** Records that a scan covered `day` (a calendar date). The first record's time is kept. */
export function markDayCovered(db: Database.Database, day: string, at: string): void {
  db.prepare(
    "INSERT INTO coverage_days (day, recorded_at) VALUES (?, ?) ON CONFLICT(day) DO NOTHING",
  ).run(day, at);
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function assertDay(day: string): number {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (!DAY_PATTERN.test(day) || Number.isNaN(ms)) {
    throw new RangeError(`"${day}" is not a YYYY-MM-DD calendar date`);
  }
  return ms;
}

/** The UTC calendar date of an ISO instant: the default day function. */
function utcDayOf(iso: string): string {
  return new Date(Date.parse(iso)).toISOString().slice(0, 10);
}

/**
 * Classifies every day from `fromDay` to `toDay` inclusive (D-44, D-47),
 * in this order of precedence:
 * 1. before `horizonDate` (when known) → `before-horizon`;
 * 2. analysis off at the day's start, or switched off during it →
 *    `analysis-off` (no toggle before a day means the default, off);
 * 3. recorded by {@link markDayCovered} → `covered`;
 * 4. otherwise `not-scanned`.
 * `dayOf` maps a toggle instant to its calendar day; the service passes a
 * local-time function, and the default is the UTC date.
 */
export function queryCoverage(
  db: Database.Database,
  fromDay: string,
  toDay: string,
  horizonDate: string | null,
  toggleLog: readonly AnalysisToggle[],
  dayOf: (iso: string) => string = utcDayOf,
): CoverageDay[] {
  const fromMs = assertDay(fromDay);
  const toMs = assertDay(toDay);
  const covered = new Set(
    (
      db
        .prepare("SELECT day FROM coverage_days WHERE day >= ? AND day <= ?")
        .all(fromDay, toDay) as Array<{ day: string }>
    ).map((row) => row.day),
  );
  const toggles = [...toggleLog]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((toggle) => ({ day: dayOf(toggle.at), enabled: toggle.enabled }));

  const days: CoverageDay[] = [];
  for (let ms = fromMs; ms <= toMs; ms += DAY_MS) {
    const day = new Date(ms).toISOString().slice(0, 10);
    const enabledAtStart = toggles.filter((toggle) => toggle.day < day).at(-1)?.enabled ?? false;
    const disabledDuring = toggles.some((toggle) => toggle.day === day && !toggle.enabled);
    let status: CoverageStatus;
    if (horizonDate !== null && day < horizonDate) status = "before-horizon";
    else if (!enabledAtStart || disabledDuring) status = "analysis-off";
    else if (covered.has(day)) status = "covered";
    else status = "not-scanned";
    days.push({ day, status });
  }
  return days;
}

/** The scanner cursor for a transcript path, or null when the file was never scanned. */
export function readCursor(db: Database.Database, path: string): TranscriptCursor | null {
  const row = db
    .prepare("SELECT inode, size, offset FROM transcript_cursors WHERE path = ?")
    .get(path) as TranscriptCursor | undefined;
  return row ? { inode: row.inode, size: row.size, offset: row.offset } : null;
}

/** Stores the scanner cursor for a transcript path, replacing the previous one. */
export function writeCursor(
  db: Database.Database,
  path: string,
  cursor: TranscriptCursor,
  at: string,
): void {
  db.prepare(
    `INSERT INTO transcript_cursors (path, inode, size, offset, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       inode = excluded.inode, size = excluded.size, offset = excluded.offset, updated_at = excluded.updated_at`,
  ).run(path, cursor.inode, cursor.size, cursor.offset, at);
}

/**
 * Keeps the latest capacity observation per window (D-43): an older
 * `observedAt` than the stored one changes nothing.
 */
export function upsertCapacitySnapshot(db: Database.Database, snapshot: CapacitySnapshot): void {
  db.prepare(
    `INSERT INTO capacity_snapshots ("window", used_percent, resets_at, observed_at, claude_session_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT("window") DO UPDATE SET
       used_percent = excluded.used_percent,
       resets_at = excluded.resets_at,
       observed_at = excluded.observed_at,
       claude_session_id = excluded.claude_session_id
     WHERE excluded.observed_at >= capacity_snapshots.observed_at`,
  ).run(
    snapshot.window,
    String(snapshot.usedPercent),
    snapshot.resetsAt,
    snapshot.observedAt,
    snapshot.claudeSessionId,
  );
}

/** The latest observation for every window, by window name. */
export function latestCapacity(db: Database.Database): CapacitySnapshot[] {
  const rows = db
    .prepare(
      `SELECT "window", used_percent, resets_at, observed_at, claude_session_id
       FROM capacity_snapshots ORDER BY "window"`,
    )
    .all() as Array<{
    window: string;
    used_percent: string;
    resets_at: string | null;
    observed_at: string;
    claude_session_id: string | null;
  }>;
  return rows.map((row) => ({
    window: row.window,
    usedPercent: Number(row.used_percent),
    resetsAt: row.resets_at,
    observedAt: row.observed_at,
    claudeSessionId: row.claude_session_id,
  }));
}

/**
 * Keeps the latest status-line cost total per Claude session (D-42). The
 * status line reports a running total, so a later snapshot replaces the
 * stored one and two snapshots are never summed; an older snapshot changes
 * nothing. `firstObservedAt` keeps the first sighting.
 */
export function upsertCostSnapshot(
  db: Database.Database,
  snapshot: { claudeSessionId: string; totalCostUsd: number; observedAt: string },
): void {
  db.prepare(
    `INSERT INTO cost_snapshots (claude_session_id, total_cost_usd, first_observed_at, observed_at)
     VALUES (@session, @total, @observedAt, @observedAt)
     ON CONFLICT(claude_session_id) DO UPDATE SET
       total_cost_usd = excluded.total_cost_usd,
       observed_at = excluded.observed_at,
       first_observed_at = MIN(cost_snapshots.first_observed_at, excluded.first_observed_at)
     WHERE excluded.observed_at >= cost_snapshots.observed_at`,
  ).run({
    session: snapshot.claudeSessionId,
    total: String(snapshot.totalCostUsd),
    observedAt: snapshot.observedAt,
  });
}

/** Every session's latest cost snapshot, by Claude session ID. */
export function listCostSnapshots(db: Database.Database): CostSnapshot[] {
  const rows = db
    .prepare(
      `SELECT claude_session_id, total_cost_usd, first_observed_at, observed_at
       FROM cost_snapshots ORDER BY claude_session_id`,
    )
    .all() as Array<{
    claude_session_id: string;
    total_cost_usd: string;
    first_observed_at: string;
    observed_at: string;
  }>;
  return rows.map((row) => ({
    claudeSessionId: row.claude_session_id,
    totalCostUsd: Number(row.total_cost_usd),
    firstObservedAt: row.first_observed_at,
    observedAt: row.observed_at,
  }));
}

/** A collector setting's value, or null when unset (the caller applies the default). */
export function getCollectorSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM collector_settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/** Sets a collector setting (D-47, D-48); the service is its only writer. */
export function setCollectorSetting(
  db: Database.Database,
  key: string,
  value: string,
  at: string,
): void {
  db.prepare(
    `INSERT INTO collector_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, at);
}

/** Appends one analysis toggle; a second toggle at the same instant replaces the first. */
export function appendToggleLog(db: Database.Database, at: string, enabled: boolean): void {
  db.prepare(
    `INSERT INTO analysis_toggle_log (at, enabled) VALUES (?, ?)
     ON CONFLICT(at) DO UPDATE SET enabled = excluded.enabled`,
  ).run(at, enabled ? "true" : "false");
}

/** Every analysis toggle, oldest first. */
export function listToggleLog(db: Database.Database): AnalysisToggle[] {
  const rows = db
    .prepare("SELECT at, enabled FROM analysis_toggle_log ORDER BY at")
    .all() as Array<{
    at: string;
    enabled: string;
  }>;
  return rows.map((row) => ({ at: row.at, enabled: row.enabled === "true" }));
}

/**
 * The six tables "Delete cached usage analytics" empties (D-46). `runs`,
 * `session_overrides`, `collector_settings` and `analysis_toggle_log` are
 * deliberately absent: deleting usage never touches session history, the
 * owner's associations, the analysis setting or its history (USAGE-08).
 */
const USAGE_ANALYTICS_TABLES = [
  "usage_hourly",
  "usage_seen_messages",
  "coverage_days",
  "transcript_cursors",
  "capacity_snapshots",
  "cost_snapshots",
] as const;

/**
 * Empties the six usage tables in one transaction (USAGE-08, D-46). If any
 * delete fails, the transaction rolls back and every table is as it was.
 * Clearing the cursors and seen messages is what lets a later rescan from
 * zero rebuild identical aggregates.
 */
export function deleteUsageAnalytics(db: Database.Database): void {
  db.transaction(() => {
    for (const table of USAGE_ANALYTICS_TABLES) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  })();
}
