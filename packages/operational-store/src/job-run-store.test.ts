import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newNoteId, newRunId, type RunId } from "@ccc/domain";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendJobRunStage,
  type FinishJobRunInput,
  finishJobRun,
  getResearchRunStatus,
  listJobRuns,
  recoverJobRunsToStale,
  type StartJobRunInput,
  startJobRun,
} from "./job-run-store.js";
import { openMigratedFileDb } from "./test-support/migration-helper.js";

const JOB = "research.daily-tech";
const T0 = "2026-10-15T08:00:00.000Z";
const T1 = "2026-10-15T08:00:05.000Z";
const T2 = "2026-10-15T08:01:00.000Z";
const SRC_A = "a".repeat(32);
const SRC_B = "b".repeat(32);

let dir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-job-run-store-"));
  dbPath = join(dir, "operational.db");
  db = openMigratedFileDb(dbPath);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function startInput(overrides: Partial<StartJobRunInput> = {}): StartJobRunInput {
  const jobRunId = overrides.jobRunId ?? newRunId();
  return {
    jobRunId,
    jobKey: JOB,
    idempotencyKey: `${JOB}:manual:${jobRunId}`,
    trigger: "manual",
    startedAt: T0,
    ...overrides,
  };
}

function finishInput(overrides: Partial<FinishJobRunInput> = {}): FinishJobRunInput {
  return {
    outcome: "success",
    endedAt: T2,
    sourceCount: 3,
    sourceTotal: 3,
    reportNoteId: newNoteId(),
    unavailableSources: [],
    errorCode: null,
    ...overrides,
  };
}

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function jobRow(id: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM job_runs WHERE job_run_id = ?").get(id) as Record<
    string,
    unknown
  >;
}
function runRow(id: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM runs WHERE run_id = ?").get(id) as Record<string, unknown>;
}

describe("Test 1 (tracer): a research run starts, records a stage and finishes", () => {
  it("pairs a job_runs row with a runs row of kind automation and finishes both", () => {
    const input = startInput();
    expect(startJobRun(db, input)).toEqual({ started: true });

    const started = jobRow(input.jobRunId);
    expect(started).toMatchObject({
      job_key: JOB,
      state: "running",
      started_at: T0,
      scheduled_for: T0,
      run_trigger: "manual",
      idempotency_key: input.idempotencyKey,
      outcome: null,
      ended_at: null,
    });
    expect(runRow(input.jobRunId)).toMatchObject({
      kind: "automation",
      state: "running",
      started_at: T0,
      ended_at: null,
      project_id: null,
    });

    appendJobRunStage(db, input.jobRunId, { stage: "capture", at: T1, noteIds: [] });
    const noteId = newNoteId();
    appendJobRunStage(db, input.jobRunId, {
      stage: "raw",
      at: T1,
      noteIds: [noteId],
      counts: { sources: 3 },
    });
    expect(JSON.parse(String(jobRow(input.jobRunId).stage_log))).toEqual([
      { stage: "capture", at: T1, noteIds: [] },
      { stage: "raw", at: T1, noteIds: [noteId], counts: { sources: 3 } },
    ]);

    const fin = finishInput();
    finishJobRun(db, input.jobRunId, fin);

    expect(jobRow(input.jobRunId)).toMatchObject({
      state: "completed",
      outcome: "success",
      ended_at: T2,
      source_count: 3,
      source_total: 3,
      report_note_id: fin.reportNoteId,
      error_code: null,
    });
    expect(JSON.parse(String(jobRow(input.jobRunId).unavailable_sources))).toEqual([]);
    expect(runRow(input.jobRunId)).toMatchObject({ state: "completed", ended_at: T2 });
  });

  it("records unavailable sources as ids with closed codes", () => {
    const input = startInput();
    startJobRun(db, input);
    finishJobRun(
      db,
      input.jobRunId,
      finishInput({
        outcome: "partial",
        sourceCount: 1,
        sourceTotal: 2,
        unavailableSources: [{ sourceId: SRC_B, code: "timeout" }],
      }),
    );
    expect(jobRow(input.jobRunId)).toMatchObject({ state: "completed", outcome: "partial" });
    expect(JSON.parse(String(jobRow(input.jobRunId).unavailable_sources))).toEqual([
      { sourceId: SRC_B, code: "timeout" },
    ]);
  });
});

