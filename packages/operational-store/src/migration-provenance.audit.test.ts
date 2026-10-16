import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTENT_HASH_PATTERN,
  newRunId,
  RUN_ID_PATTERN,
  rawSnapshotPathFor,
  SOURCE_ID_PATTERN,
} from "@ccc/domain";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrate.js";
import { recordResearchSource } from "./research-source-store.js";

/**
 * Audit (Phase 7, 07-FIX6, decision D-A, ADR-0030): the research provenance migration. It must add
 * exactly one table of content-free columns, apply on a fresh store and in place on a store at the
 * previous head (keeping the job runs already there), leave every earlier migration untouched, and
 * keep the journal and snapshot chain in step. Every database lives in a temporary directory.
 */

const MIGRATIONS = join(import.meta.dirname, "../migrations");
const META = join(MIGRATIONS, "meta");
const SQL_FILES = readdirSync(MIGRATIONS)
  .filter((n) => n.endsWith(".sql"))
  .sort();
const FILE = SQL_FILES.find((n) => n.endsWith("_research_source_records.sql"));

const COLUMNS = [
  "job_run_id",
  "source_id",
  "canonical_url",
  "content_hash",
  "snapshot_path",
  "label",
  "recorded_at",
];

// SHA-256 of the migration that shipped just before this one. Applied migrations are immutable.
const APPLIED_0010 = {
  name: "0010_research_job_runs.sql",
  hash: "13ccc7ccc2ff11fdbf6da204a0f76265151476560ea269594a1ce8d7e3ec5d1d",
};

const T0 = "2026-10-15T08:00:00.000Z";

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-provenance-migration-"));
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

describe("the provenance migration on a fresh store", () => {
  it("adds one table with exactly seven columns, all required, keyed by (job_run_id, source_id)", () => {
    expect(FILE, "the research_source_records migration file exists").toBeDefined();
    applyMigrations(db, MIGRATIONS);
    const info = columns("research_source_records");
    expect(info.map((c) => c.name)).toEqual(COLUMNS);
    for (const c of info) expect(c.notnull, `${c.name} is required`).toBe(1);
    expect(info.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["job_run_id", "source_id"]);
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
      version: SQL_FILES.length,
    });
  });

  it("no column can hold fetched or model content", () => {
    const forbidden = /body|text|content(?!_hash)|prompt|summary|message|excerpt|quote|error/i;
    for (const name of COLUMNS) expect(name, name).not.toMatch(forbidden);
    // `label` is the owner's own short name and `canonical_url` the address the allowlist named.
    expect(COLUMNS).toContain("label");
  });

  it("a row written through the store holds only an id, a source id, a hash, a path, an https address, a label and an instant", () => {
    applyMigrations(db, MIGRATIONS);
    const sourceId = "c".repeat(32);
    const hash = createHash("sha256").update("evidence").digest("hex");
    recordResearchSource(db, {
      jobRunId: newRunId(),
      sourceId,
      canonicalUrl: "https://one.example.invalid/feed.atom",
      contentHash: hash,
      snapshotPath: rawSnapshotPathFor(sourceId, hash),
      label: "Example feed",
      recordedAt: T0,
    });
    const rows = db.prepare("SELECT * FROM research_source_records").all() as Record<
      string,
      string
    >[];
    expect(rows).toHaveLength(1);
    const row = rows[0] ?? {};
    expect(RUN_ID_PATTERN.test(row.job_run_id ?? "")).toBe(true);
    expect(SOURCE_ID_PATTERN.test(row.source_id ?? "")).toBe(true);
    expect(CONTENT_HASH_PATTERN.test(row.content_hash ?? "")).toBe(true);
    expect(row.snapshot_path).toBe(rawSnapshotPathFor(sourceId, hash));
    expect(row.canonical_url).toMatch(/^https:\/\//);
    expect((row.label ?? "").length).toBeLessThanOrEqual(200);
    expect(row.recorded_at).toBe(T0);
  });
});

describe("the provenance migration in place on the previous head", () => {
  it("upgrades a store at the previous head, keeping its job runs, and gains an empty table", () => {
    const previousDir = mkdtempSync(join(tmpdir(), "ccc-provenance-previous-"));
    try {
      const index = SQL_FILES.indexOf(FILE ?? "");
      expect(index).toBeGreaterThan(0);
      for (const f of SQL_FILES.slice(0, index)) {
        copyFileSync(join(MIGRATIONS, f), join(previousDir, f));
      }
      applyMigrations(db, previousDir);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'research_source_records'").get(),
      ).toBeUndefined();
      db.prepare(
        "INSERT INTO job_runs (job_run_id, job_key, scheduled_for, started_at, state, idempotency_key) VALUES ('legacy', 'old.job', ?, ?, 'completed', 'old-key')",
      ).run(T0, T0);

      applyMigrations(db, MIGRATIONS);

      expect(columns("research_source_records").map((c) => c.name)).toEqual(COLUMNS);
      expect(db.prepare("SELECT COUNT(*) AS n FROM research_source_records").get()).toEqual({
        n: 0,
      });
      expect(db.prepare("SELECT job_key, state FROM job_runs").get()).toEqual({
        job_key: "old.job",
        state: "completed",
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
  it("0010 still has its shipped content and the provenance file comes after it", () => {
    const actual = createHash("sha256")
      .update(readFileSync(join(MIGRATIONS, APPLIED_0010.name)))
      .digest("hex");
    expect(actual).toBe(APPLIED_0010.hash);
    expect(SQL_FILES.indexOf(FILE ?? "")).toBeGreaterThan(SQL_FILES.indexOf(APPLIED_0010.name));
  });

  it("the journal lists the provenance migration at its position", () => {
    const journal = JSON.parse(readFileSync(join(META, "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const at = SQL_FILES.indexOf(FILE ?? "");
    expect(journal.entries[at]).toMatchObject({
      idx: at,
      tag: (FILE ?? "").replace(/\.sql$/, ""),
    });
  });

  it("the snapshot chains to the one before it and declares the table with its composite key", () => {
    const at = SQL_FILES.indexOf(FILE ?? "");
    const read = (n: number) =>
      JSON.parse(
        readFileSync(join(META, `${String(n).padStart(4, "0")}_snapshot.json`), "utf8"),
      ) as {
        id: string;
        prevId: string;
        tables: Record<
          string,
          { columns: Record<string, unknown>; compositePrimaryKeys: Record<string, unknown> }
        >;
      };
    const snapshot = read(at);
    expect(snapshot.prevId).toBe(read(at - 1).id);
    const table = snapshot.tables.research_source_records;
    expect(Object.keys(table?.columns ?? {})).toEqual(COLUMNS);
    expect(Object.keys(table?.compositePrimaryKeys ?? {})).toHaveLength(1);
  });

  it("the table is created with IF NOT EXISTS and nothing is dropped or rebuilt", () => {
    const sql = readFileSync(join(MIGRATIONS, FILE ?? ""), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS `research_source_records`/);
    expect(sql).not.toMatch(/DROP TABLE|RENAME|__new_|ALTER TABLE/);
  });
});

describe("guards and isolation", () => {
  it("the database under test lives in the system temporary directory", () => {
    expect(db.name.startsWith(tmpdir())).toBe(true);
    expect(db.name).not.toContain(".claude-command-center");
  });
});
