export type ExecFile = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string | undefined },
) => Promise<{ stdout: string }>;

export interface GitFacts {
  /** The 40-hex HEAD, or "unknown" when git could not answer. */
  readonly head: string;
  /** False when tracked files differ from HEAD, or when git could not answer. */
  readonly clean: boolean;
  /** Files changed between `since` and HEAD, or null when unknown. */
  readonly changedSince: string[] | null;
}

export interface GitFactsInput {
  readonly exec?: ExecFile;
  readonly cwd: string;
  readonly since?: string | undefined;
}

export async function readGitFacts(_input: GitFactsInput): Promise<GitFacts> {
  throw new Error("readGitFacts is not implemented yet (typed skeleton)");
}