describe("Test 2: the failure path", () => {
  it("finishes failed in both tables with the outcome and error code as given", () => {
    const input = startInput();
    startJobRun(db, input);
    finishJobRun(
      db,
      input.jobRunId,
      finishInput({
        outcome: "failure",
        errorCode: "all-sources-failed",
        sourceCount: 0,
        sourceTotal: 2,
        reportNoteId: null,
        unavailableSources: [
          { sourceId: SRC_A, code: "dns-failure" },
          { sourceId: SRC_B, code: "http-status" },
        ],
      }),
    );
    expect(jobRow(input.jobRunId)).toMatchObject({
      state: "failed",
      outcome: "failure",
      error_code: "all-sources-failed",
      report_note_id: null,
      source_count: 0,
      source_total: 2,
    });
    expect(runRow(input.jobRunId)).toMatchObject({ state: "failed", ended_at: T2 });
  });
});

describe("Test 3: one in flight per job key", () => {
  it("answers the in-flight run id for a second start and inserts nothing", () => {
    const first = startInput();
    expect(startJobRun(db, first)).toEqual({ started: true });
    const second = startInput({ startedAt: T1 });
    expect(startJobRun(db, second)).toEqual({ started: false, inFlightRunId: first.jobRunId });
    expect(count("job_runs")).toBe(1);
    expect(count("runs")).toBe(1);
    expect(jobRow(second.jobRunId)).toBeUndefined();
    expect(runRow(second.jobRunId)).toBeUndefined();
  });

  it("allows a start for a different job key", () => {
    startJobRun(db, startInput());
    expect(startJobRun(db, startInput({ jobKey: "research.other" }))).toEqual({ started: true });
    expect(count("job_runs")).toBe(2);
  });

  it("allows a new start once the first run has finished", () => {
    const first = startInput();
    startJobRun(db, first);
    finishJobRun(db, first.jobRunId, finishInput());
    expect(startJobRun(db, startInput({ startedAt: T2 }))).toEqual({ started: true });
  });

  it("a second connection sees the first connection's in-flight run", () => {
    const first = startInput();
    startJobRun(db, first);
    const other = new Database(dbPath);
    try {
      expect(startJobRun(other, startInput())).toEqual({
        started: false,
        inFlightRunId: first.jobRunId,
      });
    } finally {
      other.close();
    }
    expect(count("job_runs")).toBe(1);
  });

  it("a racing connection cannot start a second run while the first start is uncommitted", () => {
    const first = startInput();
    const other = new Database(dbPath, { timeout: 0 });
    try {
      db.exec("BEGIN IMMEDIATE");
      expect(startJobRun(db, first)).toEqual({ started: true });
      // The write lock is held by the uncommitted first start: the second start is refused, not run.
      expect(() => startJobRun(other, startInput())).toThrow(/busy|locked/i);
      db.exec("COMMIT");
      expect(startJobRun(other, startInput())).toEqual({
        started: false,
        inFlightRunId: first.jobRunId,
      });
    } finally {
      other.close();
    }
    expect(count("job_runs")).toBe(1);
    expect(count("runs")).toBe(1);
  });

  it("the partial unique index is the crash-safe backstop when the select-first misses", () => {
    const first = startInput();
    startJobRun(db, first);

    // A proxy whose first in-flight lookup answers "nothing", as if a concurrent writer had
    // committed between the lookup and the insert.
    let blinded = false;
    const proxy = new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sqlText: string) => {
            const stmt = target.prepare(sqlText);
            if (!blinded && /FROM job_runs/.test(sqlText) && /state IN/.test(sqlText)) {
              blinded = true;
              return { get: () => undefined, all: () => [], run: () => stmt.run() };
            }
            return stmt;
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const second = startInput();
    expect(startJobRun(proxy, second)).toEqual({ started: false, inFlightRunId: first.jobRunId });
    expect(blinded).toBe(true);
    expect(count("job_runs")).toBe(1);
    expect(count("runs")).toBe(1);
  });

  it("the index exists and rejects a raw second in-flight row", () => {
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain("job_runs_one_inflight_per_job");
    startJobRun(db, startInput());
    expect(() =>
      db
        .prepare(
          "INSERT INTO job_runs (job_run_id, job_key, scheduled_for, state, idempotency_key) VALUES (?, ?, ?, 'queued', ?)",
        )
        .run("zzz", JOB, T0, "k-zzz"),
    ).toThrow(/UNIQUE/);
  });
});

