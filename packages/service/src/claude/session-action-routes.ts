import type {
  ProposeForceTerminate,
  RunId,
  SessionLaunchGuard,
  SessionProjectLookup,
  SessionTerminalLauncher,
} from "@ccc/domain";
import type Database from "better-sqlite3";
import type { ClaudeHandler } from "./http.js";
import type { WorktreeEntry } from "./launch-guard.js";

// RED scaffold (05-14 Task 1): the routes land in GREEN.

export interface SessionActionDeps {
  readonly db: Database.Database;
  readonly launcher: SessionTerminalLauncher;
  readonly guard: SessionLaunchGuard;
  readonly lookup: SessionProjectLookup;
  readonly listWorktrees: (projectRoot: string) => Promise<readonly WorktreeEntry[]>;
  readonly proposer: ProposeForceTerminate;
  readonly claudeBin: () => string | null;
  readonly claudeProjectsRoot: string;
  readonly openFile: (args: readonly string[]) => Promise<void>;
  readonly now: () => Date;
  readonly mintRunId: () => RunId;
}

export const sessionActionRoutes: Record<string, Record<string, ClaudeHandler>> = {};
