import type { SessionLaunchGuard } from "@ccc/domain";
import type Database from "better-sqlite3";
import type { RunGit } from "./git-readonly.js";

// RED scaffold (05-14 Task 1): the guard and the worktree list land in GREEN.

export interface WorktreeEntry {
  readonly worktreeId: string;
  readonly branch: string;
  readonly folderBasename: string;
  readonly path: string;
}

export interface LaunchGuardDeps {
  readonly db: Database.Database;
  readonly runGit: RunGit;
  readonly realpath: (path: string) => Promise<string>;
}

export function createLaunchGuard(_deps: LaunchGuardDeps): SessionLaunchGuard {
  return {
    async check() {
      return { kind: "clear" };
    },
  };
}

export async function listWorktrees(
  _projectRoot: string,
  _deps: Pick<LaunchGuardDeps, "runGit" | "realpath">,
): Promise<WorktreeEntry[]> {
  return [];
}
