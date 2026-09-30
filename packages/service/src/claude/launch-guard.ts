import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import {
  type GuardConflict,
  type LaunchGuardResult,
  type SessionLaunchGuard,
  sessionDisplayName,
  toSessionView,
} from "@ccc/domain";
import { listConflictCandidates } from "@ccc/operational-store";
import type Database from "better-sqlite3";
import type { RunGit } from "./git-readonly.js";

/**
 * The concurrent-write guard (D-27, D-29, SESS-10) and the read-only
 * worktree list its "isolated worktree" choice offers (D-28, PR-25).
 *
 * Every git call goes through the read-only gateway (`runGit`), so the
 * guard can observe a repository and never change one (SESS-11, D-30). A
 * target that is not inside a git working tree, or whose toplevel cannot be
 * read, is clear: the guard exists to stop two writers in one working tree,
 * and without a working tree there is nothing it can compare.
 */

/** One existing worktree. `path` is private and never leaves the service; the plugin sees the rest. */
export interface WorktreeEntry {
  /** sha256 of the worktree's realpath, first 16 hex characters: stable and opaque. */
  readonly worktreeId: string;
  /** The checked-out branch without `refs/heads/`, or `(detached)`. */
  readonly branch: string;
  readonly folderBasename: string;
  readonly path: string;
}

export interface LaunchGuardDeps {
  readonly db: Database.Database;
  readonly runGit: RunGit;
  readonly realpath: (path: string) => Promise<string>;
}

/** The longest session name a conflict carries (the schema's cap). */
const MAX_SESSION_NAME = 256;
const DETACHED_BRANCH = "(detached)";

/** The realpath'd git toplevel containing `cwd`, or null when it has none or cannot be read. */
async function toplevelOf(
  cwd: string,
  deps: Pick<LaunchGuardDeps, "runGit" | "realpath">,
): Promise<string | null> {
  try {
    const top = await deps.runGit(cwd, ["rev-parse", "--show-toplevel"]);
    return top.length > 0 && isAbsolute(top) ? await deps.realpath(top) : null;
  } catch {
    return null;
  }
}

/** A stored worktree root, realpath'd when it still resolves; as stored otherwise. */
async function resolvedRoot(
  root: string,
  deps: Pick<LaunchGuardDeps, "realpath">,
): Promise<string> {
  try {
    return await deps.realpath(root);
  } catch {
    return root;
  }
}

/**
 * `createLaunchGuard` implements the domain `SessionLaunchGuard` (D-29). A
 * conflict is any `queued`, `starting`, `running`, `waiting-for-approval` or `stale`
 * Run whose permission mode is not `plan` (a null mode counts as
 * write-capable) and whose realpath'd working tree equals the target's
 * (D-27). `listConflictCandidates` applies the state and mode rules in SQL;
 * this compares the working trees.
 */
/**
 * The service's guard: the domain port plus the realpath'd working tree a
 * launch directory belongs to, which a pre-registered Run records so it is
 * a conflict candidate before its first hook arrives (wave 5 review).
 */
export interface ServiceLaunchGuard extends SessionLaunchGuard {
  /** The realpath'd git toplevel containing `cwd`, or null outside a working tree. */
  worktreeRootOf(cwd: string): Promise<string | null>;
}

export function createLaunchGuard(deps: LaunchGuardDeps): ServiceLaunchGuard {
  return {
    worktreeRootOf: (cwd) => toplevelOf(cwd, deps),
    async check(target): Promise<LaunchGuardResult> {
      const top = await toplevelOf(target.cwd, deps);
      if (top === null) return { kind: "clear" };
      const conflicts: GuardConflict[] = [];
      for (const run of listConflictCandidates(deps.db)) {
        if (run.worktreeRoot === null) continue;
        if ((await resolvedRoot(run.worktreeRoot, deps)) !== top) continue;
        conflicts.push({
          runId: run.runId,
          sessionName: sessionDisplayName(toSessionView(run, null)).slice(0, MAX_SESSION_NAME),
          state: run.state,
          lastActivityAt: run.lastActivityAt,
        });
      }
      return conflicts.length > 0 ? { kind: "conflict", conflicts } : { kind: "clear" };
    },
  };
}

/** The opaque id of a worktree realpath (PR-25). */
export function worktreeIdOf(realPath: string): string {
  return createHash("sha256").update(realPath).digest("hex").slice(0, 16);
}

interface PorcelainStanza {
  path: string | null;
  branch: string | null;
  bare: boolean;
}

/**
 * Parses `git worktree list --porcelain`: one blank-line-separated stanza
 * per worktree, `worktree <path>` first, then `HEAD`, `branch <ref>` or
 * `detached`, and optional `bare`, `locked` and `prunable` lines.
 */
function parsePorcelain(stdout: string): PorcelainStanza[] {
  const stanzas: PorcelainStanza[] = [];
  let current: PorcelainStanza | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null, bare: false };
      stanzas.push(current);
    } else if (current !== null && line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (current !== null && line === "bare") {
      current.bare = true;
    }
  }
  return stanzas;
}

/**
 * The project's existing worktrees, through the read-only gateway (D-28).
 * A bare entry, and an entry whose folder no longer resolves (a prunable
 * worktree), is skipped; outside a repository the list is empty. The main
 * worktree is listed first, as git lists it.
 */
export async function listWorktrees(
  projectRoot: string,
  deps: Pick<LaunchGuardDeps, "runGit" | "realpath">,
): Promise<WorktreeEntry[]> {
  let stdout: string;
  try {
    stdout = await deps.runGit(projectRoot, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  const entries: WorktreeEntry[] = [];
  const seen = new Set<string>();
  for (const stanza of parsePorcelain(stdout)) {
    if (stanza.bare || stanza.path === null || !isAbsolute(stanza.path)) continue;
    let path: string;
    try {
      path = await deps.realpath(stanza.path);
    } catch {
      continue;
    }
    const worktreeId = worktreeIdOf(path);
    const folderBasename = basename(path);
    if (seen.has(worktreeId) || folderBasename.length === 0) continue;
    seen.add(worktreeId);
    entries.push({
      worktreeId,
      branch: (stanza.branch ?? DETACHED_BRANCH).slice(0, MAX_SESSION_NAME) || DETACHED_BRANCH,
      folderBasename,
      path,
    });
  }
  return entries;
}
