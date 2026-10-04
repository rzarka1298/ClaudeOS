import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, SchemaAheadOfCodeError } from "./migrate.js";

const REAL_MIGRATIONS_DIR = join(import.meta.dirname, "../migrations");

/**
 * The schema version a fully migrated database records, derived from the
 * migrations directory rather than written as a literal (PR-09, D-50). Two
 * parallel branches each add a migration; with a literal here, both would
 * edit the same assertion and conflict at merge. Counting the files means a
 * new migration needs no edit to this test at all.
 */
const EXPECTED_VERSION = readdirSync(REAL_MIGRATIONS_DIR).filter((n) => n.endsWith(".sql")).length;

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
        "scan_roots",
        "launcher_config",
      ]) {
        expect(tables).toContain(table);
      }
      const version = db.prepare("SELECT version FROM schema_version").get() as { version: number };
      expect(version.version).toBe(EXPECTED_VERSION);
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

  it("upgrades a database already at the previous schema version to the latest, keeping its rows", () => {
    const previousDir = mkdtempSync(join(tmpdir(), "ccc-previous-migrations-"));
    const files = readdirSync(REAL_MIGRATIONS_DIR)
      .filter((n) => n.endsWith(".sql"))
      .sort();
    for (const name of files.slice(0, -1)) {
      copyFileSync(join(REAL_MIGRATIONS_DIR, name), join(previousDir, name));
    }
    const db = new Database(dbPath);
    try {
      applyMigrations(db, previousDir);
      db.prepare(
        "INSERT INTO projects (project_id, path, display_name, registered_at) VALUES (?, ?, ?, ?)",
      ).run("0000000000123456789abcdef", "/Users/USERNAME/code/example-project", "example", "t");

      applyMigrations(db, REAL_MIGRATIONS_DIR);

      const version = db.prepare("SELECT version FROM schema_version").get() as { version: number };
      expect(version.version).toBe(EXPECTED_VERSION);
      const row = db.prepare("SELECT display_name, pinned FROM projects").get() as {
        display_name: string;
        pinned: string;
      };
      expect(row.display_name).toBe("example");
      // Migration 0002's NOT NULL DEFAULT backfills rows that predate it.
      expect(row.pinned).toBe("false");
    } finally {
      db.close();
      rmSync(previousDir, { recursive: true, force: true });
    }
  });

  it("is a no-op the second time it runs against an already-current database", () => {
    const db = new Database(dbPath);
    try {
      applyMigrations(db, REAL_MIGRATIONS_DIR);
      db.prepare("INSERT INTO service_meta (key, value) VALUES (?, ?)").run("probe", "still-here");
      expect(() => applyMigrations(db, REAL_MIGRATIONS_DIR)).not.toThrow();
      const version = db.prepare("SELECT version FROM schema_version").get() as { version: number };
      expect(version.version).toBe(EXPECTED_VERSION);
      const row = db.prepare("SELECT value FROM service_meta WHERE key = ?").get("probe") as {
        value: string;
      };
      expect(row.value).toBe("still-here");
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
