import { accessSync, constants } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProjectGitState } from "@ccc/domain";
import {
  hasLocalExecutableConfig,
  LOCAL_EXEC_PREFLIGHT_ARGS,
  NEUTRALISING_OVERRIDES,
  parseLogRecords,
  parseRemoteLines,
  parseStatusPorcelainV2,
  remoteDisplay,
  selectRemote,
} from "@ccc/launchers";
import type { CommandOutcome, CommandRunner } from "./command-runner.js";

/**
 * The only git spawner in the service (D-09, D-10, PR-05, threats T-04-06
 * and T-04-19). It reads a project's branch, dirty flag, five most recent
 * commits and display remote, and it must never modify the repository or
 * run a command the repository supplies.
 *
 * A repository's own `.git/config` and `.gitattributes` are attacker-
 * controllable (E-2): filter and diff drivers can have any name, so no list
 * of `-c` overrides can neutralise them all. The defence is layered:
 * 1. `-c` overrides in the command scope, which outranks the repository's
 *    local scope: no fsmonitor, no hooks, no implicitly discovered bare
 *    repository, no signature verification, no pager, no colour, and a
 *    fixed seven-character minimum commit abbreviation.
 * 2. An environment built from scratch — never a copy of the service's own
 *    environment — so no inherited GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE or
 *    GIT_CONFIG_* can redirect git; GIT_OPTIONAL_LOCKS=0 so status never
 *    writes the index under a live session; GIT_TERMINAL_PROMPT=0;
 *    GIT_CEILING_DIRECTORIES so discovery never climbs above the project.
 * 3. `--work-tree=<root>`, overriding a local `core.worktree` that points
 *    somewhere else.
 * 4. A preflight (`LOCAL_EXEC_PREFLIGHT_ARGS`, `-z` output only) that SKIPS
 *    any repository whose repository-supplied config names a command git
 *    could run on read — except the three canonical git-lfs values and the
 *    keys layer 1 already overrides (`NEUTRALISING_OVERRIDES`).
 * 5. `lstat(<root>/.git)` before any spawn: a folder without `.git` is
 *    not-a-repo and git never runs in it, so an embedded bare repository or
 *    a subfolder of another repository is never discovered.
 * 6. The D-06 re-check before anything else: the stored root must still
 *    realpath to itself and be a directory. A root replaced by a symlink
 *    (to another repository, or to where the folder moved) or by a file
 *    reads `folder-missing` and git never runs.
 *
 * Only `config`, `status`, `log` and `remote` run. No `fetch`, no network,
 * and no `worktree` subcommand — worktrees belong to Phase 5 (D-16). Output
 * is parsed by the `@ccc/launchers` parsers; remote userinfo is stripped by
 * `normaliseRemote` inside them. Nothing here logs, and no git stderr ever
 * leaves this module (D-46).
 *
 * Rejected alternative: a git library (isomorphic-git, nodegit). D-09
 * forbids them — the system git is what the owner's own tools use, and a
 * library would be a new dependency with its own config semantics.
 */

/** Command-scope overrides; they outrank anything in the repository's local config. */
export const GIT_OVERRIDES: readonly string[] = Object.freeze([
  // core.fsmonitor=false and core.pager=cat: the preflight exempts exactly
  // these keys BECAUSE they are overridden here, so they come from the one
  // shared list rather than being restated.
  ...Object.entries(NEUTRALISING_OVERRIDES).map(([key, value]) => `${key}=${value}`),
  "core.hooksPath=/dev/null",
  "safe.bareRepository=explicit",
  "log.showSignature=false",
  "color.ui=false",
  // `%h` honours core.abbrev, which a repository (or the owner's global
  // config) may set as low as 4; parseLogRecords accepts 7..40 hex, so a
  // shorter abbreviation would silently drop every commit. Pinned here, in
  // command scope, so no config can shorten it. Not an executable key, so
  // it never needed a preflight exemption.
  "core.abbrev=7",
]);

/** The full argv (after the git executable) for `sub` run against `root`. */
export function gitArgs(root: string, sub: readonly string[]): string[] {
  return [
    "--no-pager",
    ...GIT_OVERRIDES.flatMap((override) => ["-c", override]),
    "-C",
    root,
    `--work-tree=${root}`,
    ...sub,
  ];
}

/**
 * The child environment, built from scratch. HOME is kept so the owner's
 * own global config (a protected scope git itself trusts) still applies;
 * PATH is the same fixed list the LaunchAgent plist uses (ADR-0015).
 */
export function gitEnv(root: string, homeDir: string = homedir()): Record<string, string> {
  return {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    HOME: homeDir,
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CEILING_DIRECTORIES: dirname(root),
    GIT_PAGER: "cat",
  };
}

/** Whether git can run on this Mac, and which binary. */
export type GitResolution = { kind: "available"; path: string } | { kind: "unavailable" };

const XCODE_SELECT = "/usr/bin/xcode-select";
const SYSTEM_GIT = "/usr/bin/git";
const FALLBACK_GITS = ["/opt/homebrew/bin/git", "/usr/local/bin/git"] as const;

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds git once at startup (D-10). `/usr/bin/git` is a shim that opens the
 * Command Line Tools installer when no developer directory is selected, so
 * it is used only when `xcode-select -p` succeeds; otherwise the first
 * executable Homebrew git; otherwise git is unavailable and every project
 * reads `git-unavailable`.
 */
