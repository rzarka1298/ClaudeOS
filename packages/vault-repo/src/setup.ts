// RED-phase compile surface for plan 02-05.
//
// Every function body throws. The TYPES are real because they are the
// contract the tests assert against, not the behavior being driven out —
// the same split plan 02-01 established and recorded: `turbo run test`
// depends on `build`, and `tsc -b` type-checks this package's tests through
// project references, so a test importing a symbol that does not exist
// fails at BUILD time, never runs, and classifies as a fixture/load failure
// (INVALID_RED) rather than authorizing GREEN.

import type { WorkspaceId } from "@ccc/domain";

/** What one planned entry is: a directory, a generated index, or the
 * vault-level navigation file. */
export type VaultSetupEntryKind = "folder" | "index" | "claude-md";

/** One path setup would touch, and whether it is already there. */
export interface VaultSetupEntry {
  /** Vault-relative, POSIX-separated, e.g. `global/raw` or `inbox/index.md`. */
  readonly relativePath: string;
  readonly kind: VaultSetupEntryKind;
  /** Snapshot taken when the plan was computed. */
  readonly exists: boolean;
}

/** The show-paths-first contract (VAULT-01): exactly what setup would do. */
export interface VaultSetupPlan {
  readonly vaultRoot: string;
  readonly entries: readonly VaultSetupEntry[];
}

/** What one {@link initializeVault} run actually found and made. */
export interface VaultSetupResult {
  /** Vault-relative paths that did not exist before this run. */
  readonly created: readonly string[];
  /** Vault-relative paths that were already present. */
  readonly existing: readonly string[];
}

/** A newly minted workspace tree. */
export interface CreatedWorkspace {
  readonly workspaceId: WorkspaceId;
  /** Absolute path of `workspaces/<id>/`. */
  readonly path: string;
}

/**
 * Thrown when the vault root handed to setup does not exist, or exists but
 * is not a directory.
 */
export class VaultRootMissingError extends Error {
  readonly vaultRoot: string;

  constructor(vaultRoot: string) {
    super("vault root does not exist");
    this.name = "VaultRootMissingError";
    this.vaultRoot = vaultRoot;
  }
}

/** The single entry list both planning and applying walk. */
export function computeSetupEntries(_vaultRoot: string): readonly VaultSetupEntry[] {
  throw new Error("computeSetupEntries is not implemented yet");
}

/** Pure, read-only: returns the plan without writing anything. */
export function planVaultSetup(_vaultRoot: string): VaultSetupPlan {
  throw new Error("planVaultSetup is not implemented yet");
}

/** Creates the managed tree, regenerates every index, seeds CLAUDE.md. */
export function initializeVault(_vaultRoot: string): VaultSetupResult {
  throw new Error("initializeVault is not implemented yet");
}

/** Mints an opaque workspace ID and creates its knowledge tree. */
export function createWorkspace(_vaultRoot: string, _displayName: string): CreatedWorkspace {
  throw new Error("createWorkspace is not implemented yet");
}
