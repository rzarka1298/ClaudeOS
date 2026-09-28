import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Thrown when a caller names a directory that is real, absolute, and
 * NUL-free but is not something this service will adopt as a managed
 * vault.
 *
 * Carries the resolved path for the local redacting log only. Like
 * `PathNotAllowedError` and `WorkspaceScopeViolationError`, the message
 * itself is a constant that names nothing on disk.
 */
export class VaultRootRefusedError extends Error {
  readonly vaultRoot: string;

  constructor(vaultRoot: string, reason: VaultRootRefusalReason) {
    super("vault root refused");
    this.name = "VaultRootRefusedError";
    this.vaultRoot = vaultRoot;
    this.reason = reason;
  }

  readonly reason: VaultRootRefusalReason;
}

/** Why a root was refused — logged locally, never returned. */
export type VaultRootRefusalReason = "forbidden-location" | "not-an-obsidian-vault";

/**
 * Directories that are categorically not a personal knowledge vault.
 *
 * `homedir()` is in the list for the same reason `/` is: setting up there
 * would scatter nine managed folders and a `CLAUDE.md` across the user's
 * home directory, and — far worse — register the whole of it as THE
 * approved path root for every later handler.
 */
const FORBIDDEN_ROOTS: readonly string[] = [
  "/",
  "/Users",
  "/etc",
  "/System",
  "/Library",
  "/Applications",
  "/Volumes",
  homedir(),
];

/** The directory Obsidian itself creates in every vault. Its presence is
 * the only cheap, local, non-guessing evidence that a directory is a vault
 * rather than an arbitrary folder the caller happened to name. */
const OBSIDIAN_MARKER = ".obsidian";

/**
 * Refuses a vault root that is obviously not a vault (VAULT-01, threat
 * T-02-18).
 *
 * `VaultSetupRequestSchema` rejects relative paths and NUL bytes, and
 * `initializeVault` rejects a root that does not exist. Nothing rejected
 * `/`, `$HOME`, `/etc` or `/Users` — so a setup call against any of those
 * created nine managed folders plus `CLAUDE.md` there AND registered it
 * via `persistVaultRoot` as *the* approved path root, which (once Phase 4
 * wires `assertPathAllowed` into real handlers) is the allowlist for the
 * whole service.
 *
 * The plugin's confirmation modal does list the paths first, but the modal
 * is not the trust boundary: this route is, and it is reachable by
 * anything holding a bearer token. A check that lives only in the UI is a
 * check the API does not have.
 *
 * Applied by BOTH vault-setup routes, because a plan that described a
 * vault the apply would refuse would break VAULT-01's "the modal shows
 * exactly what setup will write".
 */
export function assertUsableVaultRoot(vaultRoot: string): void {
  let resolved: string;
  try {
    resolved = realpathSync.native(vaultRoot);
  } catch {
    // Non-existent is `initializeVault`'s own refusal (`VaultRootMissing`),
    // which says something different and maps to a different response. Let
    // it own that case.
    return;
  }

  // `dirname(x) === x` only at a filesystem root, which catches a volume
  // root the hard-coded list does not name.
  if (FORBIDDEN_ROOTS.includes(resolved) || dirname(resolved) === resolved) {
    throw new VaultRootRefusedError(resolved, "forbidden-location");
  }

  if (!existsSync(join(resolved, OBSIDIAN_MARKER))) {
    throw new VaultRootRefusedError(resolved, "not-an-obsidian-vault");
  }
}

// RED skeleton (plan 04-04 Task 2): realpath-form forbidden-root check.
export function isForbiddenRoot(_resolved: string): boolean {
  return false;
}
