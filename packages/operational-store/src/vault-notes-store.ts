import {
  CLAIM_TYPES,
  type ClaimType,
  CONFIDENCE_STATES,
  type ConfidenceState,
  LIFECYCLE_STAGES,
  type LifecycleStage,
  type NoteId,
} from "@ccc/domain";
import type Database from "better-sqlite3";

/**
 * The `vault_notes` metadata cache: one row per managed note, holding only
 * what a filter or a list view needs to answer a query (PERF-06).
 *
 * DELIBERATELY no body, content, or excerpt field. The vault's Markdown
 * files remain the sole holder of durable note content (PRD §9.5); the
 * operational store holds derived metadata it can drop and rebuild at any
 * time. That boundary is asserted by a test, not merely documented here.
 */
export interface VaultNoteRecord {
  readonly noteId: NoteId;
  /** Vault-relative path of the note this row describes. */
  readonly path: string;
  /** `global` or `workspace:<id>` — the note's declared scope. */
  readonly scope: string;
  readonly stage: LifecycleStage;
  readonly aiGenerated: boolean;
  readonly claimType: ClaimType | null;
  readonly confidence: ConfidenceState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly contentHash: string | null;
}

/** The filters {@link queryVaultNotes} understands. An absent field means "do not filter on it". */
export interface VaultNoteQuery {
  readonly scope?: string;
  readonly stage?: LifecycleStage;
}

/**
 * Thrown by {@link assertValidVaultNoteRecord} when a record's `stage`,
 * `confidence`, or `claimType` is outside its domain union.
 */
export class InvalidVaultNoteError extends Error {
  constructor(field: string, value: string) {
    super(`"${value}" is not a valid ${field}`);
    this.name = "InvalidVaultNoteError";
  }
}

/**
 * Validates the three enum-backed columns against their `@ccc/domain`
 * unions, following the `assertValidRunState` pattern in `./run-store.ts`.
 *
 * This is not belt-and-braces type checking. Every value in these three
 * columns originates in a note's YAML frontmatter, which is hand-editable
 * in Obsidian and syncable in from outside this process — an untrusted
 * input boundary (ASVS V5, threat T-02-09). TypeScript's unions have no
 * runtime representation, so without this check a repair pass reading a
 * hand-edited `stage: archived` would silently write it into a column the
 * rest of the system believes can only hold a lifecycle stage.
 *
 * `claimType` is the one nullable member: `null` records "no claim type
 * declared", which is a legitimate state for a user-authored note, so it
 * is accepted while any non-null value outside `CLAIM_TYPES` is refused.
 */
export function assertValidVaultNoteRecord(record: VaultNoteRecord): void {
  if (!LIFECYCLE_STAGES.includes(record.stage)) {
    throw new InvalidVaultNoteError("LifecycleStage", String(record.stage));
  }
  if (!CONFIDENCE_STATES.includes(record.confidence)) {
    throw new InvalidVaultNoteError("ConfidenceState", String(record.confidence));
  }
  if (record.claimType !== null && !CLAIM_TYPES.includes(record.claimType)) {
    throw new InvalidVaultNoteError("ClaimType", String(record.claimType));
  }
}

interface VaultNoteRow {
  note_id: string;
  path: string;
  scope: string;
  stage: string;
  ai_generated: string;
  claim_type: string | null;
  confidence: string;
  created_at: string;
  updated_at: string;
  content_hash: string | null;
}

/**
 * Maps a stored row back to a record. `ai_generated` round-trips through
 * the strings `"true"` / `"false"` because every column in this store is
 * `text` (see `./schema.ts`); anything other than `"true"` reads as false,
 * so a corrupted value degrades to "not AI-generated" rather than throwing
 * in the middle of a list query.
 */
function rowToRecord(row: VaultNoteRow): VaultNoteRecord {
  return {
    noteId: row.note_id as NoteId,
    path: row.path,
    scope: row.scope,
    stage: row.stage as LifecycleStage,
    aiGenerated: row.ai_generated === "true",
    claimType: row.claim_type as ClaimType | null,
    confidence: row.confidence as ConfidenceState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contentHash: row.content_hash,
  };
}

