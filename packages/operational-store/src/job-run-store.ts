import {
  JOB_RUN_OUTCOMES,
  type JobRunOutcome,
  NOTE_ID_PATTERN,
  RESEARCH_STAGES,
  type ResearchStage,
  RUN_ERROR_CODES,
  RUN_ID_PATTERN,
  type RunErrorCode,
  type RunId,
  type RunState,
  SOURCE_FAILURE_CODES,
  SOURCE_ID_PATTERN,
  type SourceFailureCode,
} from "@ccc/domain";
import type Database from "better-sqlite3";
import { insertRun } from "./run-store.js";

/**
 * The durable record of a research run (RSRCH-06, DIAG-05, D-18): one `job_runs`
 * row paired with one `runs` row of kind `automation`, both keyed by the same run
 * id and always written in one transaction.
 *
 * **The record is content-free (research Pitfall 8, T-07-15).** Every value this
 * module writes is a run id, a note id, a source id, a member of a closed
 * vocabulary, a small integer or an ISO instant. Each input is checked against
 * those shapes before any statement runs, so fetched text, titles, URLs, model
 * output and remote error strings cannot reach the table through this module;
 * `migration-research.audit.test.ts` asserts it.
 *
 * **One run in flight per job key (D-19, T-07-16).** `startJobRun` looks for an
 * in-flight row first and answers it, inside a BEGIN IMMEDIATE transaction so two
 * connections cannot both pass the check. The partial unique index
 * `job_runs_one_inflight_per_job` is the crash-safe backstop for a lookup that
 * misses.
 *
 * **Interrupted work is stale, never failed (SVC-11).** Nothing here writes a
 * terminal state except `finishJobRun`, which the pipeline calls with an outcome
 * it observed. Startup recovery uses `recoverJobRunsToStale`.
 */

/** What started a job run. Mirrors `JOB_RUN_TRIGGERS` in `@ccc/scheduler`, which this package may not import. */
export const JOB_RUN_TRIGGERS = ["manual", "scheduled"] as const;
export type JobRunTrigger = (typeof JOB_RUN_TRIGGERS)[number];

/** The `job_runs.state` values that count as in flight; the partial unique index covers exactly these. */
const IN_FLIGHT_STATES = ["queued", "starting", "running"] as const;

/** The states recovery moves to stale: the in-flight three plus the Run state a waiting run would carry. */
const NON_TERMINAL_JOB_RUN_STATES = [...IN_FLIGHT_STATES, "waiting-for-approval"] as const;

/** Run ids bound per statement, well under SQLite's variable limit. */
const RECOVERY_CHUNK = 500;

export interface StartJobRunInput {
  readonly jobRunId: RunId;
  readonly jobKey: string;
  readonly idempotencyKey: string;
  readonly trigger: JobRunTrigger;
  readonly startedAt: string;
  /** Defaults to `startedAt`, which is what a manual run records (ADR 0029). */
  readonly scheduledFor?: string;
}

export type StartJobRunResult =
  | { readonly started: true }
  | { readonly started: false; readonly inFlightRunId: RunId }
  /** The idempotency key belongs to an earlier, finished or stale run: this slot already ran. */
  | { readonly started: false; readonly reason: "duplicate-key" };

export interface JobRunStageEntry {
  readonly stage: ResearchStage;
  readonly at: string;
  readonly noteIds: readonly string[];
  /** Integers only, for example items by kind. */
  readonly counts?: Readonly<Record<string, number>>;
}

export interface UnavailableSource {
  readonly sourceId: string;
  readonly code: SourceFailureCode;
}

export interface FinishJobRunInput {
  readonly outcome: JobRunOutcome;
  readonly endedAt: string;
  readonly sourceCount: number;
  readonly sourceTotal: number;
  readonly reportNoteId: string | null;
  readonly unavailableSources: readonly UnavailableSource[];
  readonly errorCode: RunErrorCode | null;
}

