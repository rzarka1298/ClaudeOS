import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrate.js";

/**
 * Audit (05-16 merge reconcile, area 1): the Phase 4 + Phase 5 migration chain.
 * A store that Phase 4 left at 0000-0002 must upgrade to head, gaining Phase 5's
 * tables and `runs` columns while keeping Phase 4's rows; the drizzle journal
 * and snapshot chain must agree with the SQL files.
 */

const MIGRATIONS = join(import.meta.dirname, "../migrations");
const META = join(MIGRATIONS, "meta");
const SQL_FILES = readdirSync(MIGRATIONS)
  .filter((n) => n.endsWith(".sql"))
  .sort();

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-chain-"));
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

describe("Phase 4 store upgraded to the merged head", () => {
  it("gains Phase 5's tables and runs columns and keeps Phase 4's rows and tables", () => {
    const phase4Dir = mkdtempSync(join(tmpdir(), "ccc-phase4-migrations-"));
    try {
      const phase4Files = SQL_FILES.filter((n) => /^000[0-2]_/.test(n));
      expect(phase4Files).toHaveLength(3);
      for (const f of phase4Files) copyFileSync(join(MIGRATIONS, f), join(phase4Dir, f));

      applyMigrations(db, phase4Dir);
      expect(tableNames()).not.toContain("session_overrides");
      expect(columns("runs")).not.toContain("pid");
      db.prepare(
        "INSERT INTO projects (project_id, path, display_name, registered_at) VALUES (?, ?, ?, ?)",
      ).run("0000000000123456789abcdef", "/example/project", "example", "t");
      db.prepare("INSERT INTO scan_roots (scan_root_id, path, added_at) VALUES (?, ?, ?)").run(
        "root-1",
        "/example/scan",
        "t",
      );

      applyMigrations(db, MIGRATIONS);

      const tables = tableNames();
      for (const t of [
        "session_overrides",
        "usage_seen_messages",
        "usage_quarter_hourly",
        "coverage_days",
        "transcript_cursors",
        "capacity_snapshots",
        "cost_snapshots",
        "collector_settings",
        "analysis_toggle_log",
        "transcript_recognition",
        "scan_roots",
        "launcher_config",
      ]) {
        expect(tables, `table ${t}`).toContain(t);
      }
      expect(tables).not.toContain("usage_hourly");
      for (const c of ["pid", "pid_started_at", "revision", "transcript_path", "end_observed_at"]) {
        expect(columns("runs"), `runs.${c}`).toContain(c);
      }
      expect(db.prepare("SELECT display_name, pinned FROM projects").get()).toEqual({
        display_name: "example",
        pinned: "false",
      });
      expect(db.prepare("SELECT COUNT(*) AS n FROM scan_roots").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
        version: SQL_FILES.length,
      });
    } finally {
      rmSync(phase4Dir, { recursive: true, force: true });
    }
  });
});

describe("drizzle journal and snapshots agree with the SQL files", () => {
  const journal = JSON.parse(readFileSync(join(META, "_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };

  it("lists exactly the migration file names, in order, with contiguous idx", () => {
    expect(journal.entries.map((e) => e.tag)).toEqual(
      SQL_FILES.map((n) => n.replace(/\.sql$/, "")),
    );
    expect(journal.entries.map((e) => e.idx)).toEqual(SQL_FILES.map((_, i) => i));
    expect(SQL_FILES.map((n) => n.slice(0, 4))).toEqual(
      SQL_FILES.map((_, i) => String(i).padStart(4, "0")),
    );
  });

  it("chains every snapshot prevId to the previous snapshot id, with no duplicate ids", () => {
    const snaps = SQL_FILES.map(
      (n) =>
        JSON.parse(readFileSync(join(META, `${n.slice(0, 4)}_snapshot.json`), "utf8")) as {
          id: string;
          prevId: string;
        },
    );
    expect(new Set(snaps.map((s) => s.id)).size).toBe(snaps.length);
    expect(snaps[0]?.prevId).toBe("00000000-0000-0000-0000-000000000000");
    for (let i = 1; i < snaps.length; i += 1) {
      expect(snaps[i]?.prevId, `snapshot ${i}`).toBe(snaps[i - 1]?.id);
    }
  });

  it("the head snapshot declares the tables the SQL actually builds", () => {
    const head = JSON.parse(
      readFileSync(
        join(META, `${String(SQL_FILES.length - 1).padStart(4, "0")}_snapshot.json`),
        "utf8",
      ),
    ) as { tables: Record<string, unknown> };
    applyMigrations(db, MIGRATIONS);
    const real = tableNames().filter((n) => n !== "schema_version" && !n.startsWith("sqlite_"));
    expect(Object.keys(head.tables).sort()).toEqual(real.sort());
  });
});
