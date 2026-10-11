import {
  type CodexTokenCounters,
  type CodexUsageSnapshot,
  CodexUsageSnapshotSchema,
} from "@ccc/domain";
import type Database from "better-sqlite3";
import {
  type AnalysisToggle,
  type CoverageDay,
  type CoverageStatus,
  deleteUsageAnalytics,
  getCollectorSetting,
  setCollectorSetting,
  USAGE_BUCKET_MS,
} from "./usage-store.js";

/**
 * Codex persistence (Phase 05.1, D-15, D-24, CODEX-08, CODEX-10): per-turn
 * token counters, additive deltas, durable cumulative high-water marks, hashed
 * rollout cursors, the coverage ledger, recognition tallies and the last
 * normalised rate-limit snapshot. Counters, hashed keys and identifiers only:
 * nothing here accepts or stores a prompt, a reply, a title, a path or an account.
 */

/** Thrown before any write when a Codex record is malformed. */
export class InvalidCodexRecordError extends Error {
  constructor(reason: string) {
    super(`Codex record is invalid: ${reason}`);
    this.name = "InvalidCodexRecordError";
  }
}

export interface TurnTokensInput {
  readonly threadId: string;
  readonly turnId: string;
  readonly bucketStart: string;
  readonly counters: CodexTokenCounters;
  readonly observedAt: string;
}

export interface CumulativeDeltaInput {
  readonly threadId: string;
  readonly bucketStart: string;
  readonly delta: CodexTokenCounters;
}

export interface CodexTokenRangeQuery {
  readonly start: string;
  readonly end: string;
}

export interface CodexTokenTotals {
  readonly counters: CodexTokenCounters;
  readonly rows: number;
}

const COUNTER_KEYS = [
  "input",
  "cachedInput",
  "cacheWrite",
  "output",
  "reasoningOutput",
  "total",
] as const satisfies readonly (keyof CodexTokenCounters)[];

function assertCounters(counters: CodexTokenCounters): void {
  for (const key of COUNTER_KEYS) {
    const value = counters[key];
    if (!(Number.isSafeInteger(value) && value >= 0)) {
      throw new InvalidCodexRecordError(`${key} is not a non-negative integer`);
    }
  }
}

function assertIdentifier(name: string, value: string): void {
  if (value.length === 0) throw new InvalidCodexRecordError(`${name} is empty`);
}

/** True when `value` is a canonical `toISOString()` instant: the form text range comparison needs. */
function isCanonicalInstant(value: string): boolean {
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === value;
}

function assertBucket(bucketStart: string): void {
  if (!isCanonicalInstant(bucketStart) || Date.parse(bucketStart) % USAGE_BUCKET_MS !== 0) {
    throw new InvalidCodexRecordError("bucket start is not a canonical UTC quarter hour");
  }
}

function assertInstant(name: string, value: string): void {
  if (!isCanonicalInstant(value)) {
    throw new InvalidCodexRecordError(`${name} is not a canonical ISO 8601 instant`);
  }
}

/**
 * The UTC quarter hour an instant falls in, as the canonical ISO text the
 * tables store, or null when the text does not parse. Uses the Phase 5 bucket
 * width so both agents bucket identically.
 */
export function codexBucketStart(timestamp: string): string | null {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return null;
  return new Date(Math.floor(ms / USAGE_BUCKET_MS) * USAGE_BUCKET_MS).toISOString();
}

/**
 * Records one turn's cumulative counters (CODEX-10: latest cumulative value per
 * thread and turn, never summed). One row per turn: the bucket start is written
 * by the FIRST call only, and each counter becomes the maximum of the stored and
 * the incoming value, so an out-of-order replay can never lower a counter.
 * Everything is validated before the write.
 */
export function upsertTurnTokens(db: Database.Database, input: TurnTokensInput): void {
  assertIdentifier("thread id", input.threadId);
  assertIdentifier("turn id", input.turnId);
  assertBucket(input.bucketStart);
  assertInstant("observed time", input.observedAt);
  assertCounters(input.counters);
  const c = input.counters;
  db.prepare(
    `INSERT INTO codex_token_turns
       (thread_id, turn_id, bucket_start, input, cached_input, cache_write, output, reasoning_output, total, observed_at)
     VALUES (@threadId, @turnId, @bucketStart, @input, @cachedInput, @cacheWrite, @output, @reasoningOutput, @total, @observedAt)
     ON CONFLICT (thread_id, turn_id) DO UPDATE SET
       input = MAX(input, excluded.input),
       cached_input = MAX(cached_input, excluded.cached_input),
       cache_write = MAX(cache_write, excluded.cache_write),
       output = MAX(output, excluded.output),
       reasoning_output = MAX(reasoning_output, excluded.reasoning_output),
       total = MAX(total, excluded.total),
       observed_at = MAX(observed_at, excluded.observed_at)`,
  ).run({
    threadId: input.threadId,
    turnId: input.turnId,
    bucketStart: input.bucketStart,
    observedAt: input.observedAt,
    input: c.input,
    cachedInput: c.cachedInput,
    cacheWrite: c.cacheWrite,
    output: c.output,
    reasoningOutput: c.reasoningOutput,
    total: c.total,
  });
}

