// Owned by Phase 2 (managed vault initializer, note schemas, index
// generation). This package exists now, with an empty functional surface,
// so the import-boundary lint (REPO-03, plan 01-03) has a real package to
// constrain from day one.

/** The managed Obsidian vault: `global/` and `workspaces/<id>/` scopes. */
export interface VaultRepository {
  readonly vaultRoot: string;
}
