import { realpath, stat } from "node:fs/promises";
import type { ProjectId, ProjectLookup, ProjectLookupFailure, ResolvedProject } from "@ccc/domain";
import { getProject, type OperationalStore } from "@ccc/operational-store";

/**
 * Resolves a ProjectId to the folder a launch acts on (D-06, A-06). The path
 * comes from the store — never from the request — and is re-checked on disk
 * immediately before every launch:
 *
 * - an id the store does not hold, or a folder that no longer exists, is
 *   `project-missing`;
 * - a folder whose realpath no longer equals the stored realpath (a parent
 *   or the folder itself was replaced by a symlink, or renamed in case) is
 *   `project-moved`, and so is a stored path that is now a file;
 * - EPERM/EACCES while resolving (TCC, or permissions) is
 *   `folder-access-denied`.
 *
 * The residual same-user race between this check and the spawn is the one
 * ADR-0001 already accepts (threat T-04-18).
 *
 * Every filesystem call is asynchronous (`fs.promises`): a synchronous
 * `realpath`/`stat` on a stalled network or external volume would block the
 * event loop, so the launch pipeline's 4 s cap could never fire (D-40).
 */

const ACCESS_DENIED_CODES = new Set(["EPERM", "EACCES"]);

function errorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

function classifyFsError(err: unknown): ProjectLookupFailure {
  const code = errorCode(err);
  if (code !== null && ACCESS_DENIED_CODES.has(code)) return { error: "folder-access-denied" };
  return { error: "project-missing" };
}

export function createStoreProjectLookup(store: OperationalStore): ProjectLookup {
  return {
    async resolve(projectId: ProjectId): Promise<ResolvedProject | ProjectLookupFailure> {
      const record = getProject(store.db, projectId);
      if (record === null) return { error: "project-missing" };
      let resolved: string;
      try {
        // `fs.promises.realpath` resolves through the native realpath(3).
        resolved = await realpath(record.path);
      } catch (err: unknown) {
        return classifyFsError(err);
      }
      if (resolved !== record.path) return { error: "project-moved" };
      try {
        if (!(await stat(resolved)).isDirectory()) return { error: "project-moved" };
      } catch (err: unknown) {
        return classifyFsError(err);
      }
      return { projectId: record.projectId, path: record.path, displayName: record.displayName };
    },
  };
}
