import { lstat, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { hasControlCharacter, type ProtectedLocation } from "@ccc/domain";
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
 * Every candidate is resolved with `fs.promises.realpath` first (the native
 * realpath(3), same semantics as `realpathSync.native`), so a symlink or a
 * letter-case alias (APFS canonicalises case in the native realpath, not in
 * the JS one) is judged — and stored — as the one real folder it names.
 * Every filesystem call here is asynchronous: while macOS shows a Files &
 * Folders prompt the call can wait on the owner, and a synchronous one would
 * freeze the whole service until they answer (wave-4b review). It must then be a directory, and it must not be:
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
 * service is SILENTLY blocked by TCC under Documents, Desktop, Downloads,
 * iCloud Drive and File Provider cloud storage — there is no prompt to
 * explain. So `detectProtectedLocation`
 * is lexical only and runs before anything touches the filesystem; nothing
 * is read until the owner acknowledges. When a read does happen and TCC
 * refuses it, the EPERM/EACCES is classified as `access-denied`, never
 * propagated — and when the candidate reached a protected folder through a
 * symlink, the refusal names that folder so the route can explain it.
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
  | "control-characters"
  /** The vault root kept changing while the candidate was being validated (codex review 2). */
  | "policy-changed";

/**
 * Thrown when a candidate folder cannot be registered as a project. The
 * message is a constant that names nothing on disk; `candidate` is kept for
 * the local redacting log only (Shared Pattern 1, D-46).
 */
export class ProjectRefusedError extends Error {
  readonly candidate: string;
  readonly reason: ProjectRefusalReason;
  /**
   * For an `access-denied` refusal: the protected location the candidate
   * leads into through a symlink, when one can be named without reading
   * inside it (PR-10). The route turns this into the protected-location
   * explanation instead of the bare refusal. `null` otherwise.
   */
  readonly protectedLocation: ProtectedLocation | null;

  constructor(
    candidate: string,
    reason: ProjectRefusalReason,
    protectedLocation: ProtectedLocation | null = null,
  ) {
    super("project refused");
    this.name = "ProjectRefusedError";
    this.candidate = candidate;
    this.reason = reason;
    this.protectedLocation = protectedLocation;
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

/**
 * Resolves a policy location to the canonical form the candidate's realpath
 * is compared against. A location that does not exist (a vault whose folder
 * was deleted) resolves through its nearest existing ancestor: that
 * ancestor's realpath with the missing components re-joined. A purely
 * lexical fallback would keep a symlinked ancestor in the stored path
 * (`/var/…` is `/private/var/…` on macOS), so containment against the
 * candidate's realpath would silently miss (codex review 2, finding 2).
 */
async function resolveLocation(location: string): Promise<string> {
  const absolute = path.resolve(location);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Strict descendancy between two ALREADY-RESOLVED paths, compared
 * lexically. Both sides come from an asynchronous realpath (for a policy
 * location that does not exist, its nearest existing ancestor's realpath
 * with the rest re-joined — {@link resolveLocation}), so no second, synchronous
 * resolve is needed — `checkPathContainment` would re-resolve both with
 * `realpathSync.native` on the event loop.
 */
function lexicallyInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** True when `a` and `b` are the same folder or one contains the other. Both must be resolved. */
function sameOrNested(a: string, b: string): "same" | "a-inside-b" | "b-inside-a" | null {
  if (a === b) return "same";
  if (lexicallyInside(a, b)) return "a-inside-b";
  if (lexicallyInside(b, a)) return "b-inside-a";
  return null;
}

/**
 * Validates a candidate project folder and returns its realpath, which is
 * the form the store keeps and duplicate detection compares. Throws
 * {@link ProjectRefusedError} with the reason for every refusal.
 */
export async function validateProjectCandidate(
  candidate: string,
  context: RegistrationPolicyContext,
): Promise<string> {
  // Before any fs call: a control character is how one value becomes two
  // lines in a log or a generated script (D-04). The request schema already
  // refuses these; this keeps the policy total on its own.
  if (candidate.length === 0 || hasControlCharacter(candidate)) {
    throw new ProjectRefusedError(candidate, "control-characters");
  }

  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (err: unknown) {
    if (!isAccessError(err)) throw new ProjectRefusedError(candidate, "missing");
    // TCC refused the resolve. The lexical check already passed, so if the
    // candidate reaches a protected folder it does so through a symlink:
    // name that folder so the owner gets the explanation, not a bare refusal.
    throw new ProjectRefusedError(
      candidate,
      "access-denied",
      detectProtectedLocation(await followLinksLexically(candidate), context.homeDir),
    );
  }

  // The realpath is a DIFFERENT string when a symlink was followed: the
  // target's name is as capable of carrying a control character as the
  // candidate's, and it is the realpath that gets stored and logged.
  if (hasControlCharacter(resolved)) {
    throw new ProjectRefusedError(candidate, "control-characters");
  }

  let isDirectory: boolean;
  try {
    isDirectory = (await stat(resolved)).isDirectory();
  } catch (err: unknown) {
    throw new ProjectRefusedError(candidate, isAccessError(err) ? "access-denied" : "missing");
  }
  if (!isDirectory) {
    throw new ProjectRefusedError(candidate, "not-a-directory");
  }

  if (isForbiddenRoot(resolved)) {
    throw new ProjectRefusedError(candidate, "forbidden-location");
  }

  const home = await resolveLocation(context.homeDir);
  const homeRelation = sameOrNested(resolved, home);
  if (homeRelation === "same" || homeRelation === "b-inside-a") {
    throw new ProjectRefusedError(candidate, "forbidden-location");
  }

  if (sameOrNested(resolved, await resolveLocation(context.runtimeDir)) !== null) {
    throw new ProjectRefusedError(candidate, "runtime-dir");
  }

  if (context.vaultRoot !== null && context.vaultRoot.length > 0) {
    const vaultRelation = sameOrNested(resolved, await resolveLocation(context.vaultRoot));
    if (vaultRelation === "same" || vaultRelation === "a-inside-b") {
      throw new ProjectRefusedError(candidate, "inside-vault");
    }
    if (vaultRelation === "b-inside-a") {
      throw new ProjectRefusedError(candidate, "above-vault");
    }
  }

  return resolved;
}

/** How many symlinks {@link followLinksLexically} follows before giving up (the kernel's own order of magnitude). */
const MAX_LINK_HOPS = 32;

/**
 * Resolves `candidate`'s symlinks one component at a time using only
 * `lstat` and `readlink` on the components themselves, stopping at the first
 * component that cannot be examined (TCC refuses to look inside a protected
 * folder, which is where this is used) and appending the rest lexically.
 * Never reads a directory's contents or follows anything past a refusal, so
 * it names where a link LEADS without reading what is there.
 */
async function followLinksLexically(candidate: string): Promise<string> {
  const pending = path
    .resolve(candidate)
    .split("/")
    .filter((part) => part.length > 0);
  let current = "/";
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    const next = path.join(current, part);
    let target: string | null = null;
    try {
      if ((await lstat(next)).isSymbolicLink()) target = await readlink(next);
    } catch {
      return path.join(next, ...pending);
    }
    if (target === null) {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > MAX_LINK_HOPS) return path.join(next, ...pending);
    const linked = path.resolve(current, target);
    pending.unshift(...linked.split("/").filter((p) => p.length > 0));
    current = "/";
  }
  return current;
}

/** Home-relative folders macOS guards with TCC, in match order. */
const PROTECTED_FOLDERS: ReadonlyArray<readonly [string, ProtectedLocation]> = [
  ["Documents", "documents"],
  ["Desktop", "desktop"],
  ["Downloads", "downloads"],
  ["Library/Mobile Documents", "icloud-drive"],
  ["Library/CloudStorage", "cloud-storage"],
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
