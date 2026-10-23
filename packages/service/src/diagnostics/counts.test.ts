import { applyMigrations, insertProject, insertScanRoot, openStore } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CountDb, readHealthCounts } from "./counts.js";

/**
 * Plan 08-12 Task 1 Test 3 (D-10; T-08-30): the four counts the health response carries for the
 * diagnostic bundle. Each is an integer read from the operational store, or null when that one
 * read fails: a failed read is never reported as zero (ADR-0002, never invent a state), and one
 * failing table does not blank the other three.
 */

let store: ReturnType<typeof openStore>;

beforeEach(() => {
  store = openStore(":memory:");
  applyMigrations(store.db);
});
afterEach(() => {
  store.close();
});

function insertTask(noteId: string, status: string): void {
  store.db
    .prepare(
      `INSERT INTO task_index (note_id, path, scope, title, status, created_at, updated_at, ai_generated, confidence)
       VALUES (@noteId, @path, 'global', 'Example task', @status, '2026-10-22T08:00:00.000Z', '2026-10-22T08:00:00.000Z', 'false', 'medium')`,
    )
    .run({ noteId, path: `global/tasks/${noteId}.md`, status });
}

function insertReport(jobRunId: string): void {
  store.db
    .prepare(
      `INSERT INTO research_report_records (job_run_id, report_note_id, content_digest, recorded_at)
       VALUES (@jobRunId, @noteId, @digest, '2026-10-22T08:00:00.000Z')`,
    )
    .run({ jobRunId, noteId: `note-${jobRunId}`, digest: "a".repeat(64) });
}

describe("Test 3: readHealthCounts", () => {
  it("reads zero from an empty store (an empty table is a real zero)", () => {
    expect(readHealthCounts(store.db)).toEqual({
      projects: 0,
      scanFolders: 0,
      openTasks: 0,
      reports: 0,
    });
  });

  it("counts projects, scan folders, open tasks and recorded reports from the store", () => {
    insertProject(store.db, { path: "/example/one", displayName: "One" });
    insertProject(store.db, { path: "/example/two", displayName: "Two" });
    insertScanRoot(store.db, { path: "/example/scan", depth: 1 });
    insertTask("t1", "ready");
    insertTask("t2", "in-progress");
    insertTask("t3", "inbox");
    insertTask("t4", "blocked");
    // Not open: finished, cancelled, or a suggestion waiting for a decision (the same rule the tasks list uses).
    insertTask("t5", "done");
    insertTask("t6", "cancelled");
    insertTask("t7", "proposed");
    insertReport("run-1");
    insertReport("run-2");
    insertReport("run-3");

    const counts = readHealthCounts(store.db);
    expect(counts).toEqual({ projects: 2, scanFolders: 1, openTasks: 4, reports: 3 });
    for (const value of Object.values(counts)) expect(Number.isInteger(value)).toBe(true);
  });

  it("reads null, never zero, for a count whose read fails, and keeps the other three", () => {
    insertProject(store.db, { path: "/example/one", displayName: "One" });
    store.db.exec("DROP TABLE task_deps");
    store.db.exec("DROP TABLE task_tags");
    store.db.exec("DROP TABLE task_index");
    const counts = readHealthCounts(store.db);
    expect(counts).toEqual({ projects: 1, scanFolders: 0, openTasks: null, reports: 0 });
  });

  it("reads all four as null when every read fails", () => {
    const broken: CountDb = {
      prepare: () => {
        throw new Error("no such table: /home/example/private.db");
      },
    };
    expect(readHealthCounts(broken)).toEqual({
      projects: null,
      scanFolders: null,
      openTasks: null,
      reports: null,
    });
  });

  it("never reports a value that is not a non-negative safe integer (a strange row reads null)", () => {
    for (const odd of [undefined, null, "3", -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      const db: CountDb = { prepare: () => ({ get: () => ({ n: odd }) }) };
      expect(readHealthCounts(db), String(odd)).toEqual({
        projects: null,
        scanFolders: null,
        openTasks: null,
        reports: null,
      });
    }
    const emptyRow: CountDb = { prepare: () => ({ get: () => undefined }) };
    expect(readHealthCounts(emptyRow).projects).toBeNull();
  });

  it("issues only fixed SELECT COUNT statements (read-only, no parameters)", () => {
    const seen: string[] = [];
    const recording: CountDb = {
      prepare: (sql) => {
        seen.push(sql);
        return { get: () => ({ n: 0 }) };
      },
    };
    readHealthCounts(recording);
    expect(seen).toHaveLength(4);
    for (const sql of seen) {
      expect(sql).toMatch(/^SELECT COUNT\(\*\) AS n FROM [a-z_]+( WHERE [^;]+)?$/);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|PRAGMA|ATTACH)\b/i);
    }
  });
});
