import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { checkPathContainment, hasControlCharacter, type ProtectedLocation } from "@ccc/domain";
import { isForbiddenRoot } from "../vault-root-policy.js";

/**
 * Registration policy for project folders (D-04, D-29, PR-04, PR-06,
 * PR-10, threats T-04-03 and T-04-28).
 *
 * Registering a folder adds it to the approved-root allowlist, so this
 * policy is what stands between an authenticated request and "the service
 * may read and launch into this directory". The route, not the plugin's
 * folder picker, is the trust boundary.
 *
 * Every candidate is resolved with `realpathSync.native` first, so a symlink
 * or a letter-case alias (APFS canonicalises case in the native realpath,
 * not in the JS one) is judged — and stored — as the one real folder it
 * names. It must then be a directory, and it must not be:
 * - a forbidden system location, compared in realpath form (`isForbiddenRoot`,
 *   the E-3 fix: `/etc` is `/private/etc` once resolved);
 * - the home directory or anything above it;
 * - the service's own runtime directory, anything inside it or anything
 *   above it — registering an ancestor would approve the socket, the
 *   database and the launch-script directory as part of a "project";
 * - the managed vault root, anything inside it (the vault is already
 *   approved and has its own rules) or anything above it.
 *
 * Protected locations (D-29 as amended by PR-04/PR-10): a launchd-run
 * service is SILENTLY blocked by TCC under Documents, Desktop, Downloads and
 * iCloud Drive — there is no prompt to explain. So `detectProtectedLocation`
 * is lexical only and runs before anything touches the filesystem; nothing
 * is read until the owner acknowledges. When a read does happen and TCC
 * refuses it, the EPERM/EACCES is classified as `access-denied`, never
 * propagated.
 *
 * Rejected alternative: refusing protected locations outright. Some owners
 * keep code under Documents on purpose; the acknowledgement lets them choose
 * with the consequence stated.
 */

/** Why a candidate folder was refused — logged locally, never returned. */
export type ProjectRefusalReason =
  | "missing"
  | "not-a-directory"
  | "forbidden-location"
  | "inside-vault"
  | "above-vault"
  | "runtime-dir"
  | "access-denied"
  | "control-characters";

/**
 * Thrown when a candidate folder cannot be registered as a project. The
 * message is a constant that names nothing on disk; `candidate` is kept for
 * the local redacting log only (Shared Pattern 1, D-46).
 */
export class ProjectRefusedError extends Error {
  readonly candidate: string;
  readonly reason: ProjectRefusalReason;

  constructor(candidate: string, reason: ProjectRefusalReason) {
    super("project refused");
    this.name = "ProjectRefusedError";
    this.candidate = candidate;
    this.reason = reason;
  }
}

/** The locations a candidate is judged against. */
export interface RegistrationPolicyContext {
  readonly homeDir: string;
  readonly runtimeDir: string;
  /** The persisted managed vault root, or `null` before vault setup has run. */
  readonly vaultRoot: string | null;
}

function isAccessError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "EPERM" || code === "EACCES";
}

/** Resolves a policy location, falling back to its lexical form when it does not exist. */
function resolveLocation(location: string): string {
  try {
    return realpathSync.native(location);
  } catch {
    return path.resolve(location);
  }
}

/** True when `a` and `b` are the same folder or one contains the other. */
function sameOrNested(a: string, b: string): "same" | "a-inside-b" | "b-inside-a" | null {
  if (a === b) return "same";
  if (checkPathContainment(a, b).contained) return "a-inside-b";
  if (checkPathContainment(b, a).contained) return "b-inside-a";
  return null;
}

/**
 * Validates a candidate project folder and returns its realpath, which is
 * the form the store keeps and duplicate detection compares. Throws
 * {@link ProjectRefusedError} with the reason for every refusal.
 */
export function validateProjectCandidate(
  candidate: string,
  context: RegistrationPolicyContext,
): string {
  // Before any fs call: a control character is how one value becomes two
  // lines in a log or a generated script (D-04). The request schema already
  // refuses these; this keeps the policy total on its own.
  if (candidate.length === 0 || hasControlCharacter(candidate)) {
    throw new ProjectRefusedError(candidate, "control-characters");
  }

  let resolved: string;
  try {
    resolved = realpathSync.native(candidate);
  } catch (err: unknown) {
    throw new ProjectRefusedError(candidate, isAccessError(err) ? "access-denied" : "missing");
  }

  let isDirectory: boolean;
  try {
    isDirectory = statSync(resolved).isDirectory();
  } catch (err: unknown) {
    throw new ProjectRefusedError(candidate, isAccessError(err) ? "access-denied" : "missing");
  }
  if (!isDirectory) {
    throw new ProjectRefusedError(candidate, "not-a-directory");
  }

  if (isForbiddenRoot(resolved)) {
    throw new ProjectRefusedError(candidate, "forbidden-location");
  }

  const home = resolveLocation(context.homeDir);
  const homeRelation = sameOrNested(resolved, home);
  if (homeRelation === "same" || homeRelation === "b-inside-a") {
    throw new ProjectRefusedError(candidate, "forbidden-location");
  }

  if (sameOrNested(resolved, resolveLocation(context.runtimeDir)) !== null) {
    throw new ProjectRefusedError(candidate, "runtime-dir");
  }

  if (context.vaultRoot !== null && context.vaultRoot.length > 0) {
    const vaultRelation = sameOrNested(resolved, resolveLocation(context.vaultRoot));
    if (vaultRelation === "same" || vaultRelation === "a-inside-b") {
      throw new ProjectRefusedError(candidate, "inside-vault");
    }
    if (vaultRelation === "b-inside-a") {
      throw new ProjectRefusedError(candidate, "above-vault");
    }
  }

  return resolved;
}

/** Home-relative folders macOS guards with TCC, in match order. */
const PROTECTED_FOLDERS: ReadonlyArray<readonly [string, ProtectedLocation]> = [
  ["Documents", "documents"],
  ["Desktop", "desktop"],
  ["Downloads", "downloads"],
  ["Library/Mobile Documents", "icloud-drive"],
];

/**
 * Names the protected location `candidate` sits in (or is), or `null`.
 * LEXICAL ONLY — `path.resolve`, never a filesystem call — so it can run
 * before the owner has acknowledged anything. Compared case-insensitively
 * because APFS is: `~/documents` is the same folder as `~/Documents`.
 */
export function detectProtectedLocation(
  candidate: string,
  homeDir: string,
): ProtectedLocation | null {
  const target = path.resolve(candidate).toLowerCase();
  const home = path.resolve(homeDir).toLowerCase();
  for (const [folder, location] of PROTECTED_FOLDERS) {
    const protectedRoot = path.join(home, folder.toLowerCase());
    if (target === protectedRoot || target.startsWith(`${protectedRoot}/`)) {
      return location;
    }
  }
  return null;
}
