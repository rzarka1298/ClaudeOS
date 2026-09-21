import type { OperationalStore } from "@ccc/operational-store";
import { registerApprovedRoot } from "./path-allowlist.js";

/**
 * The `service_meta` key the managed vault root is persisted under.
 *
 * The root lives in the service's PRIVATE operational store and nowhere
 * else (threat T-02-18): it is re-registered into the path allowlist only
 * from this key, so the set of approved roots after a restart is exactly
 * the set an authenticated caller explicitly set up — never something a
 * request can widen on the way back in.
 */
export const VAULT_ROOT_META_KEY = "vault_root";

/**
 * Persists `vaultRoot` as THE managed vault root for this installation and
 * registers it immediately, so the allowlist is correct for the rest of
 * this process's lifetime rather than only after the next restart.
 *
 * One vault root, not a growing set: a second setup run against a
 * different directory REPLACES the persisted value (`service_meta` is
 * keyed), which is what keeps "the approved roots are what the owner set
 * up" true across restarts instead of accumulating every path ever named.
 */
export function persistVaultRoot(store: OperationalStore, vaultRoot: string): void {
  store.writeServiceMeta(VAULT_ROOT_META_KEY, vaultRoot);
  registerApprovedRoot(vaultRoot);
}

/**
 * Startup hook: re-registers the persisted managed vault root as an
 * approved path root, so the allowlist survives a service restart.
 * Returns the root it registered, or `null` when none is persisted yet —
 * a fresh install denies every path until setup runs, which is the
 * deny-by-default `assertPathAllowed` already guarantees and this function
 * must not weaken.
 *
 * Extracted from `main.ts` deliberately: `main.ts` runs the whole service
 * on import, so a test that exercised this through the entry point could
 * not do so without booting everything.
 */
export function registerPersistedVaultRoot(store: OperationalStore): string | null {
  const vaultRoot = store.readServiceMeta(VAULT_ROOT_META_KEY);
  if (vaultRoot === null || vaultRoot.length === 0) return null;
  registerApprovedRoot(vaultRoot);
  return vaultRoot;
}
