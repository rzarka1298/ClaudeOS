import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, SchemaAheadOfCodeError } from "./migrate.js";

const REAL_MIGRATIONS_DIR = join(import.meta.dirname, "../migrations");

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
  it("creates every declared table and records schema version 1 on a brand-new database", () => {
    const db = new Database(dbPath);
    try {
      applyMigrations(db, REAL_MIGRATIONS_DIR);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name);
      for (const table of ["service_meta", "projects", "runs", "job_runs", "cache_index"]) {
        expect(tables).toContain(table);
      }
      const version = db.prepare("SELECT version FROM schema_version").get() as { version: number };
      expect(version.version).toBe(1);
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
      expect(version.version).toBe(1);
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
