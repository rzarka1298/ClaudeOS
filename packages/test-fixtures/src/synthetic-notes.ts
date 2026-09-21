import type { VaultNoteRecord } from "@ccc/operational-store";

/**
 * The default seed every synthetic-vault helper uses when a caller does
 * not supply one. Fixed so that "the 10,000-note fixture" means the same
 * 10,000 notes in every run, on every machine.
 */
export const DEFAULT_SYNTHETIC_SEED = 20260921;

/**
 * `count` synthetic {@link VaultNoteRecord}s with a realistic spread:
 * roughly twenty workspaces plus the global scope, and every one of the
 * six lifecycle stages represented.
 *
 * Deterministic by construction — the same `seed` always produces the same
 * records — so a perf number measured against this fixture is comparable
 * across runs rather than being re-rolled each time.
 */
export function generateSyntheticNotes(
  count: number,
  seed: number = DEFAULT_SYNTHETIC_SEED,
): VaultNoteRecord[] {
  void count;
  void seed;
  throw new Error(
    "generateSyntheticNotes is not implemented yet (packages/test-fixtures/src/synthetic-notes.ts)",
  );
}

/**
 * Materializes `count` REAL notes on disk under `vaultRoot` — full
 * provenance frontmatter serialized by `stringifyNote`, so every file
 * parses back through `parseNote`. Returns the absolute paths written.
 *
 * Used by the naive-scan benchmark here, and by the repair-at-scale test
 * in plan 02-06.
 */
export function writeSyntheticVault(
  vaultRoot: string,
  count: number,
  seed: number = DEFAULT_SYNTHETIC_SEED,
): string[] {
  void vaultRoot;
  void count;
  void seed;
  throw new Error(
    "writeSyntheticVault is not implemented yet (packages/test-fixtures/src/synthetic-notes.ts)",
  );
}