/**
 * Sets one turn's COUNTED contribution (plan 05.1-23 precedence rule): the usage
 * of the turn that no thread-cumulative record already covers. Unlike
 * {@link upsertTurnTokens} it REPLACES the stored counters and bucket, because a
 * contribution can fall when a later cumulative record covers the turn; an
 * all-zero contribution removes the row so an empty turn never makes a range
 * look measured. The scanner recomputes the whole contribution from its
 * persisted per-turn state, so calling this twice with the same input changes
 * nothing.
 */
export function setTurnContribution(db: Database.Database, input: TurnTokensInput): void {
  assertIdentifier("thread id", input.threadId);
  assertIdentifier("turn id", input.turnId);
  assertBucket(input.bucketStart);
  assertInstant("observed time", input.observedAt);
  assertCounters(input.counters);
  const c = input.counters;
  if (COUNTER_KEYS.every((key) => c[key] === 0)) {
    db.prepare("DELETE FROM codex_token_turns WHERE thread_id = ? AND turn_id = ?").run(
      input.threadId,
      input.turnId,
    );
    return;
  }
  db.prepare(
    `INSERT INTO codex_token_turns
       (thread_id, turn_id, bucket_start, input, cached_input, cache_write, output, reasoning_output, total, observed_at)
     VALUES (@threadId, @turnId, @bucketStart, @input, @cachedInput, @cacheWrite, @output, @reasoningOutput, @total, @observedAt)
     ON CONFLICT (thread_id, turn_id) DO UPDATE SET
       bucket_start = excluded.bucket_start,
       input = excluded.input,
       cached_input = excluded.cached_input,
       cache_write = excluded.cache_write,
       output = excluded.output,
       reasoning_output = excluded.reasoning_output,
       total = excluded.total,
       observed_at = excluded.observed_at`,
  ).run({
    threadId: input.threadId,
    turnId: input.turnId,
    bucketStart: input.bucketStart,
    observedAt: input.observedAt,
    input: c.input,
    cachedInput: c.cachedInput,
    cacheWrite: c.cacheWrite,
    output: c.output,
    reasoningOutput: c.reasoningOutput,
    total: c.total,
  });
}

/**
 * Adds a per-bucket delta for a Codex version whose rollouts carry no per-turn
 * record. Additive: the caller (the scanner) is responsible for handing over a
 * delta only once, in the same transaction that advances its cursor and
 * high-water mark.
 */
export function addCumulativeDelta(db: Database.Database, input: CumulativeDeltaInput): void {
  assertIdentifier("thread id", input.threadId);
  assertBucket(input.bucketStart);
  assertCounters(input.delta);
  const d = input.delta;
  db.prepare(
    `INSERT INTO codex_token_deltas
       (thread_id, bucket_start, input, cached_input, cache_write, output, reasoning_output, total)
     VALUES (@threadId, @bucketStart, @input, @cachedInput, @cacheWrite, @output, @reasoningOutput, @total)
     ON CONFLICT (thread_id, bucket_start) DO UPDATE SET
       input = input + excluded.input,
       cached_input = cached_input + excluded.cached_input,
       cache_write = cache_write + excluded.cache_write,
       output = output + excluded.output,
       reasoning_output = reasoning_output + excluded.reasoning_output,
       total = total + excluded.total`,
  ).run({
    threadId: input.threadId,
    bucketStart: input.bucketStart,
    input: d.input,
    cachedInput: d.cachedInput,
    cacheWrite: d.cacheWrite,
    output: d.output,
    reasoningOutput: d.reasoningOutput,
    total: d.total,
  });
}

/** Whether any per-turn row exists for a thread (durable, so it survives a restart). */
export function threadHasTurnRows(db: Database.Database, threadId: string): boolean {
  assertIdentifier("thread id", threadId);
  return (
    db.prepare("SELECT 1 FROM codex_token_turns WHERE thread_id = ? LIMIT 1").get(threadId) !==
    undefined
  );
}

/**
 * Drops a thread's cumulative-fallback delta rows. Called when per-turn records
 * for the same thread appear, so the same tokens are never counted from both.
 */
