import { randomBytes } from "node:crypto";
import type { SecretStore } from "@ccc/keychain";

const DEFAULT_ACCOUNT = "install-secret";

let cachedSecret: Buffer | undefined;

function resolveAccount(): string {
  // Test-only escape hatch, the same pattern already established by
  // CCC_SOCKET_PATH/CCC_RUNTIME_DIR (packages/service/src/paths.ts): lets
  // an integration test point the service at a fresh, throwaway Keychain
  // item instead of colliding with — or ever leaving behind — a real
  // installation's own `install-secret` entry. Production always resolves
  // to the default account name.
  return process.env.CCC_INSTALL_SECRET_ACCOUNT ?? DEFAULT_ACCOUNT;
}

/**
 * Reads the per-install secret from `store`; generates one via
 * `randomBytes(32)` and persists it through `store` on first use if
 * absent. Cached in module scope for the process lifetime so `store` is
 * consulted at most once per process start.
 *
 * This module is the only place in the repository that reads or writes
 * the `install-secret` account (SVC-09) — the secret never touches the
 * operational store, the managed vault, or a log line, only whatever
 * `SecretStore` implementation the caller supplies.
 */
export async function getInstallSecret(store: SecretStore): Promise<Buffer> {
  if (cachedSecret) return cachedSecret;

  const account = resolveAccount();
  const existing = await store.get(account);
  if (existing !== null) {
    cachedSecret = Buffer.from(existing, "base64");
    return cachedSecret;
  }

  const generated = randomBytes(32);
  await store.set(account, generated.toString("base64"));
  cachedSecret = generated;
  return cachedSecret;
}
