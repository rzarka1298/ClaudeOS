import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, SchemaAheadOfCodeError } from "./migrate.js";

/**
 * Audit (Phase 05.1, plan 11, D-15, D-24, CODEX-10): the single Codex activity
 * migration. It must apply on a fresh store and in place on a store at the
 * previous head, keep the drizzle journal and snapshot chain in agreement with
 * the SQL files, and create tables that hold counters and identifiers only.
 *
 * Every database here lives in a temporary directory. Nothing in this file
 * opens the owner's runtime directory or live store.
 */

const MIGRATIONS = join(import.meta.dirname, "../migrations");
const META = join(MIGRATIONS, "meta");
const SQL_FILES = readdirSync(MIGRATIONS)
  .filter((n) => n.endsWith(".sql"))
  .sort();
const CODEX_FILE = SQL_FILES.find((n) => n.endsWith("_codex_activity.sql"));

const CODEX_TABLES = [
  "codex_token_turns",
  "codex_token_deltas",
  "codex_token_cumulative",
  "codex_rollout_cursors",
  "codex_coverage_days",
  "codex_recognition",
  "codex_rate_limit_snapshot",
] as const;

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-codex-migration-"));
  db = new Database(join(dir, "operational.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function tableNames(): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((r) => r.name);
}
function columns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

describe("the Codex activity migration on a fresh store", () => {
  it("Test 1: creates the seven counter tables, records the file count and accepts a turn row", () => {
    expect(CODEX_FILE, "the codex_activity migration file exists").toBeDefined();
    applyMigrations(db, MIGRATIONS);

    const tables = tableNames();
    for (const t of CODEX_TABLES) expect(tables, `table ${t}`).toContain(t);
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
      version: SQL_FILES.length,
    });

    db.prepare(
      `INSERT INTO codex_token_turns
         (thread_id, turn_id, bucket_start, input, cached_input, cache_write, output, reasoning_output, total, observed_at)
       VALUES (?, ?, ?, 1, 2, 3, 4, 5, 15, ?)`,
    ).run("thread-1", "turn-1", "2026-10-10T08:00:00.000Z", "2026-10-10T08:01:00.000Z");
    expect(db.prepare("SELECT thread_id, turn_id, total FROM codex_token_turns").get()).toEqual({
      thread_id: "thread-1",
      turn_id: "turn-1",
      total: 15,
    });
  });

  it("the rate-limit snapshot table holds exactly one row (id constrained to 1)", () => {
    applyMigrations(db, MIGRATIONS);
    const insert = db.prepare(
      "INSERT INTO codex_rate_limit_snapshot (id, snapshot_json, observed_at) VALUES (?, '{}', 't')",
    );
    insert.run(1);
    expect(() => insert.run(2)).toThrow();
    expect(() => insert.run(1)).toThrow();
  });
});

describe("the Codex activity migration in place on the previous head", () => {
  it("Test 2: a store migrated only to the previous head upgrades and keeps every existing row", () => {
    const previousDir = mkdtempSync(join(tmpdir(), "ccc-codex-previous-"));
    try {
      const previousFiles = SQL_FILES.filter((n) => n !== CODEX_FILE);
      expect(previousFiles).toHaveLength(SQL_FILES.length - 1);
      for (const f of previousFiles) copyFileSync(join(MIGRATIONS, f), join(previousDir, f));

      applyMigrations(db, previousDir);
      for (const t of CODEX_TABLES) expect(tableNames()).not.toContain(t);
      db.prepare(
        "INSERT INTO projects (project_id, path, display_name, registered_at) VALUES (?, ?, ?, ?)",
      ).run("0000000000123456789abcdef", "/example/project", "example", "t");
      db.prepare("INSERT INTO collector_settings (key, value, updated_at) VALUES (?, ?, ?)").run(
        "transcript_analysis_enabled",
        "true",
        "t",
      );
      const tablesBefore = tableNames();

      applyMigrations(db, MIGRATIONS);

      const tablesAfter = tableNames();
      for (const t of tablesBefore) expect(tablesAfter, `kept ${t}`).toContain(t);
      for (const t of CODEX_TABLES) expect(tablesAfter, `gained ${t}`).toContain(t);
      expect(db.prepare("SELECT display_name FROM projects").get()).toEqual({
        display_name: "example",
      });
      expect(db.prepare("SELECT value FROM collector_settings").get()).toEqual({ value: "true" });
      expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
        version: SQL_FILES.length,
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

describe("drizzle journal and snapshot chain for the Codex migration", () => {
  const journal = JSON.parse(readFileSync(join(META, "_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };

  it("Test 3: the file is last by sorted name and the journal ends with its tag, one entry per file", () => {
    expect(CODEX_FILE).toBeDefined();
    expect(SQL_FILES.at(-1)).toBe(CODEX_FILE);
    expect(journal.entries.map((e) => e.tag)).toEqual(
      SQL_FILES.map((n) => n.replace(/\.sql$/, "")),
    );
    expect(journal.entries.at(-1)?.tag).toBe(CODEX_FILE?.replace(/\.sql$/, ""));
    expect(journal.entries.map((e) => e.idx)).toEqual(SQL_FILES.map((_, i) => i));
  });

  it("the last snapshot chains to the one before it and declares the Codex tables", () => {
    const last = SQL_FILES.length - 1;
    const read = (i: number) =>
      JSON.parse(
        readFileSync(join(META, `${String(i).padStart(4, "0")}_snapshot.json`), "utf8"),
      ) as {
        id: string;
        prevId: string;
        tables: Record<string, unknown>;
      };
    const head = read(last);
    expect(head.prevId).toBe(read(last - 1).id);
    for (const t of CODEX_TABLES) expect(Object.keys(head.tables), `snapshot ${t}`).toContain(t);
  });

  it("every SQL statement that creates a table or an index says IF NOT EXISTS", () => {
    expect(CODEX_FILE).toBeDefined();
    const sql = readFileSync(join(MIGRATIONS, CODEX_FILE ?? ""), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).toMatch(/CREATE TABLE/);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?(TABLE|INDEX)(?! IF NOT EXISTS)/);
  });
});

describe("the Codex tables hold counters and identifiers only", () => {
  const FORBIDDEN = /body|text|content|prompt|title|path|cwd|project|account/i;

  it("Test 4: no column name suggests content, a path, a project or an account", () => {
    applyMigrations(db, MIGRATIONS);
    for (const t of CODEX_TABLES) {
      const cols = columns(t);
      expect(cols.length, `${t} has columns`).toBeGreaterThan(0);
      for (const c of cols) expect(c, `${t}.${c}`).not.toMatch(FORBIDDEN);
    }
  });

  it("the cursor table is keyed by a hashed key and has no path column", () => {
    applyMigrations(db, MIGRATIONS);
    const cols = columns("codex_rollout_cursors");
    expect(cols).toContain("cursor_key");
    expect(cols.some((c) => c.includes("path"))).toBe(false);
  });
});

describe("guards and isolation", () => {
  it("Test 5: a recorded schema_version above the file count is still refused", () => {
    applyMigrations(db, MIGRATIONS);
    db.prepare("UPDATE schema_version SET version = ?").run(SQL_FILES.length + 1);
    expect(() => applyMigrations(db, MIGRATIONS)).toThrow(SchemaAheadOfCodeError);
  });

  it("Test 6: the database under test lives in the system temporary directory", () => {
    expect(db.name.startsWith(tmpdir())).toBe(true);
    expect(db.name).not.toContain(".claude-command-center");
  });
});
