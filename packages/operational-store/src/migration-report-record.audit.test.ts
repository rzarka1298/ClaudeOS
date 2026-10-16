import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTENT_HASH_PATTERN,
  NOTE_ID_PATTERN,
  newRunId,
  RESEARCH_JOB_ID,
  RUN_ID_PATTERN,
} from "@ccc/domain";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startJobRun } from "./job-run-store.js";
import { applyMigrations } from "./migrate.js";
import { recordResearchReport } from "./research-report-store.js";

/**
 * Audit (Phase 7, 07-FIX6b, ADR-0030): the research report record migration. It must add exactly
 * one table of content-free columns, apply on a fresh store and in place on a store at the previous
 * head (keeping the job runs and source records already there), leave every earlier migration
 * untouched (0010 and 0011 are pinned), and keep the journal and snapshot chain in step. Every
 * database lives in a temporary directory.
 */

const MIGRATIONS = join(import.meta.dirname, "../migrations");
const META = join(MIGRATIONS, "meta");
const SQL_FILES = readdirSync(MIGRATIONS)
  .filter((n) => n.endsWith(".sql"))
  .sort();
const FILE = SQL_FILES.find((n) => n.endsWith("_research_report_records.sql"));

const COLUMNS = ["job_run_id", "report_note_id", "content_digest", "recorded_at"];

// SHA-256 of the migrations that shipped before this one. Applied migrations are immutable.
const APPLIED = [
  {
    name: "0010_research_job_runs.sql",
    hash: "13ccc7ccc2ff11fdbf6da204a0f76265151476560ea269594a1ce8d7e3ec5d1d",
  },
  {
    name: "0011_research_source_records.sql",
    hash: "24fb34d3545267f277bbec34c6f969ba3f635b3f5f58cab58cd333411c17b907",
  },
];

const T0 = "2026-10-15T08:00:00.000Z";

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-report-record-migration-"));
  db = new Database(join(dir, "operational.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function columns(table: string): { name: string; notnull: number; pk: number }[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    notnull: number;
    pk: number;
  }[];
}

describe("the report record migration on a fresh store", () => {
  it("adds one table with exactly four columns, all required, keyed by job_run_id", () => {
    expect(FILE, "the research_report_records migration file exists").toBeDefined();
    applyMigrations(db, MIGRATIONS);
    const info = columns("research_report_records");
    expect(info.map((c) => c.name)).toEqual(COLUMNS);
    for (const c of info) expect(c.notnull, `${c.name} is required`).toBe(1);
    expect(info.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["job_run_id"]);
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
      version: SQL_FILES.length,
    });
  });

  it("no column can hold report text, titles or model content", () => {
    const forbidden =
      /body|text|content(?!_digest)|prompt|summary|message|excerpt|quote|error|title|claim/i;
    for (const name of COLUMNS) expect(name, name).not.toMatch(forbidden);
  });

  it("a row written through the store holds only a run id, a note id, a SHA-256 and an instant", () => {
    applyMigrations(db, MIGRATIONS);
    const jobRunId = newRunId();
    startJobRun(db, {
      jobRunId,
      jobKey: RESEARCH_JOB_ID,
      idempotencyKey: `${RESEARCH_JOB_ID}:manual:${jobRunId}`,
      trigger: "manual",
      startedAt: T0,
    });
    recordResearchReport(db, {
      jobRunId,
      reportNoteId: "n".repeat(25),
      contentDigest: createHash("sha256").update("report").digest("hex"),
      recordedAt: T0,
    });
    const rows = db.prepare("SELECT * FROM research_report_records").all() as Record<
      string,
      string
    >[];
    expect(rows).toHaveLength(1);
    const row = rows[0] ?? {};
    expect(RUN_ID_PATTERN.test(row.job_run_id ?? "")).toBe(true);
    expect(NOTE_ID_PATTERN.test(row.report_note_id ?? "")).toBe(true);
    expect(CONTENT_HASH_PATTERN.test(row.content_digest ?? "")).toBe(true);
    expect(row.recorded_at).toBe(T0);
  });
});

