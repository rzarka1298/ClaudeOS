import type { NoteScope } from "@ccc/domain";

/**
 * Thrown when a write's target path does not lie inside the tree its
 * declared scope owns (VAULT-10) — a workspace processor reaching into
 * another workspace, or a global-scoped write reaching into any workspace
 * at all.
 *
 * The message is a constant that names no path, mirroring
 * `PathNotAllowedError`'s discipline: a rejection must not confirm what
 * exists on disk. The offending candidate is kept on the error for local
 * logging only and must never be echoed into a response body.
 */
export class WorkspaceScopeViolationError extends Error {
  readonly candidate: string;

  constructor(candidate: string) {
    super("write target is outside the declared scope");
    this.name = "WorkspaceScopeViolationError";
    this.candidate = candidate;
  }
}

/**
 * Returns the resolved, real path of `candidatePath` if — and only if —
 * it is a strict descendant of the tree `scope` owns:
 *
 * - `workspace:<id>` → inside `<vaultRoot>/workspaces/<id>/` and nowhere
 *   else. A workspace that does not exist on disk owns no tree, so such a
 *   write is a violation rather than an implicit workspace creation.
 * - `global` → inside `<vaultRoot>` but NOT inside
 *   `<vaultRoot>/workspaces/` at all, so the global scope can never be
 *   used as a back door into some workspace's knowledge.
 *
 * Containment itself is delegated to `checkPathContainment` — the one
 * symlink-safe, NUL-safe, strict-descendant implementation this repository
 * has. This function adds scope semantics on top of it; it never
 * re-derives containment.
 *
 * NOT YET IMPLEMENTED — RED phase (plan 02-01).
 */
export function assertScopedWrite(
  candidatePath: string,
  scope: NoteScope,
  vaultRoot: string,
): string {
  void candidatePath;
  void scope;
  void vaultRoot;
  throw new Error("assertScopedWrite is not implemented yet");
}