export function deleteCumulativeDeltas(db: Database.Database, threadId: string): void {
  assertIdentifier("thread id", threadId);
  db.prepare("DELETE FROM codex_token_deltas WHERE thread_id = ?").run(threadId);
}

interface CounterRow {
  readonly input: number;
  readonly cached_input: number;
  readonly cache_write: number;
  readonly output: number;
  readonly reasoning_output: number;
  readonly total: number;
}

function toCounters(row: CounterRow): CodexTokenCounters {
  return {
    input: row.input,
    cachedInput: row.cached_input,
    cacheWrite: row.cache_write,
    output: row.output,
    reasoningOutput: row.reasoning_output,
    total: row.total,
  };
}

/** The durable cumulative high-water marks for a thread, or null when it was never recorded. */
export function readCumulativeBaseline(
  db: Database.Database,
  threadId: string,
): CodexTokenCounters | null {
  const row = db
    .prepare(
      `SELECT input, cached_input, cache_write, output, reasoning_output, total
       FROM codex_token_cumulative WHERE thread_id = ?`,
    )
    .get(threadId) as CounterRow | undefined;
  return row ? toCounters(row) : null;
}

/**
 * Raises a thread's cumulative high-water marks: each of the six counters becomes
 * the maximum of the stored and the incoming value and is never replaced by a
 * lower one. These are dedup state independent of file identity and cursor
 * position, so a rescan or parser reset cannot count previous usage again.
 */
export function writeCumulativeBaseline(
  db: Database.Database,
  threadId: string,
  counters: CodexTokenCounters,
  at: string,
): void {
  assertIdentifier("thread id", threadId);
  assertInstant("update time", at);
  assertCounters(counters);
  db.prepare(
    `INSERT INTO codex_token_cumulative
       (thread_id, input, cached_input, cache_write, output, reasoning_output, total, updated_at)
     VALUES (@threadId, @input, @cachedInput, @cacheWrite, @output, @reasoningOutput, @total, @at)
     ON CONFLICT (thread_id) DO UPDATE SET
       input = MAX(input, excluded.input),
       cached_input = MAX(cached_input, excluded.cached_input),
       cache_write = MAX(cache_write, excluded.cache_write),
       output = MAX(output, excluded.output),
       reasoning_output = MAX(reasoning_output, excluded.reasoning_output),
       total = MAX(total, excluded.total),
       updated_at = MAX(updated_at, excluded.updated_at)`,
  ).run({
    threadId,
    at,
    input: counters.input,
    cachedInput: counters.cachedInput,
    cacheWrite: counters.cacheWrite,
    output: counters.output,
    reasoningOutput: counters.reasoningOutput,
    total: counters.total,
  });
}

/**
 * Totals over buckets in the half-open UTC range [start, end): turn rows and
 * delta rows are summed together. Returns null, never zeros, when no row lies
 * inside (an uncovered range is not the same as no tokens).
 */