describe("the report record migration in place on the previous head", () => {
  it("upgrades a store at the previous head, keeping its job runs, and gains an empty table", () => {
    const previousDir = mkdtempSync(join(tmpdir(), "ccc-report-record-previous-"));
    try {
      const index = SQL_FILES.indexOf(FILE ?? "");
      expect(index).toBeGreaterThan(0);
      for (const f of SQL_FILES.slice(0, index)) {
        copyFileSync(join(MIGRATIONS, f), join(previousDir, f));
      }
      applyMigrations(db, previousDir);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'research_report_records'").get(),
      ).toBeUndefined();
      db.prepare(
        "INSERT INTO job_runs (job_run_id, job_key, scheduled_for, started_at, state, idempotency_key) VALUES ('legacy', 'old.job', ?, ?, 'completed', 'old-key')",
      ).run(T0, T0);
      const hash = createHash("sha256").update("evidence").digest("hex");
      db.prepare(
        "INSERT INTO research_source_records (job_run_id, source_id, canonical_url, content_hash, snapshot_path, label, recorded_at) VALUES ('legacy', ?, 'https://one.example.invalid/x', ?, ?, 'Feed', ?)",
      ).run("a".repeat(32), hash, `global/raw/${"a".repeat(32)}.${hash.slice(0, 12)}.md`, T0);

      applyMigrations(db, MIGRATIONS);

      expect(columns("research_report_records").map((c) => c.name)).toEqual(COLUMNS);
      expect(db.prepare("SELECT COUNT(*) AS n FROM research_report_records").get()).toEqual({
        n: 0,
      });
      expect(db.prepare("SELECT job_key, state FROM job_runs").get()).toEqual({
        job_key: "old.job",
        state: "completed",
      });
      expect(db.prepare("SELECT COUNT(*) AS n FROM research_source_records").get()).toEqual({
        n: 1,
      });
    } finally {
      rmSync(previousDir, { recursive: true, force: true });
    }
  });

  it("applying twice is idempotent", () => {
    applyMigrations(db, MIGRATIONS);
    applyMigrations(db, MIGRATIONS);
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
      version: SQL_FILES.length,
    });
  });
});

describe("applied migrations are not edited, and the journal and snapshot agree", () => {
  it("0010 and 0011 still have their shipped content and the report record file comes after them", () => {
    for (const applied of APPLIED) {
      const actual = createHash("sha256")
        .update(readFileSync(join(MIGRATIONS, applied.name)))
        .digest("hex");
      expect(actual, applied.name).toBe(applied.hash);
      expect(SQL_FILES.indexOf(FILE ?? "")).toBeGreaterThan(SQL_FILES.indexOf(applied.name));
    }
  });

  it("the journal lists the migration at its position", () => {
    const journal = JSON.parse(readFileSync(join(META, "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const at = SQL_FILES.indexOf(FILE ?? "");
    expect(journal.entries[at]).toMatchObject({
      idx: at,
      tag: (FILE ?? "").replace(/\.sql$/, ""),
    });
  });

  it("the snapshot chains to the one before it and declares the table keyed by job_run_id", () => {
    const at = SQL_FILES.indexOf(FILE ?? "");
    const read = (n: number) =>
      JSON.parse(
        readFileSync(join(META, `${String(n).padStart(4, "0")}_snapshot.json`), "utf8"),
      ) as {
        id: string;
        prevId: string;
        tables: Record<string, { columns: Record<string, { primaryKey?: boolean }> }>;
      };
    const snapshot = read(at);
    expect(snapshot.prevId).toBe(read(at - 1).id);
    const table = snapshot.tables.research_report_records;
    expect(Object.keys(table?.columns ?? {})).toEqual(COLUMNS);
    expect(table?.columns.job_run_id?.primaryKey).toBe(true);
    expect(read(at - 1).tables.research_source_records).toBeDefined();
  });

  it("the table is created with IF NOT EXISTS and nothing is dropped or rebuilt", () => {
    const sql = readFileSync(join(MIGRATIONS, FILE ?? ""), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS `research_report_records`/);
    expect(sql).not.toMatch(/DROP TABLE|RENAME|__new_|ALTER TABLE/);
  });
});

describe("guards and isolation", () => {
  it("the database under test lives in the system temporary directory", () => {
    expect(db.name.startsWith(tmpdir())).toBe(true);
    expect(db.name).not.toContain(".claude-command-center");
  });
});
