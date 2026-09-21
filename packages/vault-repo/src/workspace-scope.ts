import { join } from "node:path";
import {
  checkPathContainment,
  NOTE_SCOPE_PATTERN,
  type NoteScope,
  workspaceIdFromScope,
} from "@ccc/domain";

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
 *   write is refused rather than implicitly creating the workspace.
 * - `global` → inside `<vaultRoot>` but NOT inside
 *   `<vaultRoot>/workspaces/` at all, so the global scope can never be
 *   used as a back door into some workspace's knowledge.
 *
 * Containment itself is delegated to `checkPathContainment` — the one
 * symlink-safe, NUL-safe, strict-descendant implementation this repository
 * has. This function adds scope semantics on top of it; it never
 * re-derives containment.
 *
 * Note the ordering: vault containment is checked FIRST, and the scope
 * check then runs against the already-resolved real path. A candidate that
 * escapes the vault entirely is therefore rejected before its scope is
 * even considered, and the symlink resolution that the escape check
 * performed is what the scope check re-uses — so there is no second,
 * differently-resolved view of the same path for the two checks to
 * disagree about.
 */
export function assertScopedWrite(
  candidatePath: string,
  scope: NoteScope,
  vaultRoot: string,
): string {
  if (!NOTE_SCOPE_PATTERN.test(scope)) {
    throw new WorkspaceScopeViolationError(candidatePath);
  }

  const insideVault = checkPathContainment(candidatePath, vaultRoot);
  if (!insideVault.contained) {
    throw new WorkspaceScopeViolationError(candidatePath);
  }

  const workspacesRoot = join(vaultRoot, "workspaces");
  const workspaceId = workspaceIdFromScope(scope);

  if (workspaceId === null) {
    if (checkPathContainment(insideVault.resolved, workspacesRoot).contained) {
      throw new WorkspaceScopeViolationError(candidatePath);
    }
    return insideVault.resolved;
  }

  const insideWorkspace = checkPathContainment(
    insideVault.resolved,
    join(workspacesRoot, workspaceId),
  );
  if (!insideWorkspace.contained) {
    throw new WorkspaceScopeViolationError(candidatePath);
  }
  return insideWorkspace.resolved;
}
