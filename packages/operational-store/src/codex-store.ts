import type { CodexTokenCounters, CodexUsageSnapshot } from "@ccc/domain";
import type Database from "better-sqlite3";
import { type AnalysisToggle, type CoverageDay, USAGE_BUCKET_MS } from "./usage-store.js";

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

// --- Task 3 signature stubs (RED) -------------------------------------------

/** A rollout scanner cursor. `inode` is text so a 64-bit inode survives. */
export interface CodexRolloutCursor {
  readonly inode: string;
  readonly size: number;
  readonly offset: number;
}

/** One Codex CLI version's recognition tally. */
export interface CodexRecognitionTally {
  readonly sessions: number;
  readonly recognized: number;
}

export const CODEX_ANALYTICS_TABLES = [] as const;

export function readCodexCursor(_db: Database.Database, _key: string): CodexRolloutCursor | null {
  throw new Error("not implemented");
}
export function writeCodexCursor(
  _db: Database.Database,
  _key: string,
  _cursor: CodexRolloutCursor,
  _at: string,
): void {
  throw new Error("not implemented");
}
export function markCodexDayCovered(_db: Database.Database, _day: string, _at: string): void {
  throw new Error("not implemented");
}
export function queryCodexCoverage(
  _db: Database.Database,
  _fromDay: string,
  _toDay: string,
  _horizonDate?: string | null,
  _toggleLog?: readonly AnalysisToggle[],
  _dayOf?: (iso: string) => string,
): CoverageDay[] {
  throw new Error("not implemented");
}
export function saveRateLimitSnapshot(
  _db: Database.Database,
  _snapshot: CodexUsageSnapshot,
  _observedAt: string,
): void {
  throw new Error("not implemented");
}
export function loadRateLimitSnapshot(_db: Database.Database): CodexUsageSnapshot | null {
  throw new Error("not implemented");
}
export function addCodexRecognition(
  _db: Database.Database,
  _parserVersion: number,
  _byVersion: Readonly<Record<string, CodexRecognitionTally>>,
  _at: string,
): void {
  throw new Error("not implemented");
}
export function readCodexRecognition(
  _db: Database.Database,
  _parserVersion: number,
): Record<string, CodexRecognitionTally> {
  throw new Error("not implemented");
}
export function resetCodexScanState(_db: Database.Database): void {
  throw new Error("not implemented");
}
export function deleteCodexAnalytics(_db: Database.Database): void {
  throw new Error("not implemented");
}
export function deleteAllUsageAnalytics(_db: Database.Database): void {
  throw new Error("not implemented");
}
