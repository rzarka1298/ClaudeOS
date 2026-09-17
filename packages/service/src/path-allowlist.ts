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

/** Registers `root` as an approved directory candidates may resolve inside. */
export function registerApprovedRoot(root: string): void {
  approvedRoots.push(root);
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
