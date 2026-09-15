import Database from "better-sqlite3";

/** A handle over the service's private SQLite operational store. */
export interface OperationalStore {
  readonly db: Database.Database;
  writeServiceMeta(key: string, value: string): void;
  readServiceMeta(key: string): string | null;
  close(): void;
}

/**
 * Opens (creating if absent) the operational store at `dbPath` via
 * better-sqlite3 — ADR-0009 pins this over Node's built-in `node:sqlite`,
 * which remains Release Candidate. Sets WAL journal mode so a second
 * process can read concurrently with the writer, and ensures the
 * `service_meta` table the walking skeleton's startup record lives in.
 */
export function openStore(dbPath: string): OperationalStore {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(
    "CREATE TABLE IF NOT EXISTS service_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );

  const writeStmt = db.prepare(
    "INSERT INTO service_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const readStmt = db.prepare("SELECT value FROM service_meta WHERE key = ?");

  return {
    db,
    writeServiceMeta(key: string, value: string): void {
      writeStmt.run(key, value);
    },
    readServiceMeta(key: string): string | null {
      const row = readStmt.get(key) as { value: string } | undefined;
      return row ? row.value : null;
    },
    close(): void {
      db.close();
    },
  };
}
