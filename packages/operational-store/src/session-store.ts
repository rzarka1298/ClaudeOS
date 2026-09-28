import type {
  LaunchSource,
  RunId,
  RunLinkKind,
  RunState,
  SessionActivity,
  SessionRun,
  StopFailureError,
} from "@ccc/domain";
import type Database from "better-sqlite3";
import { assertValidRunState } from "./run-store.js";

/**
 * Session Run persistence (Phase 5, D-21). The service is the only caller;
 * every function here takes typed values and runs a prepared statement, so
 * no service module writes SQL itself. Session Runs share the `runs` table
 * with automation Runs, distinguished by `kind = 'session'`; every query
 * here reads session rows only, and `run-store.ts`'s automation functions
 * (`insertRun`, `listNonTerminalRuns`) are untouched.
 */

/** The `runs` row as SQLite returns it, Phase 5 columns included. */
export interface SessionRunRow {
  run_id: string;
  kind: string;
  project_id: string | null;
  claude_session_id: string | null;
  state: string;
  started_at: string;
  last_activity_at: string | null;
  ended_at: string | null;
  pid: number | null;
  pid_started_at: string | null;
  revision: number | null;
  name: string | null;
  model: string | null;
  effort: string | null;
  launch_source: string | null;
  cwd: string | null;
  worktree_root: string | null;
  permission_mode: string | null;
  activity: string | null;
  last_error: string | null;
  claude_version: string | null;
  transcript_path: string | null;
  link_kind: string | null;
  linked_from_run_id: string | null;
  subagent_active_ids: string | null;
  subagent_last_type: string | null;
  terminate_requested_at: string | null;
  end_observed_at: string | null;
}

/** Thrown by {@link upsertSessionRun} when a Run's numeric facts are not safe integers. */
export class InvalidSessionRunError extends Error {
  constructor(field: string) {
    super(`SessionRun.${field} must be a non-negative safe integer`);
    this.name = "InvalidSessionRunError";
  }
}

/** A JSON array of strings, or empty when the stored text is absent or malformed. */
function parseIdList(raw: string | null): readonly string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The one mapping from a stored row to the shared {@link SessionRun}. The
 * branded and enum casts are confined here: the only writer is
 * {@link upsertSessionRun}, which stores values that were already typed.
 */
export function rowToSessionRun(row: SessionRunRow): SessionRun {
  return {
    runId: row.run_id as RunId,
    revision: row.revision ?? 0,
    claudeSessionId: row.claude_session_id,
    pid: row.pid,
    pidStartedAt: row.pid_started_at,
    state: row.state as RunState,
    activity: row.activity as SessionActivity | null,
    projectId: row.project_id,
    name: row.name,
    model: row.model,
    effort: row.effort,
    launchSource: row.launch_source as LaunchSource | null,
    cwd: row.cwd,
    worktreeRoot: row.worktree_root,
    permissionMode: row.permission_mode,
    lastError: row.last_error as StopFailureError | null,
    claudeVersion: row.claude_version,
    transcriptPath: row.transcript_path,
    linkKind: row.link_kind as RunLinkKind | null,
    linkedFromRunId: row.linked_from_run_id as RunId | null,
    subagentActiveIds: parseIdList(row.subagent_active_ids),
    subagentLastType: row.subagent_last_type,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    endedAt: row.ended_at,
    terminateRequestedAt: row.terminate_requested_at,
    endObservedAt: row.end_observed_at,
  };
}

function assertNonNegativeInteger(value: number | null, field: string): void {
  if (value !== null && !(Number.isSafeInteger(value) && value >= 0)) {
    throw new InvalidSessionRunError(field);
  }
}

/** Every Phase 5 column an upsert writes, besides `run_id` and `kind`. */
const UPSERT_COLUMNS = [
  "project_id",
  "claude_session_id",
  "state",
  "started_at",
  "last_activity_at",
  "ended_at",
  "pid",
  "pid_started_at",
  "revision",
  "name",
  "model",
  "effort",
  "launch_source",
  "cwd",
  "worktree_root",
  "permission_mode",
  "activity",
  "last_error",
  "claude_version",
  "transcript_path",
  "link_kind",
  "linked_from_run_id",
  "subagent_active_ids",
  "subagent_last_type",
  "terminate_requested_at",
  "end_observed_at",
] as const;

const UPSERT_SQL = `INSERT INTO runs (run_id, kind, ${UPSERT_COLUMNS.join(", ")})
  VALUES (@run_id, 'session', ${UPSERT_COLUMNS.map((column) => `@${column}`).join(", ")})
  ON CONFLICT(run_id) DO UPDATE SET ${UPSERT_COLUMNS.map((column) => `${column} = excluded.${column}`).join(", ")}`;

