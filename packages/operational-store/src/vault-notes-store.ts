import type { ClaimType, ConfidenceState, LifecycleStage, NoteId } from "@ccc/domain";
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

/** Validates the three enum-backed columns against their `@ccc/domain` unions. */
export function assertValidVaultNoteRecord(record: VaultNoteRecord): void {
  void record;
  throw new Error(
    "assertValidVaultNoteRecord is not implemented yet (packages/operational-store/src/vault-notes-store.ts)",
  );
}

/** Inserts or replaces the cache row for one note. */
export function upsertVaultNote(db: Database.Database, record: VaultNoteRecord): void {
  void db;
  void record;
  throw new Error(
    "upsertVaultNote is not implemented yet (packages/operational-store/src/vault-notes-store.ts)",
  );
}

/** Reads one cache row back by note ID, or `null` when the note is not cached. */
export function getVaultNote(db: Database.Database, noteId: NoteId): VaultNoteRecord | null {
  void db;
  void noteId;
  throw new Error(
    "getVaultNote is not implemented yet (packages/operational-store/src/vault-notes-store.ts)",
  );
}

/** Replaces the entire cache with `records`, atomically. */
export function rebuildVaultNotes(
  db: Database.Database,
  records: readonly VaultNoteRecord[],
): void {
  void db;
  void records;
  throw new Error(
    "rebuildVaultNotes is not implemented yet (packages/operational-store/src/vault-notes-store.ts)",
  );
}

/** Every cached note matching `query`, ordered by `updated_at` descending. */
export function queryVaultNotes(
  db: Database.Database,
  query: VaultNoteQuery = {},
): VaultNoteRecord[] {
  void db;
  void query;
  throw new Error(
    "queryVaultNotes is not implemented yet (packages/operational-store/src/vault-notes-store.ts)",
  );
}

/** How many notes the cache currently holds. */
export function countVaultNotes(db: Database.Database): number {
  void db;
  throw new Error(
    "countVaultNotes is not implemented yet (packages/operational-store/src/vault-notes-store.ts)",
  );
}
