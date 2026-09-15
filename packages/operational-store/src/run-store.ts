import type { ProjectId, RunId, RunState } from "@ccc/domain";
import type Database from "better-sqlite3";

/** A Run's supertype (Session or Automation Run, CONTEXT.md). */
export type RunKind = "session" | "automation";

/**
 * The `runs` table's full row shape, per `packages/operational-store/src/schema.ts`.
 * Broader than `@ccc/domain`'s `Run` interface (plan 01-01), which the
 * walking skeleton never extended past `runId`/`state`/`startedAt`/
 * `endedAt` — `kind`, `projectId`, `claudeSessionId`, and `lastActivityAt`
 * are modeled here rather than added to the domain package, since nothing
 * outside the operational store needs them yet.
 */
export interface RunRecord {
  readonly runId: RunId;
  readonly kind: RunKind;
  readonly projectId: ProjectId | null;
  readonly claudeSessionId: string | null;
  readonly state: RunState;
  readonly startedAt: string;
  readonly lastActivityAt: string | null;
  readonly endedAt: string | null;
}

/**
 * Mirrors `RunState` (`packages/domain/src/run.ts`) at runtime.
 * TypeScript's union type has no runtime representation, so a value
 * crossing into this module from outside the compiler's view (an HTTP
 * body, a stored row) is checked against this list before it ever reaches
 * a prepared statement.
 */
const RUN_STATES: readonly RunState[] = [
  "queued",
  "starting",
  "running",
  "waiting-for-approval",
  "completed",
  "failed",
  "cancelled",
  "stale",
];

/** The four states `listNonTerminalRuns` returns — CONTEXT.md's Run lifecycle, minus its four terminal members. */
const NON_TERMINAL_STATES: readonly RunState[] = [
  "queued",
  "starting",
  "running",
  "waiting-for-approval",
];

/** Thrown by {@link insertRun} / {@link updateRunState} when `state` is not one of the eight `RunState` members. */
export class InvalidRunStateError extends Error {
  constructor(value: string) {
    super(`"${value}" is not a valid RunState`);
    this.name = "InvalidRunStateError";
  }
}

function assertValidRunState(state: string): asserts state is RunState {
  if (!RUN_STATES.includes(state as RunState)) {
    throw new InvalidRunStateError(state);
  }
}

interface RunRow {
  run_id: string;
  kind: string;
  project_id: string | null;
  claude_session_id: string | null;
  state: string;
  started_at: string;
  last_activity_at: string | null;
  ended_at: string | null;
}

function rowToRecord(row: RunRow): RunRecord {
  return {
    runId: row.run_id as RunId,
    kind: row.kind as RunKind,
    projectId: row.project_id as ProjectId | null,
    claudeSessionId: row.claude_session_id,
    state: row.state as RunState,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    endedAt: row.ended_at,
  };
}

/** Inserts a new Run row. Validates `run.state` against {@link RUN_STATES} before the statement ever runs, per SVC-11's correctness requirement that an invalid state must never reach the store. */
export function insertRun(db: Database.Database, run: RunRecord): void {
  assertValidRunState(run.state);
  db.prepare(
    `INSERT INTO runs (run_id, kind, project_id, claude_session_id, state, started_at, last_activity_at, ended_at)
     VALUES (@runId, @kind, @projectId, @claudeSessionId, @state, @startedAt, @lastActivityAt, @endedAt)`,
  ).run({
    runId: run.runId,
    kind: run.kind,
    projectId: run.projectId,
    claudeSessionId: run.claudeSessionId,
    state: run.state,
    startedAt: run.startedAt,
    lastActivityAt: run.lastActivityAt,
    endedAt: run.endedAt,
  });
}

/** Reads back a Run by ID, or `null` if no such run exists. */
export function getRun(db: Database.Database, runId: RunId): RunRecord | null {
  const row = db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * Updates only a Run's `state` column. Deliberately does not touch
 * `ended_at` — the caller that observes an actual ending is responsible
 * for recording it; restart recovery (`recoverInterruptedRuns`,
 * `packages/service/src/lifecycle/recover-runs.ts`) relies on this to move
 * a Run to `stale` while leaving `ended_at` exactly as it was (null, since
 * the ending was never observed).
 */
export function updateRunState(db: Database.Database, runId: RunId, state: RunState): void {
  assertValidRunState(state);
  db.prepare("UPDATE runs SET state = ? WHERE run_id = ?").run(state, runId);
}

/** Every Run whose state is one of the four non-terminal members — the query restart recovery consumes on every service start. */
export function listNonTerminalRuns(db: Database.Database): RunRecord[] {
  const placeholders = NON_TERMINAL_STATES.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT * FROM runs WHERE state IN (${placeholders})`)
    .all(...NON_TERMINAL_STATES) as RunRow[];
  return rows.map(rowToRecord);
}

/** Every persisted Run, most recently started first — the source `GET /api/v1/runs` reads from so reconciliation is observable from the plugin, not only from the log. */
export function listAllRuns(db: Database.Database): RunRecord[] {
  const rows = db.prepare("SELECT * FROM runs ORDER BY started_at DESC").all() as RunRow[];
  return rows.map(rowToRecord);
}
