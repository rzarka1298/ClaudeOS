import type { OperationalStore } from "@ccc/operational-store";
import { recomputeApprovedRoots, VAULT_ROOT_META_KEY } from "./projects/approved-roots.js";

/**
 * The `service_meta` key the managed vault root is persisted under.
 *
 * The root lives in the service's PRIVATE operational store and nowhere
 * else (threat T-02-18): it is re-registered into the path allowlist only
 * from this key, so the set of approved roots after a restart is exactly
 * the set an authenticated caller explicitly set up — never something a
 * request can widen on the way back in.
 */
export { VAULT_ROOT_META_KEY };

/**
 * Persists `vaultRoot` as THE managed vault root for this installation and
 * recomputes the approved roots immediately, so the allowlist is correct
 * for the rest of this process's lifetime rather than only after the next
 * restart.
 *
 * One vault root, not a growing set: a second setup run against a
 * different directory REPLACES the persisted value (`service_meta` is
 * keyed), and the recompute then approves the new root and drops the old
 * one. The registry is recomputed from the store as a whole (D-05,
 * `recomputeApprovedRoots`): the vault root plus every registered project.
 * This used to replace the registry with the vault root alone, which fixed the old
 * "previous vault stays approved" gap but introduced A-05 — re-running
 * setup revoked every registered project root for the rest of the process.
 * One function computing the whole set from one source closes both.
 */
export function persistVaultRoot(store: OperationalStore, vaultRoot: string): void {
  store.writeServiceMeta(VAULT_ROOT_META_KEY, vaultRoot);
  recomputeApprovedRoots(store);
}

/**
 * Startup hook: recomputes the approved roots from the store, so the
 * persisted vault root (and every registered project) survives a service
 * restart. Returns the vault root it found, or `null` when none is
 * persisted yet — a fresh install with no projects denies every path until
 * setup runs, which is the deny-by-default `assertPathAllowed` already
 * guarantees and this function must not weaken.
 *
 * Extracted from `main.ts` deliberately: `main.ts` runs the whole service
 * on import, so a test that exercised this through the entry point could
 * not do so without booting everything.
 */
export function registerPersistedVaultRoot(store: OperationalStore): string | null {
  recomputeApprovedRoots(store);
  const vaultRoot = store.readServiceMeta(VAULT_ROOT_META_KEY);
  if (vaultRoot === null || vaultRoot.length === 0) return null;
  return vaultRoot;
}
