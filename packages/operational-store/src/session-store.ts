import {
  type LaunchSource,
  type RunId,
  type RunLinkKind,
  type RunState,
  type SessionActivity,
  type SessionRun,
  type StopFailureError,
  TERMINAL_RUN_STATES,
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

/** Thrown by {@link setSessionOverride} when the chosen project has no `projects` row (D-24). */
export class ProjectNotRegisteredError extends Error {
  constructor(projectId: string) {
    super(`Project "${projectId}" is not registered`);
    this.name = "ProjectNotRegisteredError";
  }
}

/** A registered project as Phase 5 reads it (D-57): identity, root and display name. */
export interface RegisteredProject {
  readonly projectId: string;
  /** The project's private absolute root. It never crosses to the plugin. */
  readonly root: string;
  readonly name: string;
}

/** Binds a constant state list as positional parameters, as `run-store.ts` does. */
function placeholders(values: readonly string[]): string {
  return values.map(() => "?").join(", ");
}

/** The four states a Run leaves only by evidence, stale excluded. */
const ACTIVE_STATES: readonly RunState[] = [
  "queued",
  "starting",
  "running",
  "waiting-for-approval",
];

/** D-27: a Run in one of these states may be writing to its working tree. */
const CONFLICT_STATES: readonly RunState[] = [
  "starting",
  "running",
  "waiting-for-approval",
  "stale",
];

/** How long a stale Run with a pid stays a revival candidate (PR-12). */
const REVIVAL_WINDOW_MS = 24 * 60 * 60 * 1000;

function allRows(db: Database.Database, sql: string, ...params: unknown[]): SessionRun[] {
  return (db.prepare(sql).all(...params) as SessionRunRow[]).map(rowToSessionRun);
}

function oneRow(db: Database.Database, sql: string, ...params: unknown[]): SessionRun | null {
  const row = db.prepare(sql).get(...params) as SessionRunRow | undefined;
  return row ? rowToSessionRun(row) : null;
}

/**
 * The Runs the liveness sweep checks after restart recovery (D-22, PR-12):
 * every active session Run, plus stale ones that still name a pid, have no
 * end time, and were last active (or started) fewer than 24 h before
 * `nowIso` (strictly: exactly 24 h is out, wave 2 audit). A new
 * query on purpose: `listNonTerminalRuns` must keep excluding `stale`, or
 * SVC-11 recovery would stop being idempotent (Pitfall 8). Timestamps are
 * compared as the `toISOString()` strings the service writes.
 */
export function listRevivableRuns(db: Database.Database, nowIso: string): SessionRun[] {
  const cutoff = new Date(Date.parse(nowIso) - REVIVAL_WINDOW_MS).toISOString();
  return allRows(
    db,
    `SELECT * FROM runs WHERE kind = 'session' AND (
       state IN (${placeholders(ACTIVE_STATES)})
       OR (state = 'stale' AND pid IS NOT NULL AND ended_at IS NULL
           AND COALESCE(last_activity_at, started_at) > ?)
     ) ${LATEST_FIRST}`,
    ...ACTIVE_STATES,
    cutoff,
  );
}

/**
 * The session Runs a view shows (UI-SPEC R-07, R-08): every non-terminal
 * Run (stale included) plus terminal Runs that ended on or after
 * `endedSince`. Automation Runs never appear.
 */
export function listSessionRunsForView(
  db: Database.Database,
  options: { readonly endedSince: string },
): SessionRun[] {
  return allRows(
    db,
    `SELECT * FROM runs WHERE kind = 'session' AND (
       state NOT IN (${placeholders(TERMINAL_RUN_STATES)})
       OR (ended_at IS NOT NULL AND ended_at >= ?)
     ) ${LATEST_FIRST}`,
    ...TERMINAL_RUN_STATES,
    options.endedSince,
  );
}

/**
 * The Runs a launch into the same working tree could collide with (D-27):
 * starting, running, waiting or stale, not in plan mode (an unknown mode
 * counts as write-capable), and with a known working tree. The caller
 * compares `worktreeRoot` with the launch target's.
 */
export function listConflictCandidates(db: Database.Database): SessionRun[] {
  return allRows(
    db,
    `SELECT * FROM runs WHERE kind = 'session'
       AND state IN (${placeholders(CONFLICT_STATES)})
       AND (permission_mode IS NULL OR permission_mode <> 'plan')
       AND worktree_root IS NOT NULL
     ${LATEST_FIRST}`,
    ...CONFLICT_STATES,
  );
}

/** The latest session Run of this Claude session, in any state. */
export function latestRunBySession(
  db: Database.Database,
  claudeSessionId: string,
): SessionRun | null {
  return oneRow(
    db,
    `SELECT * FROM runs WHERE kind = 'session' AND claude_session_id = ? ${LATEST_FIRST} LIMIT 1`,
    claudeSessionId,
  );
}

/** The latest non-terminal (stale included) session Run attached to this pid. */
export function findLiveRunByPid(db: Database.Database, pid: number): SessionRun | null {
  return oneRow(
    db,
    `SELECT * FROM runs WHERE kind = 'session' AND pid = ?
       AND state NOT IN (${placeholders(TERMINAL_RUN_STATES)})
     ${LATEST_FIRST} LIMIT 1`,
    pid,
    ...TERMINAL_RUN_STATES,
  );
}

/** The latest session Run attached to this pid, in any state (links a `/clear` after its SessionEnd). */
export function latestRunByPid(db: Database.Database, pid: number): SessionRun | null {
  return oneRow(
    db,
    `SELECT * FROM runs WHERE kind = 'session' AND pid = ? ${LATEST_FIRST} LIMIT 1`,
    pid,
  );
}

/**
 * The five lookups the collectors reducer's `RunIndex` needs (05-04),
 * declared here structurally because the store may import domain only.
 * `sessionRunIndex(db)` satisfies `RunIndex` from `@ccc/collectors`.
 */
export interface SessionRunIndex {
  byRunId(runId: RunId): SessionRun | null;
  byIdentity(claudeSessionId: string, pid: number | null): SessionRun | null;
  latestBySession(claudeSessionId: string): SessionRun | null;
  liveByPid(pid: number): SessionRun | null;
  latestByPid(pid: number): SessionRun | null;
}

/** A {@link SessionRunIndex} reading the store on every call, so it is never stale. */
export function sessionRunIndex(db: Database.Database): SessionRunIndex {
  return {
    byRunId: (runId) => getSessionRun(db, runId),
    byIdentity: (claudeSessionId, pid) => findRunByIdentity(db, claudeSessionId, pid),
    latestBySession: (claudeSessionId) => latestRunBySession(db, claudeSessionId),
    liveByPid: (pid) => findLiveRunByPid(db, pid),
    latestByPid: (pid) => latestRunByPid(db, pid),
  };
}

/**
 * Records the owner's project choice for a Claude session (SESS-17, D-24),
 * replacing any earlier choice. The project must already be registered:
 * the check and the write share one transaction, and an unregistered ID
 * throws {@link ProjectNotRegisteredError} with nothing written. Only
 * `session_overrides` is written; nothing reaches the vault or `projects`.
 */
export function setSessionOverride(
  db: Database.Database,
  claudeSessionId: string,
  projectId: string,
  associatedAt: string,
): void {
  db.transaction(() => {
    const registered = db.prepare("SELECT 1 FROM projects WHERE project_id = ?").get(projectId);
    if (registered === undefined) {
      throw new ProjectNotRegisteredError(projectId);
    }
    db.prepare(
      `INSERT INTO session_overrides (claude_session_id, project_id, associated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(claude_session_id) DO UPDATE SET
         project_id = excluded.project_id, associated_at = excluded.associated_at`,
    ).run(claudeSessionId, projectId, associatedAt);
  })();
}

/** The project the owner chose for this Claude session, or null when none was chosen. */
export function getSessionOverride(db: Database.Database, claudeSessionId: string): string | null {
  const row = db
    .prepare("SELECT project_id FROM session_overrides WHERE claude_session_id = ?")
    .get(claudeSessionId) as { project_id: string } | undefined;
  return row?.project_id ?? null;
}

/**
 * Every registered project, by display name. Read-only by design (D-57):
 * Phase 4 owns project registration, and no Phase 5 code writes `projects`
 * (a source-scan test enforces it for this file).
 */
export function listRegisteredProjects(db: Database.Database): RegisteredProject[] {
  const rows = db
    .prepare(
      "SELECT project_id, path, display_name FROM projects ORDER BY display_name, project_id",
    )
    .all() as Array<{ project_id: string; path: string; display_name: string }>;
  return rows.map((row) => ({
    projectId: row.project_id,
    root: row.path,
    name: row.display_name,
  }));
}