describe("G6: a reused idempotency key is a typed result, not a raw constraint error", () => {
  it("answers duplicate-key for a finished run's key and inserts nothing", () => {
    const first = startInput({ idempotencyKey: `${JOB}:scheduled:2026-10-15T08:00:00.000Z` });
    startJobRun(db, first);
    finishJobRun(db, first.jobRunId, finishInput());
    const jobRows = count("job_runs");
    const runRows = count("runs");

    const again = startInput({ idempotencyKey: first.idempotencyKey, trigger: "scheduled" });
    expect(startJobRun(db, again)).toEqual({ started: false, reason: "duplicate-key" });
    expect(count("job_runs")).toBe(jobRows);
    expect(count("runs")).toBe(runRows);
  });

  it("answers duplicate-key for a stale run's key", () => {
    const first = startInput({ idempotencyKey: `${JOB}:scheduled:stale-slot` });
    startJobRun(db, first);
    recoverJobRunsToStale(db, [first.jobRunId]);
    const again = startInput({ idempotencyKey: first.idempotencyKey, trigger: "scheduled" });
    expect(startJobRun(db, again)).toEqual({ started: false, reason: "duplicate-key" });
  });

  it("still answers the in-flight run first when the same key is used while it runs", () => {
    const first = startInput({ idempotencyKey: `${JOB}:scheduled:slot-1` });
    startJobRun(db, first);
    const again = startInput({ idempotencyKey: first.idempotencyKey, trigger: "scheduled" });
    expect(startJobRun(db, again)).toEqual({ started: false, inFlightRunId: first.jobRunId });
  });

  it("a reused run id is still a real error, not a duplicate key", () => {
    const first = startInput();
    startJobRun(db, first);
    finishJobRun(db, first.jobRunId, finishInput());
    const clash = startInput({ jobRunId: first.jobRunId, idempotencyKey: `${JOB}:manual:other` });
    expect(() => startJobRun(db, clash)).toThrow();
  });
});

describe("Test 4: atomicity", () => {
  it("leaves no job_runs row when the paired runs insert throws", () => {
    const input = startInput();
    // A runs row already holds this id, so the paired insert hits its primary key.
    db.prepare(
      "INSERT INTO runs (run_id, kind, state, started_at) VALUES (?, 'automation', 'completed', ?)",
    ).run(input.jobRunId, T0);
    expect(() => startJobRun(db, input)).toThrow();
    expect(count("job_runs")).toBe(0);
    expect(count("runs")).toBe(1);
  });
});

