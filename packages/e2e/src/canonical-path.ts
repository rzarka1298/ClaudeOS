import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * Canonical, symlink-free paths for the live-UAT launch guards (Codex finding 2). `resolve`
 * only normalises text; it never follows a link, so a link inside the run root that points at
 * the plugin package, an owner vault or the home directory passed every textual comparison.
 * The only filesystem call is `realpath`, injectable for tests. Every refusal is a fixed
 * message that does not echo the offending path.
 */

export const MSG_UNRESOLVABLE = "Refusing a path that cannot be resolved.";

export interface RealpathOps {
  realpathSync(path: string): string;
}

/** The real filesystem. `.native` reports the on-disk spelling on case-insensitive volumes. */
export const REAL_REALPATH: RealpathOps = { realpathSync: realpathSync.native };

/** True when `inner` equals `outer` or sits below it (boundary-safe, never a prefix match). */
export function isSameOrInside(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}

export function isStrictlyInside(outer: string, inner: string): boolean {
  return inner !== outer && isSameOrInside(outer, inner);
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The absolute path with every existing component resolved through `realpath`. A path that
 * does not exist yet (a socket, a vault about to be generated) is resolved from its nearest
 * existing ancestor, with the missing tail appended unchanged.
 */
export function canonicalPath(path: string, ops: RealpathOps = REAL_REALPATH): string {
  const absolute = resolve(path);
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(ops.realpathSync(current), ...tail.reverse());
    } catch (error) {
      if (!isMissing(error)) throw new Error(MSG_UNRESOLVABLE);
    }
    const parent = dirname(current);
    if (parent === current) return absolute;
    tail.push(basename(current));
    current = parent;
  }
}