export async function resolveGit(
  runner: CommandRunner,
  isExecutable: (path: string) => boolean = isExecutableFile,
): Promise<GitResolution> {
  const probe = await runner.run(XCODE_SELECT, ["-p"], {
    timeoutMs: 3000,
    env: { PATH: "/usr/bin:/bin" },
  });
  if (probe.exitCode === 0) return { kind: "available", path: SYSTEM_GIT };
  const fallback = FALLBACK_GITS.find((candidate) => isExecutable(candidate));
  return fallback === undefined ? { kind: "unavailable" } : { kind: "available", path: fallback };
}

export interface GitRunner {
  /**
   * The project's git state. Resolves for every classified outcome
   * (not-a-repo, skipped, folder-missing, ...); REJECTS when a git call
   * timed out or failed unexpectedly, so the collector keeps the last good
   * state and marks it `gitReadFailed`.
   */
  readProject(root: string): Promise<ProjectGitState>;
}

export interface GitRunnerOptions {
  readonly runner: CommandRunner;
  readonly git: GitResolution;
  /** Per git call; three calls run per read. */
  readonly callTimeoutMs?: number;
  /** HOME for the child; defaults to the service's home directory. */
  readonly homeDir?: string;
}

/** Thrown when a git call failed in a way no state describes. Carries no git output. */
export class GitReadError extends Error {
  readonly step: string;
  constructor(step: string) {
    super("git read failed");
    this.name = "GitReadError";
    this.step = step;
  }
}

type FsProbe = "present" | "missing" | "denied";

function isAccessError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "EPERM" || code === "EACCES";
}

/**
 * Both probes are asynchronous: readProject runs on every refresh and
 * polling tick, and a synchronous stat against a stalled network or
 * external volume would block the whole event loop — no git timeout, no
 * launch cap, no API request and no heartbeat could fire behind it.
 */
async function probe(path: string): Promise<FsProbe> {
  try {
    await lstat(path);
    return "present";
  } catch (err: unknown) {
    return isAccessError(err) ? "denied" : "missing";
  }
}

/**
 * The stored root is present only when it is STILL the folder that was
 * registered (D-06): its native realpath equals the stored realpath and it
 * is a directory. A root that now resolves elsewhere (replaced by a symlink,
 * moved and linked back) or is no longer a directory is `missing` — the
 * project moved, and git must not run in whatever sits there now.
 */
async function probeRoot(root: string): Promise<FsProbe> {
  try {
    // fs/promises realpath has the same semantics as realpathSync.native,
    // which registration used to store the root (D-06).
    if ((await realpath(root)) !== root) return "missing";
    return (await stat(root)).isDirectory() ? "present" : "missing";
  } catch (err: unknown) {
    return isAccessError(err) ? "denied" : "missing";
  }
}

export function createGitRunner(options: GitRunnerOptions): GitRunner {
  const callTimeoutMs = options.callTimeoutMs ?? 3000;
  const homeDir = options.homeDir ?? homedir();

  return {
    async readProject(root) {
      const folder = await probeRoot(root);
      if (folder === "missing") return { kind: "folder-missing" };
      if (folder === "denied") return { kind: "folder-access-denied" };
      if (options.git.kind === "unavailable") return { kind: "git-unavailable" };

      const dotGit = await probe(join(root, ".git"));
      if (dotGit === "missing") return { kind: "not-a-repo" };
      if (dotGit === "denied") return { kind: "folder-access-denied" };

      const gitPath = options.git.path;
      const env = gitEnv(root, homeDir);
      const run = (sub: readonly string[]): Promise<CommandOutcome> =>
        options.runner.run(gitPath, gitArgs(root, sub), { timeoutMs: callTimeoutMs, env });

      // Preflight: exit 1 with no output means nothing matched. Anything
      // unreadable (truncated, line format, a line break in a value) is
      // treated as unsafe by hasLocalExecutableConfig.
      const preflight = await run(LOCAL_EXEC_PREFLIGHT_ARGS);
      if (preflight.timedOut) throw new GitReadError("preflight");
      if (preflight.truncated) return { kind: "skipped", reason: "local-config-commands" };
      if (preflight.exitCode === 0) {
        if (hasLocalExecutableConfig(preflight.stdout)) {
          return { kind: "skipped", reason: "local-config-commands" };
        }
      } else if (!(preflight.exitCode === 1 && preflight.stdout === "")) {
        throw new GitReadError("preflight");
      }

      const statusOut = await run([
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--ignore-submodules=all",
        "--no-renames",
      ]);
      if (statusOut.timedOut || (statusOut.exitCode !== 0 && !statusOut.truncated)) {
        throw new GitReadError("status");
      }
      const status = parseStatusPorcelainV2(statusOut.stdout);
      // Output past the cap means entries kept coming: the tree is dirty.
      const dirty = status.dirty || statusOut.truncated;

      let commits: ReturnType<typeof parseLogRecords> = [];
      if (!status.unborn) {
        const logOut = await run([
          "log",
          "-n",
          "5",
          "-z",
          "--no-show-signature",
          "--no-decorate",
          "--no-color",
          "--format=%h%x1f%ct%x1f%s",
        ]);
        if (logOut.timedOut || logOut.exitCode !== 0) throw new GitReadError("log");
        commits = parseLogRecords(logOut.stdout);
      }

      const remoteOut = await run(["remote", "-v"]);
      if (remoteOut.timedOut || remoteOut.exitCode !== 0) throw new GitReadError("remote");
      const selected = selectRemote(parseRemoteLines(remoteOut.stdout));

      return {
        kind: "repo",
        branch: status.detached ? null : status.branch,
        detached: status.detached,
        dirty,
        commits: commits.map((commit) => ({
          hash: commit.hash,
          subject: commit.subject,
          committedAt: commit.committedAt,
        })),
        remote: selected === null ? null : remoteDisplay(selected.remote),
      };
    },
  };
}
