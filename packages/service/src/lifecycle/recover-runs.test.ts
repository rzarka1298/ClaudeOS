import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRunId, type RunId, type RunState, type SessionRun } from "@ccc/domain";
import {
  applyMigrations,
  getRun,
  getSessionRun,
  insertRun,
  listRevivableRuns,
  startJobRun,
  upsertSessionRun,
} from "@ccc/operational-store";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../logging.js";
import { recoverInterruptedRuns } from "./recover-runs.js";

const REAL_MIGRATIONS_DIR = join(import.meta.dirname, "../../../operational-store/migrations");

let dir: string;
let db: Database.Database;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-recover-runs-"));
  db = new Database(join(dir, "operational.db"));
  applyMigrations(db, REAL_MIGRATIONS_DIR);
  logPath = join(dir, "service.log");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedRun(id: string, state: RunState): void {
  insertRun(db, {
    runId: id as RunId,
    kind: "automation",
    projectId: null,
    claudeSessionId: null,
    state,
    startedAt: "2026-09-16T00:00:00.000Z",
    lastActivityAt: null,
    endedAt: null,
  });
}

function readLogLines(): Array<Record<string, unknown>> {
  const raw = readFileSync(logPath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("recoverInterruptedRuns", () => {
  it("moves a Run persisted as running to stale, never completed or failed", () => {
    seedRun("run-running", "running");
    const logger = createLogger(logPath);
    recoverInterruptedRuns(db, logger);
    expect(getRun(db, "run-running" as RunId)?.state).toBe("stale");
  });

  it("moves a Run persisted as waiting-for-approval to stale", () => {
    seedRun("run-waiting", "waiting-for-approval");
    const logger = createLogger(logPath);
    recoverInterruptedRuns(db, logger);
    expect(getRun(db, "run-waiting" as RunId)?.state).toBe("stale");
  });

  it("leaves a Run persisted as completed, failed, or cancelled exactly as it was", () => {
    seedRun("run-completed", "completed");
    seedRun("run-failed", "failed");
    seedRun("run-cancelled", "cancelled");
    const logger = createLogger(logPath);
    recoverInterruptedRuns(db, logger);
    expect(getRun(db, "run-completed" as RunId)?.state).toBe("completed");
    expect(getRun(db, "run-failed" as RunId)?.state).toBe("failed");
    expect(getRun(db, "run-cancelled" as RunId)?.state).toBe("cancelled");
  });

  it("leaves endedAt null on every Run it touches, because it never observed an ending", () => {
    seedRun("run-queued", "queued");
    const logger = createLogger(logPath);
    recoverInterruptedRuns(db, logger);
    expect(getRun(db, "run-queued" as RunId)?.endedAt).toBeNull();
  });

  it("is idempotent: running it twice produces the same rows as running it once", () => {
    seedRun("run-starting", "starting");
    const logger = createLogger(logPath);
    recoverInterruptedRuns(db, logger);
    const afterFirst = getRun(db, "run-starting" as RunId);
    recoverInterruptedRuns(db, logger);
    const afterSecond = getRun(db, "run-starting" as RunId);
    expect(afterSecond).toEqual(afterFirst);
  });

  it("logs the count of Runs reconciled at info level", () => {
    seedRun("run-a", "running");
    seedRun("run-b", "queued");
    seedRun("run-c", "completed");
    const logger = createLogger(logPath);
    const count = recoverInterruptedRuns(db, logger);
    expect(count).toBe(2);
    const lines = readLogLines();
    const infoLine = lines.find((l) => l.count === 2);
    expect(infoLine).toBeDefined();
    expect(infoLine?.level).toBe(30); // pino info level
  });

  it("bumps a session Run's revision when it moves it to stale, so subscribers see the change (wave 2 review)", () => {
    const sessionRunId = "mgz1a2b3c0000000000000001" as RunId;
    upsertSessionRun(db, sessionRun(sessionRunId, "running", 3));
    const logger = createLogger(logPath);
    recoverInterruptedRuns(db, logger);
    expect(getSessionRun(db, sessionRunId)).toMatchObject({
      state: "stale",
      revision: 4,
      endedAt: null,
    });

    recoverInterruptedRuns(db, logger);
    expect(getSessionRun(db, sessionRunId)?.revision).toBe(4);
  });

  it("leaves an automation Run's revision untouched", () => {
    seedRun("run-automation", "running");
    const before = db.prepare("SELECT revision FROM runs WHERE run_id = ?").get("run-automation");
    recoverInterruptedRuns(db, createLogger(logPath));
    const after = db.prepare("SELECT revision FROM runs WHERE run_id = ?").get("run-automation");
    expect(after).toEqual(before);
  });
});

function sessionRun(runId: RunId, state: RunState, revision: number): SessionRun {
  return {
    runId,
    revision,
    claudeSessionId: "recover-session-1",
    pid: 5001,
    pidStartedAt: "Mon Sep 28 10:00:00 2026",
    state,
    activity: "working",
    projectId: null,
    name: null,
    model: null,
    effort: null,
    launchSource: "terminal",
    cwd: null,
    worktreeRoot: null,
    permissionMode: null,
    lastError: null,
    claudeVersion: null,
    transcriptPath: null,
    linkKind: null,
    linkedFromRunId: null,
    subagentActiveIds: [],
    subagentLastType: null,
    startedAt: "2026-09-28T09:00:00.000Z",
    lastActivityAt: "2026-09-28T10:00:00.000Z",
    endedAt: null,
    terminateRequestedAt: null,
    endObservedAt: null,
    promptSeenAt: null,
  };
}

// ---------------------------------------------------------------------------
// Plan 07-06 task 3: a paired research job run recovers with its Run (research Pitfall 9)

const JOB = "research.daily-tech";
const STARTED = "2026-10-15T08:00:00.000Z";

function startResearchRun(startedAt = STARTED): RunId {
  const jobRunId = newRunId();
  const result = startJobRun(db, {
    jobRunId,
    jobKey: JOB,
    idempotencyKey: `${JOB}:manual:${jobRunId}`,
    trigger: "manual",
    startedAt,
  });
  expect(result).toEqual({ started: true });
  return jobRunId;
}

function jobRunRow(id: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM job_runs WHERE job_run_id = ?").get(id) as Record<
    string,
    unknown
  >;
}

describe("recoverInterruptedRuns with a research job run", () => {
  it("Test 1: moves both the run and its paired job run to stale, with no outcome and no end time", () => {
    const id = startResearchRun();
    recoverInterruptedRuns(db, createLogger(logPath));
    expect(jobRunRow(id)).toMatchObject({ state: "stale", outcome: null, ended_at: null });
    expect(getRun(db, id)).toMatchObject({ state: "stale", endedAt: null });
  });

  it("moves the job run and the Run together or not at all", () => {
    const id = startResearchRun();
    db.exec(
      "CREATE TRIGGER sabotage_job_runs BEFORE UPDATE ON job_runs BEGIN SELECT RAISE(ABORT, 'sabotaged'); END",
    );
    expect(() => recoverInterruptedRuns(db, createLogger(logPath))).toThrow(/sabotaged/);
    expect(getRun(db, id)?.state).toBe("running");
    expect(jobRunRow(id).state).toBe("running");
  });

  it("Test 2: lets a new run start for the same job key afterwards", () => {
    const first = startResearchRun();
    expect(
      startJobRun(db, {
        jobRunId: newRunId(),
        jobKey: JOB,
        idempotencyKey: "k-blocked",
        trigger: "manual",
        startedAt: "2026-10-15T08:00:05.000Z",
      }),
    ).toEqual({ started: false, inFlightRunId: first });

    recoverInterruptedRuns(db, createLogger(logPath));

    expect(startResearchRun("2026-10-15T09:00:00.000Z")).not.toBe(first);
  });

  it("Test 3: a second recovery changes nothing and reports zero", () => {
    const id = startResearchRun();
    const logger = createLogger(logPath);
    expect(recoverInterruptedRuns(db, logger)).toBe(1);
    const jobAfterFirst = jobRunRow(id);
    const runAfterFirst = getRun(db, id);
    expect(recoverInterruptedRuns(db, logger)).toBe(0);
    expect(jobRunRow(id)).toEqual(jobAfterFirst);
    expect(getRun(db, id)).toEqual(runAfterFirst);
  });

  it("recovers a session Run and a research run in the same call and leaves a finished job run alone", () => {
    seedRun("run-session-like", "running");
    const id = startResearchRun();
    db.prepare(
      "INSERT INTO job_runs (job_run_id, job_key, scheduled_for, state, idempotency_key, outcome, ended_at) VALUES ('done', 'research.done', ?, 'completed', 'k-done', 'success', ?)",
    ).run(STARTED, STARTED);
    expect(recoverInterruptedRuns(db, createLogger(logPath))).toBe(2);
    expect(getRun(db, "run-session-like" as RunId)?.state).toBe("stale");
    expect(jobRunRow(id).state).toBe("stale");
    expect(jobRunRow("done")).toMatchObject({ state: "completed", outcome: "success" });
  });

  it("Test 4: no recovery code path writes completed, failed or cancelled", () => {
    const source = readFileSync(join(import.meta.dirname, "recover-runs.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("recoverJobRunsToStale");
    expect(code).not.toMatch(/["'`](completed|failed|cancelled)["'`]/);
  });

  it("Test 5: the liveness sweep never revives a recovered automation run", () => {
    const id = startResearchRun();
    recoverInterruptedRuns(db, createLogger(logPath));
    const revivable = listRevivableRuns(db, "2026-10-15T08:30:00.000Z");
    expect(revivable.map((run) => run.runId)).not.toContain(id);
    expect(getRun(db, id)).toMatchObject({ kind: "automation", state: "stale" });
  });
});
