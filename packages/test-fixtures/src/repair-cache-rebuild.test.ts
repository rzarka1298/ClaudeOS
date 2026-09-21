// The repair → cache contract (VAULT-04 + PERF-06), end to end across two
// packages that deliberately do not know about each other.
//
// `@ccc/vault-repo` never imports `@ccc/operational-store` — that edge would
// breach the layering `ci:boundaries` enforces, and it is why `repairVault`
// returns RECORDS rather than writing rows itself. The composition happens
// one layer up, which is exactly what this test stands in for until the
// service-side caller lands (ADR-0022, Phase 6).
//
// Two populations paths are exercised, because ADR-0022 names both:
//   - the BULK path, `rebuildVaultNotes`, fed by repair's single walk. This
//     is the only path in Phase 2 with a real caller.
//   - the PER-WRITE seam, `upsertVaultNote`, fed by a real `writeNote`
//     return value. Its production caller is the first service-side
//     note-write route (Phase 6); wiring it to genuine `WrittenNote` output
//     here is what keeps the two shapes from drifting in the meantime.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { globalScope, LIFECYCLE_STAGES, type NoteFrontmatter, type NoteId } from "@ccc/domain";
import {
  applyMigrations,
  countVaultNotes,
  openStore,
  queryVaultNotes,
  rebuildVaultNotes,
  upsertVaultNote,
  type VaultNoteRecord,
} from "@ccc/operational-store";
import { initializeVault, repairVault, writeNote } from "@ccc/vault-repo";
import { describe, expect, it } from "vitest";
import { generateSyntheticNotes, writeSyntheticVault } from "./synthetic-notes.js";
import { withTempVaultDir } from "./vault-fixture.js";

/** Large enough to be a real walk over a real tree, small enough to stay a
 * unit-speed test. The 10,000-row scale question is PERF-06's, answered by
 * `vault-notes-perf.test.ts`. */
const NOTE_COUNT = 200;

const TEST_BASE = join(homedir(), ".ccc-test");

/**
 * The composition ADR-0022 puts in the service layer: a walked note becomes
 * a cache row. Deliberately written here rather than exported from either
 * package — neither `@ccc/vault-repo` (which must not know the cache exists)
 * nor `@ccc/operational-store` (which must not know what a note file is) is
 * the right home for it.
 */
function toVaultNoteRecord(path: string, frontmatter: NoteFrontmatter): VaultNoteRecord {
  return {
    noteId: frontmatter.id as NoteId,
    path,
    scope: frontmatter.scope,
    stage: frontmatter.stage,
    aiGenerated: frontmatter.aiGenerated,
    claimType: frontmatter.claimType ?? null,
    confidence: frontmatter.confidence,
    createdAt: frontmatter.created,
    updatedAt: frontmatter.updated,
    contentHash: frontmatter.contentHash ?? null,
  };
}

/**
 * Runs `fn` with an initialized vault holding `NOTE_COUNT` synthetic notes
 * and a migrated, file-backed operational store.
 *
 * The database lives OUTSIDE the vault on purpose: PRD §9.5 puts operational
 * state in the private store and keeps the vault for durable user-facing
 * knowledge, and a test that drops a `.db` into the vault it is about to
 * walk would be quietly contradicting the thing it is testing.
 */
async function withVaultAndStore(
  fn: (context: {
    vaultRoot: string;
    db: ReturnType<typeof openStore>["db"];
  }) => Promise<void> | void,
): Promise<void> {
  await withTempVaultDir(async ({ vaultRoot }) => {
    mkdirSync(TEST_BASE, { recursive: true });
    const storeDir = mkdtempSync(join(TEST_BASE, "vstore-"));
    const store = openStore(join(storeDir, "operational.db"));
    try {
      applyMigrations(store.db);
      initializeVault(vaultRoot);
      writeSyntheticVault(vaultRoot, NOTE_COUNT);
      await fn({ vaultRoot, db: store.db });
    } finally {
      store.close();
      rmSync(storeDir, { recursive: true, force: true });
    }
  });
}

describe("repair rebuilds the note-metadata cache from its own single walk", () => {
  it("populates every row from repairVault's records and answers a stage-filtered query", async () => {
    await withVaultAndStore(({ vaultRoot, db }) => {
      const report = repairVault(vaultRoot);

      // The walk found the whole fixture and nothing ambiguous about it.
      expect(report.warnings).toEqual([]);
      expect(report.notes).toHaveLength(NOTE_COUNT);

      rebuildVaultNotes(
        db,
        report.notes.map((note) => toVaultNoteRecord(note.path, note.frontmatter)),
      );

      expect(countVaultNotes(db)).toBe(NOTE_COUNT);

      // Cross-checked against the fixture's OWN records rather than against
      // a hardcoded distribution: this asserts that what repair read off
      // disk agrees with what the generator intended, which a hand-written
      // expectation could not distinguish from both being wrong together.
      const fixture = generateSyntheticNotes(NOTE_COUNT);
      for (const stage of LIFECYCLE_STAGES) {
        const expected = fixture.filter((record) => record.stage === stage).length;
        expect(expected).toBeGreaterThan(0);
        expect(`${stage}=${queryVaultNotes(db, { stage }).length}`).toBe(`${stage}=${expected}`);
      }

      expect(
        queryVaultNotes(db)
          .map((record) => record.path)
          .sort(),
      ).toEqual(fixture.map((record) => record.path).sort());
      expect(
        queryVaultNotes(db, { scope: globalScope() }).every(
          (record) => record.scope === globalScope(),
        ),
      ).toBe(true);
    });
  });

  it("keeps the cache current through the per-write seam: a real writeNote result upserted", async () => {
    await withVaultAndStore(({ vaultRoot, db }) => {
      rebuildVaultNotes(
        db,
        repairVault(vaultRoot).notes.map((note) => toVaultNoteRecord(note.path, note.frontmatter)),
      );
      expect(countVaultNotes(db)).toBe(NOTE_COUNT);

      // One more note through the REAL write path, then the same mapping a
      // service route will apply to the same `WrittenNote` shape.
      const written = writeNote({
        vaultRoot,
        relativePath: "global/wiki/one-more.md",
        body: "# One more\n\nWritten after the rebuild.\n",
        scope: globalScope(),
        stage: "wiki",
        generatedBy: { skill: "repair-cache-rebuild-test" },
        aiGenerated: false,
        confidence: "verified",
      });
      const notePath = relative(vaultRoot, written.path).split(sep).join("/");

      upsertVaultNote(db, toVaultNoteRecord(notePath, written.frontmatter));

      expect(countVaultNotes(db)).toBe(NOTE_COUNT + 1);
      const found = queryVaultNotes(db, { scope: globalScope() }).find(
        (record) => record.noteId === written.noteId,
      );
      expect(found?.path).toBe("global/wiki/one-more.md");
      expect(found?.stage).toBe("wiki");
      expect(found?.contentHash).toBe(written.frontmatter.contentHash);

      // And a full repair AFTER the extra write agrees with the incremental
      // upsert — the two population paths converge on the same cache rather
      // than drifting apart.
      const rewalked = repairVault(vaultRoot);
      expect(rewalked.warnings).toEqual([]);
      rebuildVaultNotes(
        db,
        rewalked.notes.map((note) => toVaultNoteRecord(note.path, note.frontmatter)),
      );
      expect(countVaultNotes(db)).toBe(NOTE_COUNT + 1);
    });
  });
});
