import { join } from "node:path";
import Database from "better-sqlite3";
import { applyMigrations } from "../migrate.js";

/** The real, committed migrations directory. Every survival test builds its schema from it, never from a hand-written copy. */
export const REAL_MIGRATIONS_DIR = join(import.meta.dirname, "../../migrations");

/** Applies every migration in the real directory to a fresh in-memory database. */
export function openMigratedMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db, REAL_MIGRATIONS_DIR);
  return db;
}

/** Opens (creating) a file-backed database in WAL mode and applies every real migration. Close it yourself. */
export function openMigratedFileDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applyMigrations(db, REAL_MIGRATIONS_DIR);
  return db;
}

/** Opens another connection to an already-migrated file database, as a second process would. */
export function openSecondConnection(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/** The names of every trigger in `sqlite_master`, sorted. */
export function triggerNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

/** The column names of a table. */
export function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}
