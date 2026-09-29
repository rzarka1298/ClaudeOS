import type { SessionProjectLookup } from "@ccc/domain";
import type { Logger } from "pino";
import type { RunGit } from "./git-readonly.js";

// RED scaffold (05-11 Task 2): the real attribution replaces this body.

export type AttributionReason =
  | "override"
  | "project-root"
  | "linked-worktree"
  | "no-match"
  | "no-cwd"
  | "folder-access-denied"
  | "folder-missing";

export interface Attribution {
  readonly projectId: string | null;
  readonly worktreeRoot: string | null;
  readonly reason: AttributionReason;
}

export interface AttributionDeps {
  readonly lookup: SessionProjectLookup;
  readonly getOverride: (claudeSessionId: string) => string | null;
  readonly realpath: (path: string) => Promise<string>;
  readonly runGit: RunGit;
  readonly logger: Logger;
}

export async function attributeCwd(
  _input: { readonly cwd: string | null; readonly claudeSessionId: string | null },
  _deps: AttributionDeps,
): Promise<Attribution> {
  return { projectId: null, worktreeRoot: null, reason: "no-match" };
}
