import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, SchemaAheadOfCodeError } from "./migrate.js";

const REAL_MIGRATIONS_DIR = join(import.meta.dirname, "../migrations");

/**
 * The real migration filenames, sorted. `applyMigrations` records one
 * schema version per file, so the expected version is this count, never a
 * hard-coded number: whichever of Phases 4 and 5 merges second regenerates
 * its migration on top of the other's (D-59, PR-21), and a literal here
 * would break on that merge.
 */
const MIGRATION_FILES = readdirSync(REAL_MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const EXPECTED_SCHEMA_VERSION = MIGRATION_FILES.length;

/** The nine tables the Phase 5 migration adds (D-21, D-24, D-46). */
const PHASE_5_TABLES = [
  "session_overrides",
  "usage_seen_messages",
  "usage_hourly",
  "coverage_days",
  "transcript_cursors",
  "capacity_snapshots",
  "cost_snapshots",
  "collector_settings",
  "analysis_toggle_log",
] as const;

/** The nullable columns the Phase 5 migration adds to `runs` (D-21). */
const PHASE_5_RUN_COLUMNS = [
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

/** Column names that would mean content is stored (D-49, threat T-05-18). */
const CONTENT_BEARING_COLUMN_NAMES = [
  "body",
  "content",
  "excerpt",
  "text",
  "markdown",
  "prompt",
  "message",
  "tool_input",
  "transcript",
] as const;

function columnsOf(db: Database.Database, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-migrate-"));
  dbPath = join(dir, "operational.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("applyMigrations", () => {
  it("creates every declared table and records the current schema version on a brand-new database", () => {
    const db = new Database(dbPath);
    try {
      applyMigrations(db, REAL_MIGRATIONS_DIR);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name);
      for (const table of [
        "service_meta",
        "projects",
        "runs",
        "job_runs",
        "cache_index",
        "vault_notes",
        ...PHASE_5_TABLES,
      ]) {
        expect(tables).toContain(table);
      }
      const version = db.prepare("SELECT version FROM schema_version").get() as { version: number };
      expect(version.version).toBe(EXPECTED_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("creates the vault_notes cache table with its scope and stage indexes (migration 0001)", () => {
    const db = new Database(dbPath);
    try {
      applyMigrations(db, REAL_MIGRATIONS_DIR);
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'vault_notes'")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(indexes).toContain("vault_notes_scope_idx");
      expect(indexes).toContain("vault_notes_stage_idx");
    } finally {
      db.close();
    }
  });

  it("is a no-op the second time it runs against an already-current database", () => {
    const db = new Database(dbPath);
    try {
      applyMigrations(db, REAL_MIGRATIONS_DIR);
      db.prepare("INSERT INTO service_meta (key, value) VALUES (?, ?)").run("probe", "still-here");
      expect(() => applyMigrations(db, REAL_MIGRATIONS_DIR)).not.toThrow();
      const version = db.prepare("SELECT version FROM schema_version").get() as { version: number };
      expect(version.version).toBe(EXPECTED_SCHEMA_VERSION);
      const row = db.prepare("SELECT value FROM service_meta WHERE key = ?").get("probe") as {
        value: string;
      };
      expect(row.value).toBe("still-here");
    } finally {
      db.close();
    }
  });

  it("upgrades a store already at the previous version: existing runs rows keep their values and the new columns read null", () => {
    const previousDir = mkdtempSync(join(tmpdir(), "ccc-previous-migrations-"));
    for (const file of MIGRATION_FILES.slice(0, 2)) {
      copyFileSync(join(REAL_MIGRATIONS_DIR, file), join(previousDir, file));
    }
    const db = new Database(dbPath);
    try {
      applyMigrations(db, previousDir);
      db.prepare(
        `INSERT INTO runs (run_id, kind, project_id, claude_session_id, state, started_at, last_activity_at, ended_at)
         VALUES ('run-before-upgrade', 'automation', NULL, 'session-before', 'running', '2026-09-16T00:00:00.000Z', '2026-09-16T00:05:00.000Z', NULL)`,
      ).run();

      applyMigrations(db, REAL_MIGRATIONS_DIR);

      const version = db.prepare("SELECT version FROM schema_version").get() as { version: number };
      expect(version.version).toBe(EXPECTED_SCHEMA_VERSION);
      const row = db
        .prepare("SELECT * FROM runs WHERE run_id = 'run-before-upgrade'")
        .get() as Record<string, unknown>;
      expect(row).toMatchObject({
        kind: "automation",
        claude_session_id: "session-before",
        state: "running",
        started_at: "2026-09-16T00:00:00.000Z",
        last_activity_at: "2026-09-16T00:05:00.000Z",
        ended_at: null,
      });
      for (const column of PHASE_5_RUN_COLUMNS) {
        expect(row).toHaveProperty(column, null);
      }
    } finally {
      db.close();
      rmSync(previousDir, { recursive: true, force: true });
    }
  });

  it("stores no content: runs and every Phase 5 table carry no content-bearing column name (D-49)", () => {
    const db = new Database(dbPath);
    try {
      applyMigrations(db, REAL_MIGRATIONS_DIR);
      for (const table of ["runs", ...PHASE_5_TABLES]) {
        const columns = columnsOf(db, table);
        expect(columns.length, `${table} exists`).toBeGreaterThan(0);
        for (const forbidden of CONTENT_BEARING_COLUMN_NAMES) {
          expect(columns, `${table}.${forbidden}`).not.toContain(forbidden);
        }
      }
    } finally {
      db.close();
    }
  });

  it("leaves the database at its previous schema version when a migration throws part-way, because each migration runs in its own transaction", () => {
    const brokenDir = mkdtempSync(join(tmpdir(), "ccc-broken-migrations-"));
    writeFileSync(
      join(brokenDir, "0000_broken.sql"),
      "CREATE TABLE probe_table (id TEXT PRIMARY KEY);\nTHIS IS NOT VALID SQL;\n",
    );
    const db = new Database(dbPath);
    try {
      expect(() => applyMigrations(db, brokenDir)).toThrow();
      const version = db.prepare("SELECT version FROM schema_version").get() as
        | { version: number }
        | undefined;
      expect(version?.version ?? 0).toBe(0);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'probe_table'")
        .all();
      expect(tables).toHaveLength(0);
    } finally {
      db.close();
      rmSync(brokenDir, { recursive: true, force: true });
    }
  });

  it("refuses to proceed with a named error when the recorded schema version is ahead of the highest migration this build knows about", () => {
    const db = new Database(dbPath);
    try {
      applyMigrations(db, REAL_MIGRATIONS_DIR);
      db.prepare("UPDATE schema_version SET version = ?").run(999);
      expect(() => applyMigrations(db, REAL_MIGRATIONS_DIR)).toThrow(SchemaAheadOfCodeError);
    } finally {
      db.close();
    }
  });
});
