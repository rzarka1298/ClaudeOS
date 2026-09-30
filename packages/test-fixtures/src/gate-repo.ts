// A throwaway git repository for testing the repository's shell gates
// (plan 03-judge-r1). Each gate reads `git ls-files`, so a test that wants to
// measure what the gate does with a given tracked tree has to build that tree
// for real: a copy of the gate script(s) plus the files under test, staged in
// a fresh repository under the OS temp directory. Nothing touches the real
// working tree.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The repository root this package lives in. */
export const REPO_ROOT = resolve(HERE, "..", "..", "..");

export interface GateRun {
  readonly status: number | null;
  /** stdout followed by stderr. */
  readonly out: string;
}

export interface GateRepo {
  readonly root: string;
  /** Runs `git <args>` in the repository and throws on a non-zero exit. */
  git(...args: string[]): string;
  /** Writes `contents` at `path` (creating parent directories) without staging it. */
  write(path: string, contents: string | Uint8Array): void;
  /** Runs `sh <script> <args>` from the repository root. */
  run(script: string, args?: readonly string[], env?: NodeJS.ProcessEnv): GateRun;
  /** Removes the repository. */
  dispose(): void;
}

/**
 * A repository holding copies of `scripts` (repo-relative paths into the real
 * checkout) plus `files` (path to contents), all staged.
 */
export function gateRepo(
  scripts: readonly string[],
  files: Readonly<Record<string, string | Uint8Array>> = {},
): GateRepo {
  const root = mkdtempSync(join(tmpdir(), "ccc-gate-"));

  const git = (...args: string[]): string => {
    const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout;
  };

  const write = (path: string, contents: string | Uint8Array): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };

  git("init", "-q");
  git("config", "user.email", "gate-test@example.com");
  git("config", "user.name", "Gate Test");
  // A throwaway repo must not start a git fsmonitor daemon (a global
  // core.fsmonitor=true would): each daemon outlives the deleted repo, and a
  // pile of them stalled later test processes for minutes.
  git("config", "core.fsmonitor", "false");
  for (const script of scripts) {
    mkdirSync(dirname(join(root, script)), { recursive: true });
    copyFileSync(join(REPO_ROOT, script), join(root, script));
  }
  for (const [path, contents] of Object.entries(files)) write(path, contents);
  const paths = [...scripts, ...Object.keys(files)];
  if (paths.length > 0) git("add", "--", ...paths);

  return {
    root,
    git,
    write,
    run(script, args = [], env = process.env) {
      const run = spawnSync("sh", [script, ...args], { cwd: root, encoding: "utf8", env });
      return { status: run.status, out: `${run.stdout}${run.stderr}` };
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
