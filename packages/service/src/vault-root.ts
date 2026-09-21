import type { OperationalStore } from "@ccc/operational-store";

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

/** Persists `vaultRoot` as THE managed vault root for this installation. */
export function persistVaultRoot(_store: OperationalStore, _vaultRoot: string): void {
  throw new Error("persistVaultRoot is not implemented yet");
}

/**
 * Startup hook: re-registers the persisted managed vault root as an
 * approved path root, so the allowlist survives a service restart.
 * Returns the root it registered, or `null` when none is persisted yet.
 *
 * Extracted from `main.ts` deliberately — `main.ts` runs the whole service
 * on import, so a test that needed to exercise this through the entry
 * point could not do so without booting everything.
 */
export function registerPersistedVaultRoot(_store: OperationalStore): string | null {
  throw new Error("registerPersistedVaultRoot is not implemented yet");
}
