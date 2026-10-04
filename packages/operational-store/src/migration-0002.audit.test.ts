// Audit (04-01 truth 2): migration 0002's column shapes and re-runnability,
// checked against a freshly migrated temp database.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrate.js";

const MIGRATIONS = join(import.meta.dirname, "../migrations");
const FILE_0002 = readdirSync(MIGRATIONS).find((n) => n.startsWith("0002_") && n.endsWith(".sql"));

interface Col {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-audit-0002-"));
  db = new Database(join(dir, "operational.db"));
  applyMigrations(db, MIGRATIONS);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function cols(table: string): Col[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Col[];
}

describe("migration 0002 audit (D-02, ADR-0018)", () => {
  it("adds pinned as text NOT NULL default 'false', plus text last_opened_at and github_url_override", () => {
    const byName = new Map(cols("projects").map((c) => [c.name, c]));
    expect(byName.get("pinned")).toMatchObject({ type: "TEXT", notnull: 1, dflt_value: "'false'" });
    expect(byName.get("last_opened_at")?.type).toBe("TEXT");
    expect(byName.get("github_url_override")?.type).toBe("TEXT");
  });

  it("every column of scan_roots, launcher_config and the new projects columns is text-typed", () => {
    for (const table of ["scan_roots", "launcher_config"]) {
      const c = cols(table);
      expect(c.length).toBeGreaterThan(0);
      for (const col of c)
        expect(`${table}.${col.name}:${col.type}`).toBe(`${table}.${col.name}:TEXT`);
    }
  });

  it("every CREATE statement in the 0002 file carries IF NOT EXISTS", () => {
    expect(FILE_0002).toBeDefined();
    const sql = readFileSync(join(MIGRATIONS, FILE_0002 as string), "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    const creates = sql.match(/CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)[^\n]*/gi) ?? [];
    expect(creates.length).toBeGreaterThanOrEqual(3);
    for (const stmt of creates) expect(stmt).toMatch(/IF NOT EXISTS/i);
  });
});
