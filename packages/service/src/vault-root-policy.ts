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

/**
 * System trees that are never a vault or a project, in addition to
 * {@link FORBIDDEN_ROOTS}. On macOS `/etc`, `/tmp` and `/var` are symlinks
 * into `/private`, so the `/private` forms are what a realpath'd candidate
 * actually looks like.
 */
const SYSTEM_ROOTS: readonly string[] = [
  "/private",
  "/private/etc",
  "/private/var",
  "/private/tmp",
  "/usr",
  "/bin",
  "/sbin",
  "/opt",
];

/** The forbidden set in realpath form, computed once on first use. */
let resolvedForbiddenRoots: ReadonlySet<string> | null = null;

function forbiddenRootSet(): ReadonlySet<string> {
  if (resolvedForbiddenRoots === null) {
    const roots = new Set<string>();
    for (const literal of [...FORBIDDEN_ROOTS, ...SYSTEM_ROOTS]) {
      roots.add(literal);
      try {
        roots.add(realpathSync.native(literal));
      } catch {
        // An entry that does not resolve on this machine stays in literal
        // form only; nothing can realpath to it anyway.
      }
    }
    resolvedForbiddenRoots = roots;
  }
  return resolvedForbiddenRoots;
}

/**
 * True when `resolved` — an already-`realpathSync.native`'d path — is a
 * location this service will never adopt as a vault root or a project
 * (E-3, PR-06): any {@link FORBIDDEN_ROOTS} entry, the system trees above,
 * or a filesystem root (`dirname(x) === x`, which catches a volume root no
 * list names).
 *
 * The comparison is against the REALPATH form of every entry. The old check
 * compared a realpath'd candidate against the literals, and on macOS
 * `realpath("/etc")` is `/private/etc` — so the `/etc` entry could never
 * match and was inert. Resolving the list once, the same way the candidate
 * is resolved, makes both sides comparable.
 */
export function isForbiddenRoot(resolved: string): boolean {
  return dirname(resolved) === resolved || forbiddenRootSet().has(resolved);
}

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

  if (isForbiddenRoot(resolved)) {
    throw new VaultRootRefusedError(resolved, "forbidden-location");
  }

  if (!existsSync(join(resolved, OBSIDIAN_MARKER))) {
    throw new VaultRootRefusedError(resolved, "not-an-obsidian-vault");
  }
}
