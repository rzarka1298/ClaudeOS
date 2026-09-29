import { basename, dirname, resolve } from "node:path";
import type { SessionProjectLookup } from "@ccc/domain";
import type { Logger } from "pino";
import type { RunGit } from "./git-readonly.js";

/**
 * Session attribution (SESS-07, D-23, D-24): which registered project a
 * Claude session's working directory belongs to. Checked in this order:
 *
 * 1. The owner's manual override for the Claude session id (D-24) — a
 *    choice made in the UI outranks anything computed, for later Runs of
 *    that session too (SESS-17).
 * 2. The longest registered project root containing `realpath(cwd)`,
 *    the root itself included.
 * 3. A linked worktree: `git rev-parse --git-common-dir` in the cwd names
 *    the main repository's `.git`; its parent directory lying under a
 *    registered root maps the worktree to that project.
 * 4. Otherwise unclassified.
 *
 * `worktreeRoot` is `git rev-parse --show-toplevel` whenever the cwd is in
 * a git tree. Attribution only reads: it never writes `projects`, the
 * overrides, or the vault (D-57, a source-scan test). Every failure — a
 * TCC EPERM on a protected folder, a missing folder, a failing git — leaves
 * the session unclassified with a reason code, never a throw (Pitfall 16).
 * Log lines carry reason codes only, never a path (D-26, D-49, T-05-48).
 */

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

export interface AttributionInput {
  readonly cwd: string | null;
  readonly claudeSessionId: string | null;
}

export interface AttributionDeps {
  readonly lookup: SessionProjectLookup;
  readonly getOverride: (claudeSessionId: string) => string | null;
  readonly realpath: (path: string) => Promise<string>;
  readonly runGit: RunGit;
  readonly logger: Logger;
}

/** The attribution function bound to its dependencies, as the pipeline and sweeper take it. */
export type AttributeFn = (input: AttributionInput) => Promise<Attribution>;

const ACCESS_DENIED_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES"]);

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** A git answer, or null when git is absent, the cwd is not a repository, or it failed. */
async function gitAnswer(
  deps: AttributionDeps,
  cwd: string,
  argv: readonly string[],
): Promise<string | null> {
  try {
    const out = await deps.runGit(cwd, argv);
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

async function realOrNull(deps: AttributionDeps, path: string): Promise<string | null> {
  try {
    return await deps.realpath(path);
  } catch {
    return null;
  }
}

/** The working tree's real toplevel, or null outside a git tree. */
async function worktreeRootOf(deps: AttributionDeps, real: string): Promise<string | null> {
  const top = await gitAnswer(deps, real, ["rev-parse", "--show-toplevel"]);
  return top === null ? null : realOrNull(deps, top);
}

/** The project a linked worktree's main repository belongs to, via its common git dir. */
async function mainRepositoryProject(deps: AttributionDeps, real: string): Promise<string | null> {
  const commonDir = await gitAnswer(deps, real, ["rev-parse", "--git-common-dir"]);
  if (commonDir === null) return null;
  // Relative answers (inside the main tree) are relative to the cwd.
  const common = await realOrNull(deps, resolve(real, commonDir));
  if (common === null || basename(common) !== ".git") return null;
  return deps.lookup.resolveByPath(dirname(common))?.projectId ?? null;
}

function unclassified(reason: AttributionReason): Attribution {
  return { projectId: null, worktreeRoot: null, reason };
}

export async function attributeCwd(
  input: AttributionInput,
  deps: AttributionDeps,
): Promise<Attribution> {
  const override = input.claudeSessionId === null ? null : deps.getOverride(input.claudeSessionId);
  const overridden =
    override !== null && deps.lookup.list().some((project) => project.projectId === override)
      ? override
      : null;

  if (input.cwd === null) {
    return overridden === null
      ? unclassified("no-cwd")
      : { projectId: overridden, worktreeRoot: null, reason: "override" };
  }

  let real: string;
  try {
    real = await deps.realpath(input.cwd);
  } catch (err: unknown) {
    const code = errorCode(err);
    const reason: AttributionReason =
      code !== undefined && ACCESS_DENIED_CODES.has(code)
        ? "folder-access-denied"
        : "folder-missing";
    if (overridden !== null)
      return { projectId: overridden, worktreeRoot: null, reason: "override" };
    // The reason and errno code only: the path never reaches a log line.
    deps.logger.info({ reason, code }, "session attribution unavailable");
    return unclassified(reason);
  }

  const worktreeRoot = await worktreeRootOf(deps, real);
  if (overridden !== null) return { projectId: overridden, worktreeRoot, reason: "override" };

  const direct = deps.lookup.resolveByPath(real);
  if (direct !== null) return { projectId: direct.projectId, worktreeRoot, reason: "project-root" };

  if (worktreeRoot !== null) {
    const viaMain = await mainRepositoryProject(deps, real);
    if (viaMain !== null) return { projectId: viaMain, worktreeRoot, reason: "linked-worktree" };
  }
  // Unclassified, but a known working tree still feeds conflict checks (D-27).
  return { projectId: null, worktreeRoot, reason: "no-match" };
}

/** Binds {@link attributeCwd} to its dependencies. */
export function createAttribution(deps: AttributionDeps): AttributeFn {
  return (input) => attributeCwd(input, deps);
}