export function queryCodexTokenTotals(
  db: Database.Database,
  query: CodexTokenRangeQuery,
): CodexTokenTotals | null {
  assertInstant("range start", query.start);
  assertInstant("range end", query.end);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS rows,
              COALESCE(SUM(input), 0) AS input,
              COALESCE(SUM(cached_input), 0) AS cached_input,
              COALESCE(SUM(cache_write), 0) AS cache_write,
              COALESCE(SUM(output), 0) AS output,
              COALESCE(SUM(reasoning_output), 0) AS reasoning_output,
              COALESCE(SUM(total), 0) AS total
       FROM (
         SELECT bucket_start, input, cached_input, cache_write, output, reasoning_output, total
           FROM codex_token_turns
         UNION ALL
         SELECT bucket_start, input, cached_input, cache_write, output, reasoning_output, total
           FROM codex_token_deltas
       )
       WHERE bucket_start >= @start AND bucket_start < @end`,
    )
    .get({ start: query.start, end: query.end }) as CounterRow & { rows: number };
  return row.rows === 0 ? null : { counters: toCounters(row), rows: row.rows };
}

// --- Rollout-owned usage ------------------------------------------------------

/**
 * One rollout's counted usage, replaced as a whole (plan 05.1-23 redesign). The
 * scanner re-reads a changed rollout in full and hands over the usage per UTC
 * quarter hour. The rows live in `codex_token_deltas` with the rollout's cursor
 * key (the SHA-256 hex of its path, never the path) in the `thread_id` column:
 * that column is an owner key. A 64-character lowercase hex owner is a rollout
 * key; any other value is a thread id written by the previous (parser version 2)
 * scanner, whose rows could not be attributed to a rollout.
 *
 * In ONE transaction the rollout's previous rows are deleted and the new ones
 * written, and the previous scanner's rows of the threads this rollout carried
 * (turn rows, deltas, cumulative marks) are retired because the rebuild now
 * counts them. Rows of any other owner are untouched.
 */
export interface RolloutUsageInput {
  readonly rolloutKey: string;
  readonly buckets: ReadonlyMap<string, CodexTokenCounters>;
  /** Thread ids whose previous-scanner rows this rebuild replaces. */
  readonly supersededThreads: readonly string[];
}

export function replaceRolloutUsage(db: Database.Database, input: RolloutUsageInput): void {
  assertCursorKey(input.rolloutKey);
  for (const [bucket, counters] of input.buckets) {
    assertBucket(bucket);
    assertCounters(counters);
  }
  for (const threadId of input.supersededThreads) assertIdentifier("thread id", threadId);
  const insert = db.prepare(
    `INSERT INTO codex_token_deltas
       (thread_id, bucket_start, input, cached_input, cache_write, output, reasoning_output, total)
     VALUES (@owner, @bucketStart, @input, @cachedInput, @cacheWrite, @output, @reasoningOutput, @total)`,
  );
  db.transaction(() => {
    db.prepare("DELETE FROM codex_token_deltas WHERE thread_id = ?").run(input.rolloutKey);
    for (const [bucketStart, c] of input.buckets) {
      if (COUNTER_KEYS.every((key) => c[key] === 0)) continue;
      insert.run({
        owner: input.rolloutKey,
        bucketStart,
        input: c.input,
        cachedInput: c.cachedInput,
        cacheWrite: c.cacheWrite,
        output: c.output,
        reasoningOutput: c.reasoningOutput,
        total: c.total,
      });
    }
    for (const threadId of new Set(input.supersededThreads)) {
      // A rollout key can never retire another rollout's rows.
      if (CURSOR_KEY_PATTERN.test(threadId)) continue;
      db.prepare("DELETE FROM codex_token_turns WHERE thread_id = ?").run(threadId);
      db.prepare("DELETE FROM codex_token_deltas WHERE thread_id = ?").run(threadId);
      db.prepare("DELETE FROM codex_token_cumulative WHERE thread_id = ?").run(threadId);
    }
  })();
}

/**
 * How many thread ids still own rows written by the previous scanner (turn rows
 * or non-rollout delta rows): usage no rebuild has replaced yet, either because
 * its rollout could not be read again or has not been reached.
 */
export function countLegacyUsageThreads(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT thread_id FROM codex_token_turns
         UNION
         SELECT thread_id FROM codex_token_deltas
          WHERE length(thread_id) <> 64 OR thread_id GLOB '*[^0-9a-f]*'
       )`,
    )
    .get() as { n: number };
  return row.n;
}

const ROLLOUT_TALLY_PREFIX = "codex_token_rtally:";

