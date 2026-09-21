import type { NoteFrontmatter } from "@ccc/domain";

/**
 * The three conditions repair FLAGS rather than resolves.
 *
 * Every one of them is a state where the vault's ground truth is ambiguous,
 * and repair's contract is to surface the ambiguity with enough detail for a
 * human to settle it — never to pick a winner. This mirrors the operational
 * store's `SchemaAheadOfCodeError` discipline: a tool that silently guesses
 * on an ambiguous input is worse than one that refuses, because the guess is
 * invisible.
 */
export type RepairWarningKind = "duplicate-id" | "orphaned-index-entry" | "invalid-frontmatter";

/** One flagged condition, carrying every path involved in it. */
export interface RepairWarning {
  readonly kind: RepairWarningKind;
  /** Vault-relative, POSIX-separated paths, sorted. */
  readonly paths: readonly string[];
  /** Human-readable specifics; deterministic for a given vault state. */
  readonly detail: string;
}

/** One valid note the walk found, reduced to what a cache rebuild needs. */
export interface RepairedNote {
  /** Vault-relative, POSIX-separated path of the note file. */
  readonly path: string;
  readonly frontmatter: NoteFrontmatter;
}

/** What one {@link repairVault} run found and regenerated. */
export interface RepairReport {
  /** Valid, unambiguous notes, sorted by `created`, then `id`, then path. */
  readonly notes: readonly RepairedNote[];
  /** Flagged conditions, sorted by kind, then path, then detail. */
  readonly warnings: readonly RepairWarning[];
}

/**
 * Rebuilds every derived artifact in the managed vault from note
 * frontmatter (VAULT-04).
 *
 * Read-only with respect to note bodies: the only file this function ever
 * writes is an `index.md`, and it writes those through the same
 * `regenerateIndex` the ordinary write path uses, so there is exactly one
 * index generator and no possibility of a repaired index differing from a
 * freshly-written one.
 */
export function repairVault(_vaultRoot: string): RepairReport {
  throw new Error("repairVault is not implemented yet (packages/vault-repo/src/repair.ts)");
}