/**
 * Inserts or replaces a session Run by `runId`, with `kind` fixed to
 * `session`. The state is validated before the statement runs, as
 * `insertRun` does for automation Runs, so an invalid state never reaches
 * the store.
 */
export function upsertSessionRun(db: Database.Database, run: SessionRun): void {
  assertValidRunState(run.state);
  assertNonNegativeInteger(run.pid, "pid");
  assertNonNegativeInteger(run.revision, "revision");
  db.prepare(UPSERT_SQL).run({
    run_id: run.runId,
    project_id: run.projectId,
    claude_session_id: run.claudeSessionId,
    state: run.state,
    started_at: run.startedAt,
    last_activity_at: run.lastActivityAt,
    ended_at: run.endedAt,
    pid: run.pid,
    pid_started_at: run.pidStartedAt,
    revision: run.revision,
    name: run.name,
    model: run.model,
    effort: run.effort,
    launch_source: run.launchSource,
    cwd: run.cwd,
    worktree_root: run.worktreeRoot,
    permission_mode: run.permissionMode,
    activity: run.activity,
    last_error: run.lastError,
    claude_version: run.claudeVersion,
    transcript_path: run.transcriptPath,
    link_kind: run.linkKind,
    linked_from_run_id: run.linkedFromRunId,
    subagent_active_ids: JSON.stringify(run.subagentActiveIds),
    subagent_last_type: run.subagentLastType,
    terminate_requested_at: run.terminateRequestedAt,
    end_observed_at: run.endObservedAt,
  });
}

/** "Latest" everywhere in this module: most recently started, ties broken by insertion order. */
const LATEST_FIRST = "ORDER BY started_at DESC, rowid DESC";

/** A session Run by ID, or null (an automation Run with that ID is not a session). */
export function getSessionRun(db: Database.Database, runId: RunId): SessionRun | null {
  const row = db.prepare("SELECT * FROM runs WHERE run_id = ? AND kind = 'session'").get(runId) as
    | SessionRunRow
    | undefined;
  return row ? rowToSessionRun(row) : null;
}

/**
 * The latest session Run attached to exactly this (Claude session, pid)
 * identity (D-21). A null `pid` matches a PID-less Run, never any Run.
 */
export function findRunByIdentity(
  db: Database.Database,
  claudeSessionId: string,
  pid: number | null,
): SessionRun | null {
  const row = db
    .prepare(
      `SELECT * FROM runs WHERE kind = 'session' AND claude_session_id = ? AND pid IS ? ${LATEST_FIRST} LIMIT 1`,
    )
    .get(claudeSessionId, pid) as SessionRunRow | undefined;
  return row ? rowToSessionRun(row) : null;
}

// RED signature stubs (05-05 Task 2): the behavior lands in the GREEN commit.

export class ProjectNotRegisteredError extends Error {}

export interface RegisteredProject {
  readonly projectId: string;
  readonly root: string;
  readonly name: string;
}

export function listRevivableRuns(_db: Database.Database, _nowIso: string): SessionRun[] {
  return [];
}

export function listSessionRunsForView(
  _db: Database.Database,
  _options: { readonly endedSince: string },
): SessionRun[] {
  return [];
}

export function listConflictCandidates(_db: Database.Database): SessionRun[] {
  return [];
}

export function latestRunBySession(
  _db: Database.Database,
  _claudeSessionId: string,
): SessionRun | null {
  return null;
}

export function findLiveRunByPid(_db: Database.Database, _pid: number): SessionRun | null {
  return null;
}

export function latestRunByPid(_db: Database.Database, _pid: number): SessionRun | null {
  return null;
}

export interface SessionRunIndex {
  byRunId(runId: RunId): SessionRun | null;
  byIdentity(claudeSessionId: string, pid: number | null): SessionRun | null;
  latestBySession(claudeSessionId: string): SessionRun | null;
  liveByPid(pid: number): SessionRun | null;
  latestByPid(pid: number): SessionRun | null;
}

export function sessionRunIndex(_db: Database.Database): SessionRunIndex {
  return {
    byRunId: () => null,
    byIdentity: () => null,
    latestBySession: () => null,
    liveByPid: () => null,
    latestByPid: () => null,
  };
}

export function setSessionOverride(
  _db: Database.Database,
  _claudeSessionId: string,
  _projectId: string,
  _associatedAt: string,
): void {}

export function getSessionOverride(
  _db: Database.Database,
  _claudeSessionId: string,
): string | null {
  return null;
}

export function listRegisteredProjects(_db: Database.Database): RegisteredProject[] {
  return [];
}