/** Thrown before any write when an input is outside the content-free shapes this module accepts. */
export class JobRunValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobRunValidationError";
  }
}

/** Thrown when a stage or finish names a job run that does not exist. */
export class JobRunNotFoundError extends Error {
  constructor(jobRunId: string) {
    super(`no job run ${jobRunId}`);
    this.name = "JobRunNotFoundError";
  }
}

/** Thrown when a stage or finish targets a job run that is no longer in flight (finished, failed or stale). */
export class JobRunNotInFlightError extends Error {
  constructor(jobRunId: string, state: string) {
    super(`job run ${jobRunId} is ${state}, not in flight`);
    this.name = "JobRunNotInFlightError";
  }
}

// ---------------------------------------------------------------------------
// Validation (every shape is a closed pattern or vocabulary)

const JOB_KEY_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:@/+-]{1,200}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const COUNT_KEY_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/** Bounds that keep one record small: the pipeline has six stages and a handful of sources. */
export const MAX_STAGE_LOG_ENTRIES = 64;
export const MAX_NOTE_IDS_PER_STAGE = 200;
export const MAX_COUNT_KEYS_PER_STAGE = 16;
export const MAX_UNAVAILABLE_SOURCES = 100;
const MAX_COUNT = 1_000_000;

function fail(message: string): never {
  throw new JobRunValidationError(message);
}

function assertRunId(value: unknown, label: string): asserts value is RunId {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) fail(`${label} is not a run id`);
}

function assertInstant(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !ISO_INSTANT_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    fail(`${label} is not an ISO instant`);
  }
}

function assertCount(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) {
    fail(`${label} is not a small non-negative integer`);
  }
}

function assertNoteId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !NOTE_ID_PATTERN.test(value)) fail(`${label} is not a note id`);
}

function isMember<T extends string>(vocabulary: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (vocabulary as readonly string[]).includes(value);
}

/** Validates a stage log entry and returns the plain object that is stored. */
function checkStageEntry(entry: JobRunStageEntry): JobRunStageEntry {
  if (!isMember(RESEARCH_STAGES, entry.stage)) fail("stage is not a research stage");
  assertInstant(entry.at, "stage time");
  if (!Array.isArray(entry.noteIds) || entry.noteIds.length > MAX_NOTE_IDS_PER_STAGE) {
    fail("noteIds is not a bounded array");
  }
  for (const id of entry.noteIds) assertNoteId(id, "noteIds entry");
  const stored: {
    stage: ResearchStage;
    at: string;
    noteIds: string[];
    counts?: Record<string, number>;
  } = { stage: entry.stage, at: entry.at, noteIds: [...entry.noteIds] };
  if (entry.counts !== undefined) {
    if (typeof entry.counts !== "object" || entry.counts === null || Array.isArray(entry.counts)) {
      fail("counts is not a record");
    }
    const keys = Object.keys(entry.counts);
    if (keys.length > MAX_COUNT_KEYS_PER_STAGE) fail("counts has too many keys");
    const counts: Record<string, number> = {};
    for (const key of keys) {
      if (!COUNT_KEY_PATTERN.test(key)) fail("counts key is not a plain token");
      const value = entry.counts[key];
      assertCount(value, `counts.${key}`);
      counts[key] = value;
    }
    stored.counts = counts;
  }
  return stored;
}

function checkUnavailableSources(list: readonly UnavailableSource[]): UnavailableSource[] {
  if (!Array.isArray(list) || list.length > MAX_UNAVAILABLE_SOURCES) {
    fail("unavailableSources is not a bounded array");
  }
  return list.map((item) => {
    if (typeof item?.sourceId !== "string" || !SOURCE_ID_PATTERN.test(item.sourceId)) {
      fail("unavailable source id is not a source id");
    }
    if (!isMember(SOURCE_FAILURE_CODES, item.code)) fail("unavailable source code is not closed");
    return { sourceId: item.sourceId, code: item.code };
  });
}

