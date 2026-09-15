import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * The outcome of a containment check, so a caller can log why a candidate
 * was rejected without putting that reason in a response (V4 Access
 * Control — research §Security Domain).
 */
export type PathContainmentResult =
  | { contained: true; resolved: string }
  | { contained: false; reason: "nul-byte" | "root-unresolvable" | "is-root" | "not-descendant" };

/**
 * Resolves `candidate` to its real, symlink-free path. When `candidate`
 * does not exist yet, walks up to the nearest existing ancestor to
 * resolve THAT (through any symlink), then re-appends the non-existent
 * tail segments onto the resolved ancestor — a handler must be able to
 * validate a path it is about to create, and re-appending the tail keeps
 * a not-yet-created direct child of `root` comparing as a descendant of
 * `root`'s real path, not as `root` itself (the ancestor it happened to
 * resolve to).
 */
function resolveRealOrNearestAncestor(candidate: string): string {
  let current = path.resolve(candidate);
  const tail: string[] = [];
  // Bounded: path.dirname(x) === x only at the filesystem root, which
  // always exists, so this loop always terminates.
  for (;;) {
    try {
      const resolvedAncestor = realpathSync.native(current);
      return tail.length > 0 ? path.join(resolvedAncestor, ...tail) : resolvedAncestor;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Could not resolve any existing ancestor of: ${candidate}`);
      }
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Strict-descendant containment check: resolves both `candidate` and
 * `root` to their real paths via `realpathSync.native` before comparing
 * with `path.relative`, so a symbolic link inside `root` pointing outside
 * it, a sibling directory that merely shares `root`'s string prefix, and
 * a `../`-escaping candidate are all correctly rejected. `root` itself is
 * never contained — containment is strict descendancy, so a handler
 * cannot be tricked into operating on the root directory by passing the
 * root as the candidate.
 */
export function checkPathContainment(candidate: string, root: string): PathContainmentResult {
  if (candidate.includes("\0") || root.includes("\0")) {
    return { contained: false, reason: "nul-byte" };
  }

  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync.native(root);
  } catch {
    return { contained: false, reason: "root-unresolvable" };
  }

  const resolvedCandidate = resolveRealOrNearestAncestor(candidate);

  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === "") {
    return { contained: false, reason: "is-root" };
  }
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    return { contained: false, reason: "not-descendant" };
  }

  return { contained: true, resolved: resolvedCandidate };
}

/** Boolean convenience wrapper over {@link checkPathContainment}. */
export function isContained(candidate: string, root: string): boolean {
  return checkPathContainment(candidate, root).contained;
}