/** The named-parameter object every INSERT in this module binds. */
function recordToParams(record: VaultNoteRecord) {
  return {
    noteId: record.noteId,
    path: record.path,
    scope: record.scope,
    stage: record.stage,
    aiGenerated: record.aiGenerated ? "true" : "false",
    claimType: record.claimType,
    confidence: record.confidence,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    contentHash: record.contentHash,
  };
}

const UPSERT_SQL = `INSERT INTO vault_notes
     (note_id, path, scope, stage, ai_generated, claim_type, confidence, created_at, updated_at, content_hash)
   VALUES
     (@noteId, @path, @scope, @stage, @aiGenerated, @claimType, @confidence, @createdAt, @updatedAt, @contentHash)
   ON CONFLICT(note_id) DO UPDATE SET
     path = excluded.path,
     scope = excluded.scope,
     stage = excluded.stage,
     ai_generated = excluded.ai_generated,
     claim_type = excluded.claim_type,
     confidence = excluded.confidence,
     created_at = excluded.created_at,
     updated_at = excluded.updated_at,
     content_hash = excluded.content_hash`;

/**
 * Inserts or replaces the cache row for one note, keyed by note ID rather
 * than by path — a note that moves between lifecycle folders is still the
 * same note (VAULT-07), so a move must update its row, not create a second.
 *
 * Per ADR-0022 this is the per-write path: its first production caller is
 * the first service-side note-write route (Phase 6). Phase 2's population
 * path is {@link rebuildVaultNotes}, which the repair pass (plan 02-06)
 * runs in a single pass.
 */
export function upsertVaultNote(db: Database.Database, record: VaultNoteRecord): void {
  assertValidVaultNoteRecord(record);
  db.prepare(UPSERT_SQL).run(recordToParams(record));
}

/** Reads one cache row back by note ID, or `null` when the note is not cached. */
export function getVaultNote(db: Database.Database, noteId: NoteId): VaultNoteRecord | null {
  const row = db.prepare("SELECT * FROM vault_notes WHERE note_id = ?").get(noteId) as
    | VaultNoteRow
    | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * Replaces the entire cache with `records`, atomically.
 *
 * The delete and every insert run inside ONE better-sqlite3 transaction,
 * and each record is validated INSIDE that transaction rather than in a
 * pre-pass. That ordering is the point: a guard failure on record 5,000
 * rolls back the delete along with the first 4,999 inserts, so an
 * interrupted or rejected rebuild can never leave a half-populated cache
 * visible to a query. Validating up front would make the test pass for the
 * wrong reason — the delete would simply never have run.
 */
export function rebuildVaultNotes(
  db: Database.Database,
  records: readonly VaultNoteRecord[],
): void {
  const insert = db.prepare(UPSERT_SQL);
  const runRebuild = db.transaction((batch: readonly VaultNoteRecord[]) => {
    db.prepare("DELETE FROM vault_notes").run();
    for (const record of batch) {
      assertValidVaultNoteRecord(record);
      insert.run(recordToParams(record));
    }
  });
  runRebuild(records);
}

/**
 * Every cached note matching `query`, newest-updated first.
 *
 * Both filters are bound as prepared-statement parameters and the WHERE
 * clause is assembled from a fixed set of literal fragments — no caller
 * string ever reaches the SQL text (threat T-02-09). The `scope` and
 * `stage` indexes declared in `./schema.ts` are what keep this responsive
 * at 10,000 rows (PERF-06).
 */
export function queryVaultNotes(
  db: Database.Database,
  query: VaultNoteQuery = {},
): VaultNoteRecord[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (query.scope !== undefined) {
    clauses.push("scope = ?");
    params.push(query.scope);
  }
  if (query.stage !== undefined) {
    clauses.push("stage = ?");
    params.push(query.stage);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM vault_notes${where} ORDER BY updated_at DESC`)
    .all(...params) as VaultNoteRow[];
  return rows.map(rowToRecord);
}

/** How many notes the cache currently holds. */
export function countVaultNotes(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM vault_notes").get() as { n: number };
  return row.n;
}
