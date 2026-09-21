import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NoteId } from "@ccc/domain";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrate.js";
import {
  countVaultNotes,
  getVaultNote,
  InvalidVaultNoteError,
  queryVaultNotes,
  rebuildVaultNotes,
  upsertVaultNote,
  type VaultNoteRecord,
} from "./vault-notes-store.js";

const REAL_MIGRATIONS_DIR = join(import.meta.dirname, "../migrations");

// Two well-formed scopes: nine base-36 timestamp characters plus a
// sixteen-character suffix, matching what `newWorkspaceId()` mints.
const WORKSPACE_A = "workspace:aaaaaaaaa0123456789abcdef";
const WORKSPACE_B = "workspace:bbbbbbbbb0123456789abcdef";

let dir: string;
let db: Database.Database;

function note(
  overrides: Partial<Omit<VaultNoteRecord, "noteId">> & { noteId: string },
): VaultNoteRecord {
  return {
    path: `global/wiki/${overrides.noteId}.md`,
    scope: "global",
    stage: "wiki",
    aiGenerated: false,
    claimType: null,
    confidence: "verified",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    contentHash: null,
    ...overrides,
    noteId: overrides.noteId as NoteId,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-vault-notes-"));
  db = new Database(join(dir, "operational.db"));
  applyMigrations(db, REAL_MIGRATIONS_DIR);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("vault_notes cache", () => {
  it("round-trips every column through upsert and get-by-id", () => {
    const record = note({
      noteId: "note-round-trip",
      path: "workspaces/aaaaaaaaa0123456789abcdef/synthesis/alpha.md",
      scope: WORKSPACE_A,
      stage: "synthesis",
      aiGenerated: true,
      claimType: "inference",
      confidence: "inferred",
      createdAt: "2026-02-03T04:05:06.000Z",
      updatedAt: "2026-02-04T05:06:07.000Z",
      contentHash: "a".repeat(64),
    });

    upsertVaultNote(db, record);

    expect(getVaultNote(db, record.noteId)).toEqual(record);
  });

  it("returns null for a note that was never cached", () => {
    expect(getVaultNote(db, "absent" as NoteId)).toBeNull();
  });

  it("keeps exactly one row per note id when the same note is upserted twice, holding the later values", () => {
    upsertVaultNote(db, note({ noteId: "note-upsert", stage: "raw", confidence: "unverified" }));
    upsertVaultNote(
      db,
      note({
        noteId: "note-upsert",
        stage: "wiki",
        confidence: "verified",
        updatedAt: "2026-03-03T00:00:00.000Z",
      }),
    );

    expect(countVaultNotes(db)).toBe(1);
    const stored = getVaultNote(db, "note-upsert" as NoteId);
    expect(stored?.stage).toBe("wiki");
    expect(stored?.confidence).toBe("verified");
    expect(stored?.updatedAt).toBe("2026-03-03T00:00:00.000Z");
  });

  it("filters by scope, by stage, by both together, and returns everything when no filter is given", () => {
    rebuildVaultNotes(db, [
      note({ noteId: "a-wiki", scope: WORKSPACE_A, stage: "wiki" }),
      note({ noteId: "a-raw", scope: WORKSPACE_A, stage: "raw" }),
      note({ noteId: "b-wiki", scope: WORKSPACE_B, stage: "wiki" }),
      note({ noteId: "g-raw", scope: "global", stage: "raw" }),
    ]);

    const ids = (records: VaultNoteRecord[]) => records.map((r) => r.noteId).sort();

    expect(ids(queryVaultNotes(db, { scope: WORKSPACE_A }))).toEqual(["a-raw", "a-wiki"]);
    expect(ids(queryVaultNotes(db, { stage: "wiki" }))).toEqual(["a-wiki", "b-wiki"]);
    expect(ids(queryVaultNotes(db, { scope: WORKSPACE_A, stage: "wiki" }))).toEqual(["a-wiki"]);
    expect(ids(queryVaultNotes(db))).toEqual(["a-raw", "a-wiki", "b-wiki", "g-raw"]);
  });

  it("leaves the previous cache intact when a rebuild throws part-way, because the whole rebuild is one transaction", () => {
    rebuildVaultNotes(db, [note({ noteId: "keep-1" }), note({ noteId: "keep-2" })]);
    const before = countVaultNotes(db);
    expect(before).toBe(2);

    expect(() =>
      rebuildVaultNotes(db, [
        note({ noteId: "new-1" }),
        // Invalid stage: the guard fires mid-batch, after the delete and
        // after a valid insert have already run inside the transaction.
        note({ noteId: "new-2", stage: "not-a-stage" as VaultNoteRecord["stage"] }),
        note({ noteId: "new-3" }),
      ]),
    ).toThrow(InvalidVaultNoteError);

    expect(countVaultNotes(db)).toBe(before);
    expect(
      queryVaultNotes(db)
        .map((r) => r.noteId)
        .sort(),
    ).toEqual(["keep-1", "keep-2"]);
  });

  it("replaces the whole cache on a successful rebuild", () => {
    rebuildVaultNotes(db, [note({ noteId: "old-1" }), note({ noteId: "old-2" })]);
    rebuildVaultNotes(db, [note({ noteId: "fresh-1" })]);

    expect(countVaultNotes(db)).toBe(1);
    expect(queryVaultNotes(db)[0]?.noteId).toBe("fresh-1");
  });

  it("reproduces identical query results after the cache is dropped and rebuilt from the same records", () => {
    const records = [
      note({ noteId: "d-1", scope: WORKSPACE_A, stage: "wiki" }),
      note({ noteId: "d-2", scope: WORKSPACE_A, stage: "raw" }),
      note({ noteId: "d-3", scope: WORKSPACE_B, stage: "wiki" }),
    ];
    rebuildVaultNotes(db, records);
    const first = queryVaultNotes(db, { scope: WORKSPACE_A });

    db.prepare("DELETE FROM vault_notes").run();
    expect(countVaultNotes(db)).toBe(0);
    rebuildVaultNotes(db, records);

    expect(queryVaultNotes(db, { scope: WORKSPACE_A })).toEqual(first);
  });

  describe("untrusted read-back guard", () => {
    it("refuses a record whose stage is outside the lifecycle union", () => {
      expect(() =>
        upsertVaultNote(db, note({ noteId: "bad", stage: "archived" as VaultNoteRecord["stage"] })),
      ).toThrow(InvalidVaultNoteError);
      expect(countVaultNotes(db)).toBe(0);
    });

    it("refuses a record whose confidence is outside the confidence union", () => {
      expect(() =>
        upsertVaultNote(
          db,
          note({ noteId: "bad", confidence: "probably" as VaultNoteRecord["confidence"] }),
        ),
      ).toThrow(InvalidVaultNoteError);
      expect(countVaultNotes(db)).toBe(0);
    });

    it("refuses a record whose claim type is outside the claim-type union", () => {
      expect(() =>
        upsertVaultNote(
          db,
          note({ noteId: "bad", claimType: "gossip" as VaultNoteRecord["claimType"] }),
        ),
      ).toThrow(InvalidVaultNoteError);
      expect(countVaultNotes(db)).toBe(0);
    });

    it("accepts a null claim type, which records an unknown claim rather than an invalid one", () => {
      upsertVaultNote(db, note({ noteId: "ok", claimType: null }));
      expect(getVaultNote(db, "ok" as NoteId)?.claimType).toBeNull();
    });
  });

  it("stores no note content: the cache schema has no body, content, or excerpt column", () => {
    const columns = db
      .prepare("PRAGMA table_info(vault_notes)")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(columns.length).toBeGreaterThan(0);
    for (const forbidden of ["body", "content", "excerpt", "text", "markdown"]) {
      expect(columns).not.toContain(forbidden);
    }
  });
});
