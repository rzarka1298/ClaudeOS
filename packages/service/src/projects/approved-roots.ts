import { listProjects, type OperationalStore } from "@ccc/operational-store";
import { setApprovedRoots } from "../path-allowlist.js";

/**
 * The `service_meta` key the managed vault root is persisted under.
 *
 * Declared here rather than in `vault-root.ts` (which re-exports it) so the
 * recompute below can read it without `vault-root.ts` and this module
 * importing each other.
 */
export const VAULT_ROOT_META_KEY = "vault_root";

/**
 * The approved-root registry as a pure function of the store (D-05, threat
 * T-04-04): the persisted managed vault root, if any, plus every registered
 * project's stored realpath. REPLACES the registry with exactly that set and
 * returns it.
 *
 * It runs at startup, after vault setup and after every project register or
 * remove, and it is the only writer of the registry for projects. That is
 * the A-05 fix: vault setup used to call `setApprovedRoots([vaultRoot])`,
 * which silently revoked every project root for the rest of the process, and
 * a removed project stayed approved until restart. Computing the whole set
 * from one source makes both bugs structurally impossible.
 *
 * Rejected alternative: `registerApprovedRoot` (additive) for each new
 * project. Additive registration cannot express removal, and it lets the
 * in-memory set drift from the store for as long as the process lives — the
 * same widening `vault-root.ts` already documents for the vault root.
 */
export function recomputeApprovedRoots(store: OperationalStore): readonly string[] {
  const vaultRoot = store.readServiceMeta(VAULT_ROOT_META_KEY);
  const roots = [
    ...(vaultRoot !== null && vaultRoot.length > 0 ? [vaultRoot] : []),
    ...registeredProjectPaths(store),
  ];
  setApprovedRoots(roots);
  return roots;
}

/**
 * Every registered project's stored realpath, or none on a store that has
 * not been migrated to hold projects. Vault setup judges a candidate root
 * against these (D-04).
 */
export function registeredProjectPaths(store: OperationalStore): readonly string[] {
  return hasProjectsTable(store) ? listProjects(store.db).map((project) => project.path) : [];
}

/**
 * True once migration 0002 has created the projects table. A store that has
 * not been migrated has no registered projects by definition; the service
 * itself always migrates before this runs (ADR-0018), but a store opened
 * without migrations (the Phase 2 vault-setup route tests) must still be
 * able to persist a vault root.
 */
function hasProjectsTable(store: OperationalStore): boolean {
  return (
    store.db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
      .get() !== undefined
  );
}
