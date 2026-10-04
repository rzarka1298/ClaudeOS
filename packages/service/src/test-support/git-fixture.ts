import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Real-git repository builders for the git-runner tests (plan 04-04 Task 3).
 *
 * Everything lives under one `mkdtemp` directory: the repositories, a fake
 * HOME with no global config, and every marker file a planted command would
 * write. Fixture commands run `/usr/bin/git` through execFileSync with an
 * argv array and an environment built from scratch (no system config, the
 * fake HOME), so the owner's own git configuration never shapes a fixture.
 *
 * The hostile builders plant a repository-local setting whose value is a
 * command that creates a marker file. The tests prove each vector really
 * fires under an unhardened git call, then prove the hardened runner never
 * lets it run.
 */

/** Built at runtime so no tracked line is email-shaped (ci:privacy rule 2). */
const AT = String.fromCharCode(64);
const FIXTURE_EMAIL = `example${AT}example.invalid`;

export const FIXTURE_GIT = "/usr/bin/git";

export interface GitFixture {
  /** The realpath'd temp root everything lives under. */
  readonly base: string;
  /** An empty HOME for fixture commands and for the runner under test. */
  readonly home: string;
  /** The from-scratch environment fixture commands run with. */
  readonly env: Readonly<Record<string, string>>;
  /** Runs git in `cwd` with the fixture identity; returns stdout. */
  git(cwd: string, args: readonly string[], input?: string): string;
  /** Runs git in `cwd` without throwing on a non-zero exit (for the fire-proof controls). */
  gitUnchecked(cwd: string, args: readonly string[]): void;
  /** A fresh repository on `main` with `commits` commits of one tracked file. */
  repo(name: string, commits?: number): string;
  /** A marker path under the fixture root; nothing creates it but a planted command. */
  marker(name: string): string;
  cleanup(): void;
}

export function createGitFixture(): GitFixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-git-fixture-")));
  const home = join(base, "home");
  mkdirSync(home);
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    LC_ALL: "C",
  };
  const identity = [
    "-c",
    "user.name=Example",
    "-c",
    `user.email=${FIXTURE_EMAIL}`,
    "-c",
    "init.defaultBranch=main",
    "-c",
    "commit.gpgsign=false",
  ];

  const git = (cwd: string, args: readonly string[], input?: string): string =>
    execFileSync(FIXTURE_GIT, [...identity, ...args], {
      cwd,
      env,
      encoding: "utf8",
      ...(input === undefined ? {} : { input }),
    });

  const gitUnchecked = (cwd: string, args: readonly string[]): void => {
    try {
      execFileSync(FIXTURE_GIT, [...identity, ...args], { cwd, env, stdio: "ignore" });
    } catch {
      // The control only cares whether the planted command ran.
    }
  };

  const repo = (name: string, commits = 2): string => {
    const root = join(base, name);
    mkdirSync(root, { recursive: true });
    git(root, ["init", "-q"]);
    for (let i = 1; i <= commits; i += 1) {
      writeFileSync(join(root, "a.txt"), `revision ${i}\n`);
      git(root, ["add", "a.txt"]);
      git(root, ["commit", "-q", "-m", `commit ${i}`]);
    }
    return root;
  };

  return {
    base,
    home,
    env,
    git,
    gitUnchecked,
    repo,
    marker: (name) => join(base, `marker-${name}`),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** A repository-local `core.fsmonitor` hook that writes `marker` when git status runs. */
export function plantFsmonitor(fx: GitFixture, root: string, marker: string): void {
  fx.git(root, ["config", "core.fsmonitor", `touch ${marker}`]);
}

/**
 * A repository-local clean filter, bound to the tracked file by
 * `.gitattributes`, whose command writes `marker`. The file's mtime is moved
 * so git status must re-hash it through the filter.
 */
export function plantCleanFilter(fx: GitFixture, root: string, marker: string): void {
  writeFileSync(join(root, ".gitattributes"), "*.txt filter=evil\n");
  fx.git(root, ["add", ".gitattributes"]);
  fx.git(root, ["commit", "-q", "-m", "attributes"]);
  fx.git(root, ["config", "filter.evil.clean", `touch ${marker}; cat`]);
  const future = new Date(Date.now() + 100_000);
  utimesSync(join(root, "a.txt"), future, future);
}

/** A repository-local diff textconv driver whose command writes `marker` (fires under `log -p`). */
export function plantTextconv(fx: GitFixture, root: string, marker: string): void {
  writeFileSync(join(root, ".gitattributes"), "*.txt diff=evil\n");
  fx.git(root, ["add", ".gitattributes"]);
  fx.git(root, ["commit", "-q", "-m", "attributes"]);
  writeFileSync(join(root, "a.txt"), "changed\n");
  fx.git(root, ["commit", "-q", "-a", "-m", "change"]);
  fx.git(root, ["config", "diff.evil.textconv", `touch ${marker}; cat`]);
}

/**
 * `log.showSignature=true` plus a repository-local `gpg.program` script that
 * writes `marker`, and a HEAD commit carrying a (fake) signature so git log
 * has something to verify.
 */
export function plantSignatureProgram(fx: GitFixture, root: string, marker: string): void {
  const tree = fx.git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  const parent = fx.git(root, ["rev-parse", "HEAD"]).trim();
  const body = [
    `tree ${tree}`,
    `parent ${parent}`,
    "author Example <example> 1700000000 +0000",
    "committer Example <example> 1700000000 +0000",
    "gpgsig -----BEGIN PGP SIGNATURE-----",
    " ",
    " c2lnbmF0dXJl",
    " -----END PGP SIGNATURE-----",
    "",
    "signed commit",
    "",
  ].join("\n");
  const oid = fx.git(root, ["hash-object", "-t", "commit", "-w", "--stdin"], body).trim();
  fx.git(root, ["update-ref", "refs/heads/main", oid]);
  const program = join(fx.base, `gpg-${marker.split("/").pop() ?? "x"}.sh`);
  writeFileSync(program, `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 });
  fx.git(root, ["config", "gpg.program", program]);
  fx.git(root, ["config", "log.showSignature", "true"]);
}

/**
 * Points the repository's `core.worktree` at another directory holding an
 * untracked file, so a git call that honoured it would report that other
 * tree (dirty) instead of the project's own (clean).
 */
export function plantForeignWorktree(fx: GitFixture, root: string, name: string): string {
  const other = join(fx.base, name);
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "elsewhere.txt"), "not this project\n");
  fx.git(root, ["config", "core.worktree", other]);
  return other;
}

/**
 * A folder that is itself a bare repository (HEAD, config, objects, refs at
 * its top level, no `.git`) with a planted `core.fsmonitor`. Registered as a
 * project it must read as not-a-repo without git ever being spawned.
 */
export function makeEmbeddedBareRepository(fx: GitFixture, name: string, marker: string): string {
  const root = join(fx.base, name);
  mkdirSync(root, { recursive: true });
  fx.git(root, ["init", "-q", "--bare"]);
  fx.git(root, ["config", "core.fsmonitor", `touch ${marker}`]);
  return root;
}

/** The three values `git lfs install` writes, set in the repository's local config. */
export function plantCanonicalGitLfs(fx: GitFixture, root: string): void {
  fx.git(root, ["config", "filter.lfs.clean", "git-lfs clean -- %f"]);
  fx.git(root, ["config", "filter.lfs.smudge", "git-lfs smudge -- %f"]);
  fx.git(root, ["config", "filter.lfs.process", "git-lfs filter-process"]);
}

export function markerExists(marker: string): boolean {
  return existsSync(marker);
}
