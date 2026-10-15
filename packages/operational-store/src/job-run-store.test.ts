import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newNoteId, newRunId, type RunId } from "@ccc/domain";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendJobRunStage,
  type FinishJobRunInput,
  finishJobRun,
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
