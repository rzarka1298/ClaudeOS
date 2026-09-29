// RED scaffold (05-11 Task 2): the real gateway replaces this body.

export const READ_ONLY_GIT_ARGV = [
  ["rev-parse", "--show-toplevel"],
  ["rev-parse", "--git-common-dir"],
  ["worktree", "list", "--porcelain"],
] as const;

export class GitArgvRefusedError extends Error {
  constructor() {
    super("git argv refused");
    this.name = "GitArgvRefusedError";
  }
}

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
}

export type RunGit = (
  cwd: string,
  argv: readonly string[],
  options?: RunGitOptions,
) => Promise<string>;

export const runGit: RunGit = async () => {
  throw new Error("not implemented");
};
