import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

const execFileAsync = promisify(execFile);

/** The default runs git with an argv array and no shell. */
const defaultExec: ExecFile = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, [...args], {
    cwd: options?.cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout };
};

const FULL_HASH = /^[0-9a-f]{40}$/;
const COMMIT_ISH = /^[0-9a-f]{7,40}$/;

async function run(exec: ExecFile, cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await exec("git", args, { cwd });
    return stdout;
  } catch {
    return null;
  }
}

/** HEAD, the clean flag and the files changed since a commit; never throws (D-10, E2E-07). */
export async function readGitFacts(input: GitFactsInput): Promise<GitFacts> {
  const exec = input.exec ?? defaultExec;
  const headOut = await run(exec, input.cwd, ["rev-parse", "HEAD"]);
  const head = headOut !== null && FULL_HASH.test(headOut.trim()) ? headOut.trim() : "unknown";
  if (head === "unknown") return { head, clean: false, changedSince: null };

  const status = await run(exec, input.cwd, ["status", "--porcelain", "--untracked-files=no"]);
  const clean = status !== null && status.trim() === "";

  let changedSince: string[] | null = null;
  if (input.since !== undefined && COMMIT_ISH.test(input.since)) {
    const diff = await run(exec, input.cwd, ["diff", "--name-only", input.since, "HEAD", "--"]);
    if (diff !== null) {
      changedSince = diff
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    }
  }
  return { head, clean, changedSince };
}