describe("Test 5: validation happens before any write", () => {
  it("rejects values outside the vocabularies on start", () => {
    const bad: Partial<StartJobRunInput>[] = [
      { jobRunId: "not a run id" as RunId },
      { jobKey: "has space" },
      { jobKey: "" },
      { idempotencyKey: "has\nnewline" },
      { trigger: "cron" as never },
      { startedAt: "yesterday" },
      { startedAt: "2026-13-45T00:00:00.000Z" },
    ];
    for (const overrides of bad) {
      expect(() => startJobRun(db, startInput(overrides))).toThrow();
    }
    expect(count("job_runs")).toBe(0);
    expect(count("runs")).toBe(0);
  });

  it("rejects a stage, a note id or a count outside the vocabularies on append", () => {
    const input = startInput();
    startJobRun(db, input);
    const noteId = newNoteId();
    const bad = [
      { stage: "publish" as never, at: T1, noteIds: [] },
      { stage: "raw" as const, at: "soon", noteIds: [] },
      { stage: "raw" as const, at: T1, noteIds: ["Fetched page title"] },
      { stage: "raw" as const, at: T1, noteIds: [noteId, "https://example.invalid/x"] },
      { stage: "raw" as const, at: T1, noteIds: [], counts: { "bad key": 1 } },
      { stage: "raw" as const, at: T1, noteIds: [], counts: { items: 1.5 } },
      { stage: "raw" as const, at: T1, noteIds: [], counts: { items: -1 } },
      { stage: "raw" as const, at: T1, noteIds: [], counts: { items: Number.NaN } },
    ];
    for (const entry of bad) {
      expect(() => appendJobRunStage(db, input.jobRunId, entry)).toThrow();
    }
    expect(jobRow(input.jobRunId).stage_log).toBeNull();
  });

  it("rejects an outcome, an error code, a source id or a source code outside the vocabularies on finish", () => {
    const input = startInput();
    startJobRun(db, input);
    const bad: Partial<FinishJobRunInput>[] = [
      { outcome: "skipped" as never },
      { outcome: "failure", errorCode: "boom" as never },
      { errorCode: "Connection refused by evil.example" as never },
      { reportNoteId: "My report title" },
      { unavailableSources: [{ sourceId: "https://example.invalid", code: "timeout" }] },
      { unavailableSources: [{ sourceId: SRC_A, code: "it exploded" as never }] },
      { sourceCount: -1 },
      { sourceCount: 4, sourceTotal: 3 },
      { sourceTotal: 1.5 },
      { endedAt: "later" },
      { outcome: "failure", errorCode: null },
    ];
    for (const overrides of bad) {
      expect(() => finishJobRun(db, input.jobRunId, finishInput(overrides))).toThrow();
    }
    expect(jobRow(input.jobRunId)).toMatchObject({ state: "running", outcome: null });
    expect(runRow(input.jobRunId)).toMatchObject({ state: "running" });
  });

  it("refuses to append to or finish a run that is not in flight or does not exist", () => {
    const input = startInput();
    startJobRun(db, input);
    finishJobRun(db, input.jobRunId, finishInput());
    expect(() =>
      appendJobRunStage(db, input.jobRunId, { stage: "raw", at: T2, noteIds: [] }),
    ).toThrow();
    expect(() => finishJobRun(db, input.jobRunId, finishInput())).toThrow();
    expect(() =>
      appendJobRunStage(db, newRunId(), { stage: "raw", at: T2, noteIds: [] }),
    ).toThrow();
    expect(() => finishJobRun(db, newRunId(), finishInput())).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task 2: the DIAG-05 status query and the run list

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

/** Starts and finishes one run at `minute`, returning its id. */
function finishedRun(
  minute: number,
  overrides: Partial<FinishJobRunInput> = {},
  jobKey = JOB,
): RunId {
  const input = startInput({ jobKey, startedAt: at(minute) });
  startJobRun(db, input);
  finishJobRun(db, input.jobRunId, finishInput({ endedAt: at(minute + 1), ...overrides }));
  return input.jobRunId;
}

function failedRun(minute: number, jobKey = JOB): RunId {
  return finishedRun(
    minute,
    {
      outcome: "failure",
      errorCode: "all-sources-failed",
      sourceCount: 0,
      sourceTotal: 2,
      reportNoteId: null,
      unavailableSources: [{ sourceId: SRC_A, code: "timeout" }],
    },
    jobKey,
  );
}

function runningRun(minute: number, jobKey = JOB): RunId {
  const input = startInput({ jobKey, startedAt: at(minute) });
  startJobRun(db, input);
  return input.jobRunId;
}

/** Marks a run stale the way startup recovery does: the state only, no outcome and no end time. */
function markStale(id: RunId): void {
  db.prepare("UPDATE job_runs SET state = 'stale' WHERE job_run_id = ?").run(id);
  db.prepare("UPDATE runs SET state = 'stale' WHERE run_id = ?").run(id);
}

describe("Task 2 Test 1: the last successful and the last failed run", () => {
  it("lastSuccess is the newest of success or partial and lastFailure is the failure", () => {
    const success = finishedRun(0);
    const note = newNoteId();
    const partial = finishedRun(10, {
      outcome: "partial",
      sourceCount: 2,
      sourceTotal: 3,
      reportNoteId: note,
      unavailableSources: [{ sourceId: SRC_B, code: "http-status" }],
    });
    const failure = failedRun(20);

    const status = getResearchRunStatus(db, JOB);
    expect(status.lastSuccess).toMatchObject({
      jobRunId: partial,
      outcome: "partial",
      state: "completed",
      sourceCount: 2,
      sourceTotal: 3,
      reportNoteId: note,
      endedAt: at(11),
      unavailableSources: [{ sourceId: SRC_B, code: "http-status" }],
    });
    expect(status.lastSuccess?.jobRunId).not.toBe(success);
    expect(status.lastFailure).toMatchObject({
      jobRunId: failure,
      outcome: "failure",
      state: "failed",
      errorCode: "all-sources-failed",
      endedAt: at(21),
    });
    expect(status.inFlight).toBeNull();
    expect(status.latestUnknown).toBeNull();
  });

  it("keeps the older success when a newer run failed", () => {
    const success = finishedRun(0);
    failedRun(10);
    expect(getResearchRunStatus(db, JOB).lastSuccess?.jobRunId).toBe(success);
  });

  it("reads only the asked-for job key", () => {
    finishedRun(0, {}, "research.other");
    const status = getResearchRunStatus(db, JOB);
    expect(status.lastSuccess).toBeNull();
  });
});

describe("Task 2 Test 2: the in-flight run", () => {
  it("appears as inFlight with its start and the stage of its last log entry only", () => {
    const earlier = finishedRun(0);
    const id = runningRun(10);
    expect(getResearchRunStatus(db, JOB).inFlight).toMatchObject({
      jobRunId: id,
      startedAt: at(10),
      latestStage: null,
    });
    appendJobRunStage(db, id, { stage: "capture", at: at(11), noteIds: [] });
    appendJobRunStage(db, id, { stage: "raw", at: at(12), noteIds: [newNoteId()] });

    const status = getResearchRunStatus(db, JOB);
    expect(status.inFlight).toMatchObject({ jobRunId: id, startedAt: at(10), latestStage: "raw" });
    expect(status.lastSuccess?.jobRunId).toBe(earlier);
    expect(status.lastFailure).toBeNull();
  });
});

describe("Task 2 Test 3: a stale run is its own row only while newest", () => {
  it("shows a stale run newer than the last success and the last failure as latestUnknown", () => {
    finishedRun(0);
    failedRun(10);
    const stale = runningRun(20);
    markStale(stale);

    const status = getResearchRunStatus(db, JOB);
    expect(status.latestUnknown).toMatchObject({
      jobRunId: stale,
      state: "stale",
      outcome: null,
      endedAt: null,
      startedAt: at(20),
    });
    expect(status.lastFailure?.jobRunId).not.toBe(stale);
    expect(status.lastSuccess?.jobRunId).not.toBe(stale);
    expect(status.inFlight).toBeNull();
  });

  it("does not show an older stale run", () => {
    const stale = runningRun(0);
    markStale(stale);
    finishedRun(10);
    expect(getResearchRunStatus(db, JOB).latestUnknown).toBeNull();
  });

  it("does not show a stale run once a newer run is in flight", () => {
    const stale = runningRun(0);
    markStale(stale);
    const live = runningRun(10);
    const status = getResearchRunStatus(db, JOB);
    expect(status.latestUnknown).toBeNull();
    expect(status.inFlight?.jobRunId).toBe(live);
  });

  it("never reports a stale run as a failure or a success", () => {
    const stale = runningRun(0);
    markStale(stale);
    const status = getResearchRunStatus(db, JOB);
    expect(status.lastFailure).toBeNull();
    expect(status.lastSuccess).toBeNull();
    expect(status.latestUnknown?.jobRunId).toBe(stale);
  });
});

describe("Task 2 Test 4: no runs", () => {
  it("returns an object whose four members are all null", () => {
    expect(getResearchRunStatus(db, JOB)).toEqual({
      lastSuccess: null,
      lastFailure: null,
      inFlight: null,
      latestUnknown: null,
    });
  });
});

describe("Task 2 Test 5: the run list", () => {
  it("returns the newest first, bounded by the limit, for one job key", () => {
    const a = finishedRun(0);
    const b = failedRun(10);
    const c = finishedRun(20);
    finishedRun(30, {}, "research.other");
    expect(listJobRuns(db, JOB, 10).map((r) => r.jobRunId)).toEqual([c, b, a]);
    expect(listJobRuns(db, JOB, 2).map((r) => r.jobRunId)).toEqual([c, b]);
    expect(listJobRuns(db, JOB, 1)[0]).toMatchObject({ jobRunId: c, outcome: "success" });
  });

  it("returns an empty list for a job with no runs and refuses a bad limit", () => {
    expect(listJobRuns(db, JOB, 5)).toEqual([]);
    expect(() => listJobRuns(db, JOB, 0)).toThrow();
    expect(() => listJobRuns(db, JOB, -1)).toThrow();
    expect(() => listJobRuns(db, JOB, 1.5)).toThrow();
    expect(() => listJobRuns(db, JOB, 10_000)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task 3: recovery to stale

describe("Task 3: recoverJobRunsToStale", () => {
  it("moves in-flight job runs to stale, leaving outcome and ended_at null, and counts them", () => {
    const running = runningRun(0, "research.one");
    const other = runningRun(0, "research.two");
    expect(recoverJobRunsToStale(db, [running, other])).toBe(2);
    for (const id of [running, other]) {
      expect(jobRow(id)).toMatchObject({ state: "stale", outcome: null, ended_at: null });
    }
  });

  it("leaves finished runs and runs it was not asked about exactly as they were", () => {
    const done = finishedRun(0, {}, "research.done");
    const failed = failedRun(0, "research.failed");
    const untouched = runningRun(0, "research.untouched");
    const before = [done, failed].map((id) => jobRow(id));
    expect(recoverJobRunsToStale(db, [done, failed])).toBe(0);
    expect([done, failed].map((id) => jobRow(id))).toEqual(before);
    expect(jobRow(untouched)).toMatchObject({ state: "running" });
  });

  it("is idempotent, accepts an empty list and treats an unknown or hostile id as bound data", () => {
    const id = runningRun(0);
    expect(recoverJobRunsToStale(db, [id])).toBe(1);
    expect(recoverJobRunsToStale(db, [id])).toBe(0);
    expect(recoverJobRunsToStale(db, [])).toBe(0);
    expect(
      recoverJobRunsToStale(db, ["x'; DROP TABLE job_runs; --", "run-without-a-job-run"]),
    ).toBe(0);
    expect(count("job_runs")).toBe(1);
  });

  it("handles more ids than one statement binds", () => {
    const ids = Array.from({ length: 1200 }, () => newRunId());
    const id = runningRun(0);
    expect(recoverJobRunsToStale(db, [...ids, id])).toBe(1);
  });

  it("allows a new start for the same job key afterwards", () => {
    const id = runningRun(0);
    recoverJobRunsToStale(db, [id]);
    expect(startJobRun(db, startInput({ startedAt: at(5) }))).toEqual({ started: true });
  });

  it("writes no terminal state: the function body names none", () => {
    const source = readFileSync(join(import.meta.dirname, "job-run-store.ts"), "utf8");
    const start = source.indexOf("export function recoverJobRunsToStale");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf("\n}\n", start));
    expect(body).toMatch(/stale/);
    expect(body).not.toMatch(/["'`](completed|failed|cancelled)["'`]/);
  });
});
