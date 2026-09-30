import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

/**
 * The service's ONE git choke point (SESS-11, D-30, T-05-45, T-05-46). Every
 * git invocation anywhere in `@ccc/service` goes through {@link runGit}, and
 * `runGit` refuses any argv that is not deep-equal to one of the three
 * read-only forms in {@link READ_ONLY_GIT_ARGV} — before anything is
 * spawned. A source-scan test keeps every other file free of git spawns.
 *
 * Hygiene (Phase 4 D-09, PR-05): `/usr/bin/git` by absolute path through
 * `execFile` with a fixed argv, never a shell; `cwd` set to the caller's
 * verified absolute path; a bounded timeout; a minimal env that carries no
 * inherited `GIT_DIR`/`GIT_WORK_TREE`, with `GIT_OPTIONAL_LOCKS=0` (no index
 * refresh writes) and `GIT_TERMINAL_PROMPT=0`; and `-c core.fsmonitor=false`,
 * so a repository's own config cannot make a read run a helper command.
 * `rev-parse` runs no filters and no hooks.
 *
 * Least privilege (wave 4 review): only argv forms with a caller are listed.
 * 05-11's linked-worktree attribution asks `--git-common-dir`; 05-14's
 * `listWorktrees` (launch-guard.ts) is the one caller of
 * `worktree list --porcelain`, which only reads `.git/worktrees`. Worktree
 * creation is never a service git command: it is Claude Code's own
 * `--worktree <name>` flag, chosen by the owner (D-28, D-30).
 */

/** The only argv forms the service may run. Anything else is refused. */
export const READ_ONLY_GIT_ARGV = [
  ["rev-parse", "--show-toplevel"],
  ["rev-parse", "--git-common-dir"],
  ["worktree", "list", "--porcelain"],
] as const;

export type ReadOnlyGitArgv = (typeof READ_ONLY_GIT_ARGV)[number];

/** Thrown before any spawn for an argv outside the allowlist, or an unsafe cwd. The argv is never echoed. */
export class GitArgvRefusedError extends Error {
  constructor(reason: "argv-not-allowed" | "cwd-not-absolute") {
    super(`git invocation refused: ${reason}`);
    this.name = "GitArgvRefusedError";
  }
}

/** The `execFile` surface the gateway needs; tests pass a spy. */
export type GitExecFile = (
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeout: number;
  },
) => Promise<{ readonly stdout: string }>;

export interface RunGitOptions {
  readonly execFile?: GitExecFile;
  readonly timeoutMs?: number;
}

/** Runs one allow-listed read-only git command in `cwd`; resolves its trimmed stdout. */
export type RunGit = (
  cwd: string,
  argv: readonly string[],
  options?: RunGitOptions,
) => Promise<string>;

const GIT = "/usr/bin/git";
const GIT_TIMEOUT_MS = 2000;
/** Read-only answers are one path, or one short stanza per worktree. */
const GIT_MAX_BUFFER = 256 * 1024;

const execFileAsync = promisify(execFile);

const nodeGitExecFile: GitExecFile = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    timeout: options.timeout,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
  });
  return { stdout };
};

function isAllowed(argv: readonly string[]): boolean {
  return READ_ONLY_GIT_ARGV.some(
    (allowed) => allowed.length === argv.length && allowed.every((part, i) => part === argv[i]),
  );
}

function gitEnv(): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/",
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export const runGit: RunGit = async (cwd, argv, options = {}) => {
  if (!isAllowed(argv)) throw new GitArgvRefusedError("argv-not-allowed");
  if (!isAbsolute(cwd) || cwd.includes("\0")) throw new GitArgvRefusedError("cwd-not-absolute");
  const exec = options.execFile ?? nodeGitExecFile;
  const { stdout } = await exec(GIT, ["-c", "core.fsmonitor=false", ...argv], {
    cwd,
    env: gitEnv(),
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
  });
  return stdout.trim();
};
