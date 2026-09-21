import { resolve } from "node:path";
import { checkPathContainment } from "@ccc/domain";

/**
 * A rejection response must not confirm what exists on disk, so the
 * message names neither the candidate's resolved path nor the registered
 * roots — those live only on `candidate` (for local logging) and never
 * reach the response body (`routes.ts`'s `sendPathNotAllowed`).
 */
export class PathNotAllowedError extends Error {
  readonly candidate: string;

  constructor(candidate: string) {
    super("path not permitted");
    this.name = "PathNotAllowedError";
    this.candidate = candidate;
  }
}

/**
 * The approved-root registry: the managed vault root and registered
 * project directories. Empty in this phase — its populating consumers are
 * the managed vault root (Phase 2) and registered project directories
 * (Phase 4) — but the mechanism, its tests, and its deny-by-default
 * behaviour land now so no handler added later is written without it.
 */
let approvedRoots: string[] = [];

/**
 * REPLACES the registry with exactly `roots`.
 *
 * Replacement, not accumulation, is what makes "the approved roots are what
 * the owner set up" a structural property rather than a convention. An
 * append-only registry meant two `POST /api/v1/vault/setup` calls against
 * different directories in one process left BOTH approved for the rest of
 * the process lifetime — precisely the "something a request can widen on
 * the way back in" that `vault-root.ts`'s own docblock says cannot happen
 * (threat T-02-18), and latent only for as long as `assertPathAllowed` has
 * no production caller.
 *
 * Each root is `resolve`d before it is stored, so `/v` and `/v/` are one
 * entry rather than two.
 */
export function setApprovedRoots(roots: readonly string[]): void {
  approvedRoots = [...new Set(roots.map((root) => resolve(root)))];
}

/**
 * Adds `root` to the registry, leaving existing entries in place.
 *
 * This is for genuinely ADDITIVE roots — Phase 4's registered project
 * directories, of which there are many at once. The managed vault root is
 * NOT one of those: it goes through {@link setApprovedRoots}, because there
 * is exactly one of it.
 *
 * Idempotent on the resolved path: re-registering the same directory (or a
 * trailing-slash spelling of it) is a no-op rather than a second entry.
 */
export function registerApprovedRoot(root: string): void {
  const resolved = resolve(root);
  if (approvedRoots.includes(resolved)) return;
  approvedRoots.push(resolved);
}

/** Test-only: clears the registry. */
export function clearApprovedRoots(): void {
  approvedRoots = [];
}

/**
 * Throws {@link PathNotAllowedError} unless `candidate` resolves strictly
 * inside at least one registered approved root — including when the
 * registry is empty, which denies rather than silently permitting
 * everything. Returns the resolved path on success so the caller never
 * has to re-resolve it.
 */
export function assertPathAllowed(candidate: string): string {
  for (const root of approvedRoots) {
    const result = checkPathContainment(candidate, root);
    if (result.contained) return result.resolved;
  }
  throw new PathNotAllowedError(candidate);
}
