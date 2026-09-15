import type Database from "better-sqlite3";

/**
 * STUB — deliberately incomplete for the RED phase of Task 2's TDD cycle.
 * Replaced by the real implementation before the GREEN commit.
 */
export class SchemaAheadOfCodeError extends Error {
  constructor() {
    super("not implemented");
    this.name = "SchemaAheadOfCodeError";
  }
}

export function applyMigrations(_db: Database.Database, _migrationsDir?: string): void {
  // Intentionally does nothing.
}