// ---------------------------------------------------------------------------
// Writes

function selectInFlightRunId(db: Database.Database, jobKey: string): RunId | null {
  const placeholders = IN_FLIGHT_STATES.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT job_run_id FROM job_runs WHERE job_key = ? AND state IN (${placeholders}) ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(jobKey, ...IN_FLIGHT_STATES) as { job_run_id: string } | undefined;
  return row ? (row.job_run_id as RunId) : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

function idempotencyKeyUsed(db: Database.Database, idempotencyKey: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS used FROM job_runs WHERE idempotency_key = ? LIMIT 1")
      .get(idempotencyKey) !== undefined
  );
}

/**
 * Starts a job run: inserts its `job_runs` row (state running) and the paired
 * `runs` row (kind automation, state running, same id) in one immediate
 * transaction. When a run for the same job key is already in flight, nothing is
 * inserted and that run's id is returned (D-19). When the idempotency key already belongs to an
 * earlier run (finished or stale), nothing is inserted and `reason: "duplicate-key"` is returned.
 */
export function startJobRun(db: Database.Database, input: StartJobRunInput): StartJobRunResult {
  assertRunId(input.jobRunId, "jobRunId");
  if (typeof input.jobKey !== "string" || !JOB_KEY_PATTERN.test(input.jobKey)) {
    fail("jobKey is not a plain job id");
  }
  if (
    typeof input.idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)
  ) {
    fail("idempotencyKey is not a plain key");
  }
  if (!isMember(JOB_RUN_TRIGGERS, input.trigger)) fail("trigger is not a job run trigger");
  assertInstant(input.startedAt, "startedAt");
  const scheduledFor = input.scheduledFor ?? input.startedAt;
  assertInstant(scheduledFor, "scheduledFor");

  const start = db.transaction((): StartJobRunResult => {
    const inFlight = selectInFlightRunId(db, input.jobKey);
    if (inFlight !== null) return { started: false, inFlightRunId: inFlight };
    if (idempotencyKeyUsed(db, input.idempotencyKey)) {
      return { started: false, reason: "duplicate-key" };
    }
    db.prepare(
      `INSERT INTO job_runs (job_run_id, job_key, scheduled_for, started_at, state, idempotency_key, run_trigger)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    ).run(
      input.jobRunId,
      input.jobKey,
      scheduledFor,
      input.startedAt,
      input.idempotencyKey,
      input.trigger,
    );
    insertRun(db, {
      runId: input.jobRunId,
      kind: "automation",
      projectId: null,
      claudeSessionId: null,
      state: "running",
      startedAt: input.startedAt,
      lastActivityAt: null,
      endedAt: null,
    });
    return { started: true };
  });

  try {
    return start.immediate();
  } catch (error) {
    // The select-first lookup missed a row a concurrent writer committed: the partial unique
    // index (or the idempotency key's unique constraint) refused the insert. Answer what the
    // winner left. Any other constraint failure (a reused run id, say) is a real error.
    if (isUniqueViolation(error)) {
      const inFlight = selectInFlightRunId(db, input.jobKey);
      if (inFlight !== null) return { started: false, inFlightRunId: inFlight };
      if (idempotencyKeyUsed(db, input.idempotencyKey)) {
        return { started: false, reason: "duplicate-key" };
      }
    }
    throw error;
  }
}

function readState(
  db: Database.Database,
  jobRunId: RunId,
  jobKey?: string,
): { state: string; stage_log: string | null } {
  const row = db
    .prepare("SELECT state, stage_log, job_key FROM job_runs WHERE job_run_id = ?")
    .get(jobRunId) as { state: string; stage_log: string | null; job_key: string } | undefined;
  // A run of another job is, for a caller that asks about one job, a run that does not exist.
  if (!row || (jobKey !== undefined && row.job_key !== jobKey)) {
    throw new JobRunNotFoundError(jobRunId);
  }
  if (!(IN_FLIGHT_STATES as readonly string[]).includes(row.state)) {
    throw new JobRunNotInFlightError(jobRunId, row.state);
  }
  return row;
}

/**
 * Throws {@link JobRunNotFoundError} when no run of the job `jobKey` has this id (a run of another
 * job counts as absent) and {@link JobRunNotInFlightError} when it is finished, failed or stale. For
 * writers (the research provenance records) that may only leave a trace for a run of their own job
 * that is still working: a record for a finished, unknown or foreign run would be a record nobody
 * produced. The job key is required so no caller can ask about a run without saying whose it is.
 */
export function assertJobRunInFlight(
  db: Database.Database,
  jobRunId: string,
  jobKey: string,
): void {
  assertRunId(jobRunId, "jobRunId");
  readState(db, jobRunId, jobKey);
}

/**
 * Appends one stage transition to the run's `stage_log` and records the time as the
 * paired Run's last activity. The run must be in flight: appending to a finished or
 * stale run would falsify its history.
 */
export function appendJobRunStage(
  db: Database.Database,
  jobRunId: RunId,
  entry: JobRunStageEntry,
): void {
  assertRunId(jobRunId, "jobRunId");
  const stored = checkStageEntry(entry);
  db.transaction(() => {
    const row = readState(db, jobRunId);
    let log: unknown[] = [];
    if (row.stage_log !== null) {
      const parsed: unknown = JSON.parse(row.stage_log);
      if (!Array.isArray(parsed)) fail("stored stage_log is not an array");
      log = parsed;
    }
    if (log.length >= MAX_STAGE_LOG_ENTRIES) fail("stage_log is full");
    log.push(stored);
    db.prepare("UPDATE job_runs SET stage_log = ? WHERE job_run_id = ?").run(
      JSON.stringify(log),
      jobRunId,
    );
    db.prepare("UPDATE runs SET last_activity_at = ? WHERE run_id = ?").run(stored.at, jobRunId);
  }).immediate();
}

/**
 * Finishes a run: `job_runs` becomes completed (outcome success or partial) or failed
 * (outcome failure) with the counts, source ids with codes and report note id, and the
 * paired `runs` row follows with its `ended_at`, all in one transaction (D-12, D-18).
 */
export function finishJobRun(
  db: Database.Database,
  jobRunId: RunId,
  input: FinishJobRunInput,
): void {
  assertRunId(jobRunId, "jobRunId");
  if (!isMember(JOB_RUN_OUTCOMES, input.outcome)) fail("outcome is not a job run outcome");
  assertInstant(input.endedAt, "endedAt");
  assertCount(input.sourceCount, "sourceCount");
  assertCount(input.sourceTotal, "sourceTotal");
  if (input.sourceCount > input.sourceTotal) fail("sourceCount exceeds sourceTotal");
  if (input.errorCode !== null && !isMember(RUN_ERROR_CODES, input.errorCode)) {
    fail("errorCode is not a run error code");
  }
  if (input.outcome === "failure" && input.errorCode === null) fail("a failure needs an errorCode");
  if (input.outcome === "success" && input.errorCode !== null) {
    fail("a success carries no errorCode");
  }
  if (input.reportNoteId !== null) assertNoteId(input.reportNoteId, "reportNoteId");
  const unavailable = checkUnavailableSources(input.unavailableSources);
  const state = input.outcome === "failure" ? "failed" : "completed";

  db.transaction(() => {
    readState(db, jobRunId);
    db.prepare(
      `UPDATE job_runs SET state = ?, ended_at = ?, outcome = ?, error_code = ?, report_note_id = ?,
         source_count = ?, source_total = ?, unavailable_sources = ?
       WHERE job_run_id = ?`,
    ).run(
      state,
      input.endedAt,
      input.outcome,
      input.errorCode,
      input.reportNoteId,
      input.sourceCount,
      input.sourceTotal,
      JSON.stringify(unavailable),
      jobRunId,
    );
    db.prepare(
      "UPDATE runs SET state = ?, ended_at = ?, last_activity_at = ? WHERE run_id = ?",
    ).run(state, input.endedAt, input.endedAt, jobRunId);
  }).immediate();
}

// ---------------------------------------------------------------------------
// Reads (DIAG-05, UI-SPEC R2, R-05, R-06)

/** One job run as the status view and the list read it. */
export interface JobRunRecord {
  readonly jobRunId: RunId;
  readonly jobKey: string;
  readonly trigger: JobRunTrigger | null;
  readonly state: RunState;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly outcome: JobRunOutcome | null;
  readonly errorCode: RunErrorCode | null;
  readonly reportNoteId: string | null;
  readonly sourceCount: number | null;
  readonly sourceTotal: number | null;
  readonly unavailableSources: readonly UnavailableSource[];
  readonly stageLog: readonly JobRunStageEntry[];
  /** The stage of the last stage-log entry, or null before the first transition. */
  readonly latestStage: ResearchStage | null;
}

export interface ResearchRunStatus {
  readonly lastSuccess: JobRunRecord | null;
  readonly lastFailure: JobRunRecord | null;
  readonly inFlight: JobRunRecord | null;
  readonly latestUnknown: JobRunRecord | null;
}

/** The largest page `listJobRuns` serves; the Research view pages beyond it with a cursor in a later plan. */
export const MAX_JOB_RUN_LIST_LIMIT = 200;

interface JobRunRow {
  job_run_id: string;
  job_key: string;
  started_at: string | null;
  state: string;
  ended_at: string | null;
  outcome: string | null;
  unavailable_sources: string | null;
  report_note_id: string | null;
  error_code: string | null;
  stage_log: string | null;
  source_count: number | null;
  source_total: number | null;
  run_trigger: string | null;
}

function parseArray(text: string | null): unknown[] {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Stored JSON is read back through the same shape checks the writers apply. A value that
 * fails them reads as empty rather than being passed on: the table holds nothing an
 * attacker chose, so this only matters for a hand-edited or corrupted file, and an empty
 * list is the honest "not recorded" answer (a stage is never invented).
 */
function readUnavailableSources(text: string | null): UnavailableSource[] {
  try {
    return checkUnavailableSources(parseArray(text) as UnavailableSource[]);
  } catch {
    return [];
  }
}

function readStageLog(text: string | null): JobRunStageEntry[] {
  try {
    return parseArray(text).map((entry) => checkStageEntry(entry as JobRunStageEntry));
  } catch {
    return [];
  }
}

function rowToRecord(row: JobRunRow): JobRunRecord {
  const stageLog = readStageLog(row.stage_log);
  return {
    jobRunId: row.job_run_id as RunId,
    jobKey: row.job_key,
    trigger: isMember(JOB_RUN_TRIGGERS, row.run_trigger) ? row.run_trigger : null,
    state: row.state as RunState,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: isMember(JOB_RUN_OUTCOMES, row.outcome) ? row.outcome : null,
    errorCode: isMember(RUN_ERROR_CODES, row.error_code) ? row.error_code : null,
    reportNoteId:
      row.report_note_id !== null && NOTE_ID_PATTERN.test(row.report_note_id)
        ? row.report_note_id
        : null,
    sourceCount: row.source_count,
    sourceTotal: row.source_total,
    unavailableSources: readUnavailableSources(row.unavailable_sources),
    stageLog,
    latestStage: stageLog.at(-1)?.stage ?? null,
  };
}

const NEWEST_FIRST = "ORDER BY started_at DESC, rowid DESC";

function newestWhere(
  db: Database.Database,
  jobKey: string,
  condition: string,
): JobRunRecord | null {
  const row = db
    .prepare(`SELECT * FROM job_runs WHERE job_key = ? AND ${condition} ${NEWEST_FIRST} LIMIT 1`)
    .get(jobKey) as JobRunRow | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * The DIAG-05 status query for one job:
 *
 * - `lastSuccess`: the newest run that completed with outcome success or partial (R-05).
 * - `lastFailure`: the newest run that failed with outcome failure. A stale run is never one.
 * - `inFlight`: the queued, starting or running run, with the stage of its last log entry.
 * - `latestUnknown`: the newest run of all, when it is stale (R-06). A stale run stops being
 *   a row of its own as soon as any later run exists, finished or running.
 *
 * "Newest" is by start time: the one-in-flight rule makes runs of one job strictly
 * sequential, so start order is end order. Each member is an object or null.
 */
export function getResearchRunStatus(db: Database.Database, jobKey: string): ResearchRunStatus {
  const inFlightList = IN_FLIGHT_STATES.map((state) => `'${state}'`).join(", ");
  const newest = newestWhere(db, jobKey, "1 = 1");
  return {
    lastSuccess: newestWhere(
      db,
      jobKey,
      "state = 'completed' AND outcome IN ('success', 'partial')",
    ),
    lastFailure: newestWhere(db, jobKey, "state = 'failed' AND outcome = 'failure'"),
    inFlight: newestWhere(db, jobKey, `state IN (${inFlightList})`),
    latestUnknown: newest !== null && newest.state === "stale" ? newest : null,
  };
}

/** The most recent runs of one job, newest first. `limit` is an integer from 1 to {@link MAX_JOB_RUN_LIST_LIMIT}. */
export function listJobRuns(db: Database.Database, jobKey: string, limit: number): JobRunRecord[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_JOB_RUN_LIST_LIMIT) {
    fail(`limit must be an integer from 1 to ${MAX_JOB_RUN_LIST_LIMIT}`);
  }
  const rows = db
    .prepare(`SELECT * FROM job_runs WHERE job_key = ? ${NEWEST_FIRST} LIMIT ?`)
    .all(jobKey, limit) as JobRunRow[];
  return rows.map(rowToRecord);
}

/**
 * One job run by its job key and its id, however old it is, or null. Not bounded by a recent-run
 * window: a report from months ago still gets its run record. The key is part of the lookup, so an
 * id that belongs to another job is not found.
 */
export function getJobRun(
  db: Database.Database,
  jobKey: string,
  jobRunId: string,
): JobRunRecord | null {
  const row = db
    .prepare("SELECT * FROM job_runs WHERE job_key = ? AND job_run_id = ?")
    .get(jobKey, jobRunId) as JobRunRow | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * Startup recovery's job-run write (SVC-11, D-18, research Pitfall 9): moves each named job run
 * that is still queued, starting, running or waiting to `stale`, leaving `outcome` and
 * `ended_at` exactly as they were (null, since the ending was never observed). Returns how many
 * rows changed; a run already stale or finished is not touched, so a second call changes nothing.
 * This writes exactly one state and never a terminal one. The caller moves the paired `runs`
 * rows in the same transaction.
 */
export function recoverJobRunsToStale(db: Database.Database, runIds: readonly string[]): number {
  const states = NON_TERMINAL_JOB_RUN_STATES.map(() => "?").join(", ");
  let changed = 0;
  db.transaction(() => {
    for (let at = 0; at < runIds.length; at += RECOVERY_CHUNK) {
      const chunk = runIds.slice(at, at + RECOVERY_CHUNK);
      const marks = chunk.map(() => "?").join(", ");
      changed += db
        .prepare(
          `UPDATE job_runs SET state = 'stale' WHERE job_run_id IN (${marks}) AND state IN (${states})`,
        )
        .run(...chunk, ...NON_TERMINAL_JOB_RUN_STATES).changes;
    }
  })();
  return changed;
}
