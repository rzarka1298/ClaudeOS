import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

/**
 * Thrown by {@link applyMigrations} when the database's recorded
 * `schema_version` is higher than the number of migration files this build
 * knows about. This can only happen if a newer build of the service wrote
 * that row and an older build is now opening the same database file — the
 * older build proceeding would be a silent downgrade that could drop
 * columns or tables the newer schema added. ADR-0018 records this as a
 * hard refusal, never a best-effort continue.
 */
export class SchemaAheadOfCodeError extends Error {
  constructor(recordedVersion: number, highestKnownVersion: number) {
    super(
      `Database schema_version (${recordedVersion}) is ahead of the highest migration this build knows about (${highestKnownVersion}); refusing to proceed to avoid a silent downgrade.`,
    );
    this.name = "SchemaAheadOfCodeError";
  }
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** The committed `migrations/` directory shipped alongside this package's built output. */
function defaultMigrationsDir(): string {
  return join(moduleDir, "../migrations");
}

/** Every `*.sql` migration file in `migrationsDir`, sorted by filename (drizzle-kit's `NNNN_name.sql` numbering sorts correctly as plain strings). An absent directory yields no migrations rather than throwing. */
function listMigrationFiles(migrationsDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(migrationsDir);
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith(".sql")).sort();
}

function ensureSchemaVersionTable(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as
    | { version: number }
    | undefined;
  if (!row) {
    db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  }
}

function readSchemaVersion(db: Database.Database): number {
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number };
  return row.version;
}

function writeSchemaVersion(db: Database.Database, version: number): void {
  db.prepare("UPDATE schema_version SET version = ?").run(version);
}

/**
 * Applies every unapplied migration in `migrationsDir` (filename order) to
 * `db`, one migration per transaction, recording the new `schema_version`
 * in the same transaction the migration's SQL runs in — so the schema and
 * the recorded version can never disagree, and a migration that throws
 * part-way leaves the database at its previous version (better-sqlite3's
 * `db.transaction()` rolls back automatically when the wrapped function
 * throws). Idempotent by construction: a database already at the highest
 * known version does no work. Refuses to proceed — see
 * {@link SchemaAheadOfCodeError} — when the recorded version exceeds the
 * number of migration files this build knows about.
 *
 * Called from `packages/service/src/main.ts` after `openStore()` and
 * before the socket begins accepting connections (ADR-0018), so no request
 * is ever served against a stale schema.
 */
export function applyMigrations(
  db: Database.Database,
  migrationsDir: string = defaultMigrationsDir(),
): void {
  const files = listMigrationFiles(migrationsDir);
  ensureSchemaVersionTable(db);
  const currentVersion = readSchemaVersion(db);

  if (currentVersion > files.length) {
    throw new SchemaAheadOfCodeError(currentVersion, files.length);
  }

  for (let index = currentVersion; index < files.length; index++) {
    const file = files[index];
    if (!file) {
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const nextVersion = index + 1;
    const applyOne = db.transaction(() => {
      db.exec(sql);
      writeSchemaVersion(db, nextVersion);
    });
    applyOne();
  }
}