function parseTallies(text: string | null): Record<string, CodexRecognitionTally> {
  if (text === null) return {};
  try {
    const value = JSON.parse(text) as Record<string, { sessions?: unknown; recognized?: unknown }>;
    const out: Record<string, CodexRecognitionTally> = {};
    for (const [version, tally] of Object.entries(value)) {
      if (
        Number.isSafeInteger(tally.sessions) &&
        Number.isSafeInteger(tally.recognized) &&
        (tally.sessions as number) >= 0 &&
        (tally.recognized as number) >= 0
      ) {
        out[version] = {
          sessions: tally.sessions as number,
          recognized: tally.recognized as number,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** The recognition tally one rollout last contributed (per CLI version), or {} when none. */
export function readCodexRolloutTally(
  db: Database.Database,
  rolloutKey: string,
): Record<string, CodexRecognitionTally> {
  assertCursorKey(rolloutKey);
  return parseTallies(getCollectorSetting(db, `${ROLLOUT_TALLY_PREFIX}${rolloutKey}`));
}

/**
 * Replaces a rollout's contribution to the recognition tallies: the previous
 * contribution is subtracted and the new one added, in one transaction, so a
 * rollout that is re-read in full is never tallied twice.
 */
export function replaceCodexRolloutTally(
  db: Database.Database,
  parserVersion: number,
  rolloutKey: string,
  next: Readonly<Record<string, CodexRecognitionTally>>,
  at: string,
): void {
  assertCursorKey(rolloutKey);
  assertCount("parser version", parserVersion);
  for (const [cliVersion, tally] of Object.entries(next)) {
    assertIdentifier("CLI version", cliVersion);
    assertCount("sessions", tally.sessions);
    assertCount("recognized", tally.recognized);
  }
  db.transaction(() => {
    const previous = readCodexRolloutTally(db, rolloutKey);
    const stored = readCodexRecognition(db, parserVersion);
    const merged: Record<string, CodexRecognitionTally> = {};
    for (const version of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      const before = previous[version] ?? { sessions: 0, recognized: 0 };
      const after = next[version] ?? { sessions: 0, recognized: 0 };
      const known = stored[version] ?? { sessions: 0, recognized: 0 };
      merged[version] = {
        sessions: Math.max(0, known.sessions - before.sessions + after.sessions),
        recognized: Math.max(0, known.recognized - before.recognized + after.recognized),
      };
    }
    const write = db.prepare(
      `INSERT INTO codex_recognition (parser_version, cli_version, sessions, recognized, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (parser_version, cli_version) DO UPDATE SET
         sessions = excluded.sessions, recognized = excluded.recognized, updated_at = excluded.updated_at`,
    );
    for (const [version, tally] of Object.entries(merged)) {
      write.run(parserVersion, version, tally.sessions, tally.recognized, at);
    }
    setCollectorSetting(db, `${ROLLOUT_TALLY_PREFIX}${rolloutKey}`, JSON.stringify(next), at);
  })();
}

// --- Rollout cursors --------------------------------------------------------

/** A rollout scanner cursor. `inode` is text so a 64-bit inode survives. */
export interface CodexRolloutCursor {
  readonly inode: string;
  readonly size: number;
  readonly offset: number;
  /**
   * The file's modification time when the cursor was written, kept beside it (not
   * in the table, so no migration). A cursor without one is recomputed once.
   */
  readonly mtimeMs?: number;
}

const CURSOR_KEY_PATTERN = /^[0-9a-f]{64}$/;

/** A cursor key is a lowercase SHA-256 hex digest. Anything else (a path above all) is refused. */
function assertCursorKey(key: string): void {
  if (!CURSOR_KEY_PATTERN.test(key)) {
    throw new InvalidCodexRecordError("cursor key is not a 64-character lowercase hex digest");
  }
}

function assertCount(name: string, value: number): void {
  if (!(Number.isSafeInteger(value) && value >= 0)) {
    throw new InvalidCodexRecordError(`${name} is not a non-negative integer`);
  }
}

/**
 * The scanner cursor for a rollout, or null when it was never scanned. The key
 * is the SHA-256 hex of the rollout path, computed by the CALLER: this store
 * never receives or stores a path.
 */
export function readCodexCursor(db: Database.Database, key: string): CodexRolloutCursor | null {
  assertCursorKey(key);
  const row = db
    .prepare("SELECT inode, size, offset FROM codex_rollout_cursors WHERE cursor_key = ?")
    .get(key) as CodexRolloutCursor | undefined;
  return row ? { inode: row.inode, size: row.size, offset: row.offset } : null;
}

/** Stores the scanner cursor for a hashed rollout key, replacing the previous one. */
export function writeCodexCursor(
  db: Database.Database,
  key: string,
  cursor: CodexRolloutCursor,
  at: string,
): void {
  assertCursorKey(key);
  assertIdentifier("inode", cursor.inode);
  assertCount("size", cursor.size);
  assertCount("offset", cursor.offset);
  db.prepare(
    `INSERT INTO codex_rollout_cursors (cursor_key, inode, size, offset, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (cursor_key) DO UPDATE SET
       inode = excluded.inode, size = excluded.size, offset = excluded.offset, updated_at = excluded.updated_at`,
  ).run(key, cursor.inode, cursor.size, cursor.offset, at);
  // A fresh cursor means the rollout was just computed: it is no longer stale
  // and no longer an incomplete source.
  db.prepare("DELETE FROM collector_settings WHERE key = ?").run(CURSOR_STALE_PREFIX + key);
  db.prepare("DELETE FROM collector_settings WHERE key = ?").run(CURSOR_INCOMPLETE_PREFIX + key);
  if (cursor.mtimeMs === undefined || !Number.isFinite(cursor.mtimeMs)) {
    db.prepare("DELETE FROM collector_settings WHERE key = ?").run(CURSOR_MTIME_PREFIX + key);
  } else {
    setCollectorSetting(db, CURSOR_MTIME_PREFIX + key, String(cursor.mtimeMs), at);
  }
}

/** Prefix of the per-cursor "file modification time at the last complete read" setting. */
const CURSOR_MTIME_PREFIX = "codex_token_mtime:";

/** The modification time stored with the cursor, or null when it has none (an older cursor). */
export function readCodexCursorMtime(db: Database.Database, key: string): number | null {
  assertCursorKey(key);
  const row = db
    .prepare("SELECT value FROM collector_settings WHERE key = ?")
    .get(CURSOR_MTIME_PREFIX + key) as { value: string } | undefined;
  if (row === undefined) return null;
  const value = Number(row.value);
  return Number.isFinite(value) ? value : null;
}

/**
 * Marks a cursor stale: its rows and saved extent stay, but the rollout must be
 * recomputed the next time it can be read in full. Cleared by {@link writeCodexCursor}.
 */
export function markCodexCursorStale(db: Database.Database, key: string, at: string): void {
  assertCursorKey(key);
  setCollectorSetting(db, CURSOR_STALE_PREFIX + key, "1", at);
}

/**
 * Prefix of the per-rollout "latest rescan ended incomplete" marker. Set when a rollout
 * that may already be counted could not be fully read again (truncated, over the size
 * bound, refused); its counted rows stay. Cleared only by a full recompute
 * ({@link writeCodexCursor}) or by {@link clearCodexRolloutIncomplete} once the
 * rollout is verified unchanged. Named `codex_token_*` so "Delete cached usage
 * analytics" removes it.
 */
const CURSOR_INCOMPLETE_PREFIX = "codex_token_incomplete:";

/** Marks a rollout whose latest rescan could not complete; its counted rows stay. */
export function markCodexRolloutIncomplete(db: Database.Database, key: string, at: string): void {
  assertCursorKey(key);
  setCollectorSetting(db, CURSOR_INCOMPLETE_PREFIX + key, "1", at);
}

/** Clears the incomplete mark of one rollout (a verified-unchanged read). */
export function clearCodexRolloutIncomplete(db: Database.Database, key: string): void {
  assertCursorKey(key);
  db.prepare("DELETE FROM collector_settings WHERE key = ?").run(CURSOR_INCOMPLETE_PREFIX + key);
}

/** True while any rollout's latest rescan is outstanding-incomplete. */
export function hasCodexIncompleteRollouts(db: Database.Database): boolean {
  return (
    db
      .prepare("SELECT 1 FROM collector_settings WHERE key GLOB 'codex_token_incomplete:*' LIMIT 1")
      .get() !== undefined
  );
}

// --- Coverage ---------------------------------------------------------------

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function dayToMs(day: string): number {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (!DAY_PATTERN.test(day) || Number.isNaN(ms)) return Number.NaN;
  return ms;
}

/** The UTC calendar date of an ISO instant: the default day function. */
function utcDayOf(iso: string): string {
  return new Date(Date.parse(iso)).toISOString().slice(0, 10);
}

/** Records that a Codex scan covered `day` (a calendar date). The first record's time is kept. */
export function markCodexDayCovered(db: Database.Database, day: string, at: string): void {
  if (Number.isNaN(dayToMs(day))) {
    throw new InvalidCodexRecordError("day is not a YYYY-MM-DD calendar date");
  }
  db.prepare(
    "INSERT INTO codex_coverage_days (day, recorded_at) VALUES (?, ?) ON CONFLICT (day) DO NOTHING",
  ).run(day, at);
}

/**
 * Classifies every day from `fromDay` to `toDay` inclusive with the same
 * precedence as the Claude ledger: before the horizon, then analysis off (the
 * shared toggle log: one toggle governs both agents, D-17), then covered by a
 * Codex scan, otherwise not-scanned. Only the covered days live in this store.
 */
export function queryCodexCoverage(
  db: Database.Database,
  fromDay: string,
  toDay: string,
  horizonDate: string | null = null,
  toggleLog: readonly AnalysisToggle[] = [],
  dayOf: (iso: string) => string = utcDayOf,
): CoverageDay[] {
  const fromMs = dayToMs(fromDay);
  const toMs = dayToMs(toDay);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    throw new RangeError(`"${fromDay}" to "${toDay}" is not a YYYY-MM-DD calendar date range`);
  }
  const covered = new Set(
    (
      db
        .prepare("SELECT day FROM codex_coverage_days WHERE day >= ? AND day <= ?")
        .all(fromDay, toDay) as Array<{ day: string }>
    ).map((row) => row.day),
  );
  const toggles = [...toggleLog]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((toggle) => ({ day: dayOf(toggle.at), enabled: toggle.enabled }));

  const days: CoverageDay[] = [];
  for (let ms = fromMs; ms <= toMs; ms += DAY_MS) {
    const day = new Date(ms).toISOString().slice(0, 10);
    const enabledAtStart = toggles.filter((toggle) => toggle.day < day).at(-1)?.enabled ?? true;
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

// --- The last rate-limit snapshot ------------------------------------------

/**
 * Stores the last normalised rate-limit snapshot in the single row, replacing the
 * previous one. The snapshot is validated against the domain schema first, which
 * has no account member and a strict unavailable variant, so an account id or a
 * numeric member on the unavailable variant can never be written.
 */
export function saveRateLimitSnapshot(
  db: Database.Database,
  snapshot: CodexUsageSnapshot,
  observedAt: string,
): void {
  const parsed = CodexUsageSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new InvalidCodexRecordError("rate-limit snapshot does not match the domain schema");
  }
  db.prepare(
    `INSERT INTO codex_rate_limit_snapshot (id, snapshot_json, observed_at) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       snapshot_json = excluded.snapshot_json, observed_at = excluded.observed_at`,
  ).run(JSON.stringify(parsed.data), observedAt);
}

/**
 * The last stored snapshot, re-validated against the domain schema, or null when
 * there is none, the stored text is not JSON, or it no longer matches the schema.
 * The headroom service treats null as "no snapshot".
 */
export function loadRateLimitSnapshot(db: Database.Database): CodexUsageSnapshot | null {
  const row = db
    .prepare("SELECT snapshot_json FROM codex_rate_limit_snapshot WHERE id = 1")
    .get() as { snapshot_json: string } | undefined;
  if (!row) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.snapshot_json);
  } catch {
    return null;
  }
  const parsed = CodexUsageSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// --- Recognition tallies ----------------------------------------------------

/** One Codex CLI version's recognition tally. */
export interface CodexRecognitionTally {
  readonly sessions: number;
  readonly recognized: number;
}

/**
 * Adds per-CLI-version recognition tallies for one parser version. The scanner
 * calls it in the same transaction that advances the cursor over the chunk those
 * tallies came from, so a chunk is tallied once. All-zero tallies write nothing.
 */
export function addCodexRecognition(
  db: Database.Database,
  parserVersion: number,
  byVersion: Readonly<Record<string, CodexRecognitionTally>>,
  at: string,
): void {
  assertCount("parser version", parserVersion);
  for (const [cliVersion, tally] of Object.entries(byVersion)) {
    assertIdentifier("CLI version", cliVersion);
    assertCount("sessions", tally.sessions);
    assertCount("recognized", tally.recognized);
  }
  const add = db.prepare(
    `INSERT INTO codex_recognition (parser_version, cli_version, sessions, recognized, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (parser_version, cli_version) DO UPDATE SET
       sessions = sessions + excluded.sessions,
       recognized = recognized + excluded.recognized,
       updated_at = excluded.updated_at`,
  );
  db.transaction(() => {
    for (const [cliVersion, tally] of Object.entries(byVersion)) {
      if (tally.sessions === 0 && tally.recognized === 0) continue;
      add.run(parserVersion, cliVersion, tally.sessions, tally.recognized, at);
    }
  })();
}

/** Every CLI version's tally for one parser version. */
export function readCodexRecognition(
  db: Database.Database,
  parserVersion: number,
): Record<string, CodexRecognitionTally> {
  const rows = db
    .prepare(
      "SELECT cli_version, sessions, recognized FROM codex_recognition WHERE parser_version = ? ORDER BY cli_version",
    )
    .all(parserVersion) as Array<{ cli_version: string; sessions: number; recognized: number }>;
  return Object.fromEntries(
    rows.map((row) => [row.cli_version, { sessions: row.sessions, recognized: row.recognized }]),
  );
}

// --- Reset and delete -------------------------------------------------------

/**
 * Starts Codex scanning over for a new parser version: drops every cursor, the
 * coverage ledger and every recognition tally in one transaction. It never
 * clears the counted rows or `codex_token_cumulative`: the high-water marks are
 * what stop the rescan from counting previous usage again.
 */
export function resetCodexScanState(db: Database.Database): void {
  db.transaction(() => {
    db.prepare("DELETE FROM codex_rollout_cursors").run();
    db.prepare("DELETE FROM collector_settings WHERE key GLOB 'codex_token_stale:*'").run();
    db.prepare("DELETE FROM collector_settings WHERE key GLOB 'codex_token_mtime:*'").run();
    db.prepare("DELETE FROM collector_settings WHERE key GLOB 'codex_token_incomplete:*'").run();
    db.prepare("DELETE FROM codex_coverage_days").run();
    db.prepare("DELETE FROM codex_recognition").run();
  })();
}

/** Prefix of the per-cursor "computed under an older parser" marker (collector_settings). */
const CURSOR_STALE_PREFIX = "codex_token_stale:";

/**
 * True when the rollout's counted rows were computed under an older parser
 * version: its cursor (and the read extent in it) is kept, but the scanner must
 * recompute it even when the file size matches. Cleared by {@link writeCodexCursor}.
 */
export function isCodexCursorStale(db: Database.Database, key: string): boolean {
  assertCursorKey(key);
  return (
    db.prepare("SELECT 1 FROM collector_settings WHERE key = ?").get(CURSOR_STALE_PREFIX + key) !==
    undefined
  );
}

/**
 * Prepares a parser-version change WITHOUT touching a single counted row. KEEPS
 * the cursors (each holds the extent last read in full, which the shrink and
 * recreation guard compares against, so a rollout already truncated before the
 * upgrade keeps its rows) and marks each one stale so the sweep recomputes every
 * rollout. Drops recognition tallies (they belong to a parser version) and the derived state the previous counting
 * rule kept (per-turn precedence settings, per-thread cumulative marks, per-rollout
 * tallies). Counted rows, the coverage ledger and the horizon stay: they are
 * replaced rollout by rollout ({@link replaceRolloutUsage}) only when a rollout
 * is read again, so usage whose rollout was deleted or aged out of the listing
 * survives the upgrade.
 */
export function prepareCodexParserUpgrade(db: Database.Database): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO collector_settings (key, value, updated_at)
       SELECT ? || cursor_key, '1', updated_at FROM codex_rollout_cursors WHERE true
       ON CONFLICT(key) DO NOTHING`,
    ).run(CURSOR_STALE_PREFIX);
    db.prepare("DELETE FROM codex_recognition").run();
    db.prepare("DELETE FROM codex_token_cumulative").run();
    db.prepare(
      `DELETE FROM collector_settings
        WHERE key GLOB 'codex_token_turn:*' OR key GLOB 'codex_token_cumat:*'
           OR key GLOB 'codex_token_rtally:*'`,
    ).run();
  })();
}

/**
 * Empties everything the Codex token scanner COUNTED, plus the scan state
 * ({@link resetCodexScanState}): counted rows, deltas, cumulative high-water
 * marks and the scanner's derived per-turn / per-thread settings. Used when the
 * parser version changes, so totals are rebuilt from scratch under the new
 * counting rule. The parser-version marker, the rate-limit snapshot and every
 * setting outside the derived families are untouched.
 */
export function resetCodexCountingState(db: Database.Database): void {
  db.transaction(() => {
    resetCodexScanState(db);
    db.prepare("DELETE FROM codex_token_turns").run();
    db.prepare("DELETE FROM codex_token_deltas").run();
    db.prepare("DELETE FROM codex_token_cumulative").run();
    db.prepare(
      "DELETE FROM collector_settings WHERE key GLOB 'codex_token_turn:*' OR key GLOB 'codex_token_cumat:*'",
    ).run();
  })();
}

/**
 * The tables "Delete cached usage analytics" empties for Codex (D-17): the
 * counted rows, the high-water marks, cursors, coverage, recognition and the
 * last rate-limit snapshot. The Phase 5 private list in `usage-store.ts` is not
 * edited; {@link deleteAllUsageAnalytics} runs both in one transaction.
 */
export const CODEX_ANALYTICS_TABLES = [
  "codex_token_turns",
  "codex_token_deltas",
  "codex_token_cumulative",
  "codex_rollout_cursors",
  "codex_coverage_days",
  "codex_recognition",
  "codex_rate_limit_snapshot",
] as const;

/**
 * Empties the Codex analytics tables in one transaction. Clearing the
 * high-water marks together with the counted rows is what lets a later rescan
 * from zero rebuild identical aggregates.
 */
export function deleteCodexAnalytics(db: Database.Database): void {
  db.transaction(() => {
    for (const table of CODEX_ANALYTICS_TABLES) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    // The scanner also keeps usage-derived state in collector_settings (per-turn
    // analysis-off marks and thread/turn ids, per-thread transition cuts, the
    // coverage horizon and first-scan flag). All of it goes with the counted rows;
    // settings outside the `codex_token_` family are the owner's and stay, and so
    // does the parser-version marker (pure configuration, no usage in it).
    db.prepare(
      "DELETE FROM collector_settings WHERE key GLOB 'codex_token_*' AND key <> 'codex_token_parser_version'",
    ).run();
  })();
}

/**
 * Empties the Claude usage tables and the Codex tables in ONE transaction
 * (D-17, Pitfall 13): if any delete fails everything is as it was. Runs,
 * session overrides, collector settings and the toggle log are untouched.
 */
export function deleteAllUsageAnalytics(db: Database.Database): void {
  db.transaction(() => {
    deleteUsageAnalytics(db);
    deleteCodexAnalytics(db);
  })();
}
