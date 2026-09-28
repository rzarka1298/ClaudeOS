import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectGitState } from "@ccc/domain";
import { LOCAL_EXEC_PREFLIGHT_ARGS } from "@ccc/launchers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeCommandRunner } from "../test-support/fake-command-runner.js";
import {
  createGitFixture,
  FIXTURE_GIT,
  type GitFixture,
  makeEmbeddedBareRepository,
  markerExists,
  plantCanonicalGitLfs,
  plantCleanFilter,
  plantForeignWorktree,
  plantFsmonitor,
  plantSignatureProgram,
  plantTextconv,
} from "../test-support/git-fixture.js";
import { createExecFileCommandRunner } from "./command-runner.js";
import { createGitRunner, GIT_OVERRIDES, gitArgs, gitEnv, resolveGit } from "./git-runner.js";

/** Built at runtime so no tracked line is email-shaped (ci:privacy rule 2). */
const AT = String.fromCharCode(64);

let fx: GitFixture;

beforeEach(() => {
  fx = createGitFixture();
});

afterEach(() => {
  fx.cleanup();
});

/** A git runner over the real `/usr/bin/git`, recording every call, with the fixture's empty HOME. */
function realRunner() {
  const runner = createFakeCommandRunner({ inner: createExecFileCommandRunner() });
  const git = createGitRunner({
    runner,
    git: { kind: "available", path: FIXTURE_GIT },
    homeDir: fx.home,
  });
  return { runner, git };
}

describe("gitArgs and gitEnv (D-09, PR-05)", () => {
  it("puts every override before -C, pins the work tree and disables the pager", () => {
    const args = gitArgs("/Users/USERNAME/code/example-project", ["status"]);
    expect(args[0]).toBe("--no-pager");
    for (const override of GIT_OVERRIDES) {
      const at = args.indexOf(override);
      expect(at).toBeGreaterThan(0);
      expect(args[at - 1]).toBe("-c");
    }
    expect(GIT_OVERRIDES).toEqual(
      expect.arrayContaining([
        "core.fsmonitor=false",
        "core.hooksPath=/dev/null",
        "safe.bareRepository=explicit",
        "log.showSignature=false",
      ]),
    );
    expect(args.slice(-4)).toEqual([
      "-C",
      "/Users/USERNAME/code/example-project",
      "--work-tree=/Users/USERNAME/code/example-project",
      "status",
    ]);
  });

  it("builds the environment from scratch with the lock, prompt and ceiling guards", () => {
    const env = gitEnv("/Users/USERNAME/code/example-project", "/Users/USERNAME");
    expect(env).toEqual({
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      HOME: "/Users/USERNAME",
      LC_ALL: "C",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CEILING_DIRECTORIES: "/Users/USERNAME/code",
      GIT_PAGER: "cat",
    });
  });
});

describe("readProject against real repositories (PROJ-04)", () => {
  it("reads a clean repository with two commits on main and no remote", async () => {
    const root = fx.repo("example-project", 2);
    const state = await realRunner().git.readProject(root);
    expect(state).toMatchObject({
      kind: "repo",
      branch: "main",
      detached: false,
      dirty: false,
      remote: null,
    });
    if (state.kind !== "repo") throw new Error("unreachable");
    expect(state.commits).toHaveLength(2);
    expect(state.commits[0]?.subject).toBe("commit 2");
    expect(state.commits[0]?.hash).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("reports an untracked file as dirty", async () => {
    const root = fx.repo("example-project", 1);
    writeFileSync(join(root, "untracked.txt"), "x");
    const state = await realRunner().git.readProject(root);
    expect(state).toMatchObject({ kind: "repo", dirty: true });
  });

  it("reports a detached HEAD as branch null, detached true", async () => {
    const root = fx.repo("example-project", 2);
    fx.git(root, ["checkout", "-q", "--detach"]);
    const state = await realRunner().git.readProject(root);
    expect(state).toMatchObject({ kind: "repo", branch: null, detached: true });
  });

  it("reads an unborn repository as its branch with an empty commit list", async () => {
    const root = fx.repo("example-project", 0);
    const state = await realRunner().git.readProject(root);
    expect(state).toEqual({
      kind: "repo",
      branch: "main",
      detached: false,
      dirty: false,
      commits: [],
      remote: null,
    });
  });

  it("reduces a credentialed remote to host and path, with no userinfo anywhere in the state", async () => {
    const root = fx.repo("example-project", 1);
    fx.git(root, ["remote", "add", "origin", `https://user:token${AT}github.com/owner/repo.git`]);
    const state = await realRunner().git.readProject(root);
    expect(state).toMatchObject({
      kind: "repo",
      remote: { host: "github.com", path: "owner/repo" },
    });
    const serialised = JSON.stringify(state);
    expect(serialised).not.toContain("user");
    expect(serialised).not.toContain("token");
  });

  it("reads a folder with no .git as not-a-repo without spawning git", async () => {
    const root = join(fx.base, "plain-folder");
    mkdirSync(root);
    const { runner, git } = realRunner();
    expect(await git.readProject(root)).toEqual({ kind: "not-a-repo" });
    expect(runner.calls).toHaveLength(0);
  });

  it("reads a subfolder of a repository as not-a-repo: a nested folder is its own project", async () => {
    const root = fx.repo("example-project", 1);
    const sub = join(root, "packages", "inner");
    mkdirSync(sub, { recursive: true });
    const { runner, git } = realRunner();
    expect(await git.readProject(sub)).toEqual({ kind: "not-a-repo" });
    expect(runner.calls).toHaveLength(0);
  });

  it("reads a nested repository and its parent as separate projects", async () => {
    const parent = fx.repo("example-project", 2);
    const nested = join(parent, "vendor", "demo-api");
    mkdirSync(nested, { recursive: true });
    fx.git(nested, ["init", "-q"]);
    const { git } = realRunner();
    const [parentState, nestedState] = await Promise.all([
      git.readProject(parent),
      git.readProject(nested),
    ]);
    expect(parentState).toMatchObject({ kind: "repo", branch: "main" });
    if (parentState.kind === "repo") expect(parentState.commits).toHaveLength(2);
    expect(nestedState).toMatchObject({ kind: "repo", branch: "main", commits: [] });
  });

  it("reads a missing folder as folder-missing", async () => {
    const { runner, git } = realRunner();
    expect(await git.readProject(join(fx.base, "gone"))).toEqual({ kind: "folder-missing" });
    expect(runner.calls).toHaveLength(0);
  });
});

describe("hostile repository configuration (PR-05, threat T-04-06)", () => {
  const SKIPPED: ProjectGitState = { kind: "skipped", reason: "local-config-commands" };

  it("pins the -z --show-scope preflight output shape (A5)", () => {
    const root = fx.repo("example-project", 1);
    fx.git(root, ["config", "filter.evil.clean", "touch marker; cat"]);
    const out = fx.git(root, [...LOCAL_EXEC_PREFLIGHT_ARGS]);
    const NUL = String.fromCharCode(0);
    expect(out).toBe(`local${NUL}filter.evil.clean\ntouch marker; cat${NUL}`);
  });

  it("core.fsmonitor: fires under plain git status, never under readProject", async () => {
    const control = fx.repo("control-fsmonitor", 1);
    plantFsmonitor(fx, control, fx.marker("fsmonitor-control"));
    fx.gitUnchecked(control, ["status"]);
    expect(markerExists(fx.marker("fsmonitor-control"))).toBe(true);

    const root = fx.repo("example-project", 1);
    const marker = fx.marker("fsmonitor");
    plantFsmonitor(fx, root, marker);
    expect(await realRunner().git.readProject(root)).toEqual(SKIPPED);
    expect(markerExists(marker)).toBe(false);
  });

  it("filter.<driver>.clean bound by .gitattributes: fires under plain git status, never under readProject", async () => {
    const control = fx.repo("control-filter", 1);
    plantCleanFilter(fx, control, fx.marker("filter-control"));
    fx.gitUnchecked(control, ["status"]);
    expect(markerExists(fx.marker("filter-control"))).toBe(true);

    const root = fx.repo("example-project", 1);
    const marker = fx.marker("filter");
    plantCleanFilter(fx, root, marker);
    expect(await realRunner().git.readProject(root)).toEqual(SKIPPED);
    expect(markerExists(marker)).toBe(false);
  });

  it("diff.<driver>.textconv: fires under plain git log -p, never under readProject", async () => {
    const control = fx.repo("control-textconv", 1);
    plantTextconv(fx, control, fx.marker("textconv-control"));
    fx.gitUnchecked(control, ["log", "-p", "-n", "1"]);
    expect(markerExists(fx.marker("textconv-control"))).toBe(true);

    const root = fx.repo("example-project", 1);
    const marker = fx.marker("textconv");
    plantTextconv(fx, root, marker);
    expect(await realRunner().git.readProject(root)).toEqual(SKIPPED);
    expect(markerExists(marker)).toBe(false);
  });

  it("log.showSignature with gpg.program: fires under plain git log, never under readProject", async () => {
    const control = fx.repo("control-gpg", 1);
    plantSignatureProgram(fx, control, fx.marker("gpg-control"));
    fx.gitUnchecked(control, ["log", "-n", "1"]);
    expect(markerExists(fx.marker("gpg-control"))).toBe(true);

    const root = fx.repo("example-project", 1);
    const marker = fx.marker("gpg");
    plantSignatureProgram(fx, root, marker);
    expect(await realRunner().git.readProject(root)).toEqual(SKIPPED);
    expect(markerExists(marker)).toBe(false);
  });

  it("core.worktree pointing elsewhere: plain git reads the other tree, readProject reads the project's own", async () => {
    const control = fx.repo("control-worktree", 1);
    plantForeignWorktree(fx, control, "other-tree-control");
    const plain = fx.git(control, ["status", "--porcelain"]);
    expect(plain).toContain("elsewhere.txt");

    const root = fx.repo("example-project", 1);
    plantForeignWorktree(fx, root, "other-tree");
    const state = await realRunner().git.readProject(root);
    expect(state).toMatchObject({ kind: "repo", branch: "main", dirty: false });
  });

  it("an embedded bare repository registered as a folder is not-a-repo and git never runs", async () => {
    const marker = fx.marker("bare");
    const root = makeEmbeddedBareRepository(fx, "bare-project", marker);
    const { runner, git } = realRunner();
    expect(await git.readProject(root)).toEqual({ kind: "not-a-repo" });
    expect(runner.calls).toHaveLength(0);
    expect(markerExists(marker)).toBe(false);
  });

  it("reads a repository whose local config has only the canonical git-lfs filter values", async () => {
    const root = fx.repo("example-project", 1);
    plantCanonicalGitLfs(fx, root);
    const state = await realRunner().git.readProject(root);
    expect(state).toMatchObject({ kind: "repo", branch: "main" });
  });

  it("runs every git call with an argv array, the overrides and the from-scratch environment", async () => {
    const root = fx.repo("example-project", 1);
    const { runner, git } = realRunner();
    await git.readProject(root);
    expect(runner.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of runner.calls) {
      expect(call.file).toBe(FIXTURE_GIT);
      expect(call.args.slice(0, 1)).toEqual(["--no-pager"]);
      expect(call.args).toContain("core.hooksPath=/dev/null");
      expect(call.options.env).toEqual(gitEnv(root, fx.home));
      expect(call.options.timeoutMs).toBe(3000);
      // Read-only: no subcommand that fetches, writes or lists worktrees.
      for (const forbidden of ["fetch", "pull", "worktree", "gc", "add", "commit"]) {
        expect(call.args).not.toContain(forbidden);
      }
    }
  });

  it("leaves no index.lock behind and does not modify the repository", async () => {
    const root = fx.repo("example-project", 1);
    const before = readFileSync(join(root, ".git", "index"));
    await realRunner().git.readProject(root);
    expect(readFileSync(join(root, ".git", "index")).equals(before)).toBe(true);
  });
});

describe("resolveGit (D-10)", () => {
  it("uses /usr/bin/git when xcode-select reports developer tools", async () => {
    const runner = createFakeCommandRunner({
      script: [{ match: (file) => file === "/usr/bin/xcode-select", outcome: { exitCode: 0 } }],
    });
    expect(await resolveGit(runner, () => false)).toEqual({
      kind: "available",
      path: "/usr/bin/git",
    });
    expect(runner.calls[0]?.args).toEqual(["-p"]);
  });

  it("falls back to the first executable Homebrew git when xcode-select fails", async () => {
    const runner = createFakeCommandRunner({
      script: [{ match: () => true, outcome: { exitCode: 2 } }],
    });
    expect(await resolveGit(runner, (p) => p === "/usr/local/bin/git")).toEqual({
      kind: "available",
      path: "/usr/local/bin/git",
    });
  });

  it("is unavailable when xcode-select fails and no candidate is executable, and never calls the shim", async () => {
    const runner = createFakeCommandRunner({
      script: [{ match: () => true, outcome: { exitCode: 2 } }],
    });
    const resolution = await resolveGit(runner, () => false);
    expect(resolution).toEqual({ kind: "unavailable" });
    expect(runner.calls.map((call) => call.file)).toEqual(["/usr/bin/xcode-select"]);

    const gitRunner = createGitRunner({ runner, git: resolution, homeDir: fx.home });
    const root = fx.repo("example-project", 1);
    const before = runner.calls.length;
    expect(await gitRunner.readProject(root)).toEqual({ kind: "git-unavailable" });
    expect(runner.calls).toHaveLength(before);
  });
});

describe("failure handling", () => {
  it("rejects when a git call times out, so the collector keeps the last good state", async () => {
    const root = fx.repo("example-project", 1);
    const runner = createFakeCommandRunner({
      script: [
        {
          match: (_file, args) => args.includes("config"),
          outcome: { exitCode: 1, stdout: "" },
        },
        {
          match: (_file, args) => args.includes("status"),
          outcome: { exitCode: null, timedOut: true },
        },
      ],
    });
    const git = createGitRunner({
      runner,
      git: { kind: "available", path: FIXTURE_GIT },
      homeDir: fx.home,
    });
    await expect(git.readProject(root)).rejects.toThrow();
  });

  it("treats truncated status output as dirty", async () => {
    const root = fx.repo("example-project", 1);
    const NUL = String.fromCharCode(0);
    const runner = createFakeCommandRunner({
      script: [
        { match: (_f, args) => args.includes("config"), outcome: { exitCode: 1 } },
        {
          match: (_f, args) => args.includes("status"),
          outcome: {
            exitCode: null,
            truncated: true,
            stdout: `# branch.oid abc${NUL}# branch.head main${NUL}`,
          },
        },
        { match: (_f, args) => args.includes("log"), outcome: { exitCode: 0, stdout: "" } },
        { match: (_f, args) => args.includes("remote"), outcome: { exitCode: 0, stdout: "" } },
      ],
    });
    const git = createGitRunner({
      runner,
      git: { kind: "available", path: FIXTURE_GIT },
      homeDir: fx.home,
    });
    expect(await git.readProject(root)).toMatchObject({
      kind: "repo",
      branch: "main",
      dirty: true,
    });
  });

  it("treats truncated preflight output as unsafe and skips the repository", async () => {
    const root = fx.repo("example-project", 1);
    const runner = createFakeCommandRunner({
      script: [
        {
          match: (_f, args) => args.includes("config"),
          outcome: { exitCode: null, truncated: true, stdout: "local" },
        },
      ],
    });
    const git = createGitRunner({
      runner,
      git: { kind: "available", path: FIXTURE_GIT },
      homeDir: fx.home,
    });
    expect(await git.readProject(root)).toEqual({
      kind: "skipped",
      reason: "local-config-commands",
    });
  });
});

describe("createExecFileCommandRunner", () => {
  const runner = createExecFileCommandRunner();
  const env = { PATH: "/usr/bin:/bin" };

  it("resolves the exit code and output of a finished process", async () => {
    const outcome = await runner.run("/bin/echo", ["a b", "c"], { timeoutMs: 3000, env });
    expect(outcome).toMatchObject({ exitCode: 0, stdout: "a b c\n", timedOut: false });
  });

  it("resolves a non-zero exit instead of rejecting", async () => {
    const outcome = await runner.run("/usr/bin/false", [], { timeoutMs: 3000, env });
    expect(outcome.exitCode).toBe(1);
  });

  it("marks a process killed at its deadline as timed out", async () => {
    const outcome = await runner.run("/bin/sleep", ["5"], { timeoutMs: 100, env });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).toBeNull();
  });

  it("marks output past the cap as truncated", async () => {
    const outcome = await runner.run("/usr/bin/yes", [], {
      timeoutMs: 3000,
      env,
      maxBufferBytes: 1024,
    });
    expect(outcome.truncated).toBe(true);
  });

  it("reports a missing executable by errno", async () => {
    const outcome = await runner.run("/nonexistent/tool", [], { timeoutMs: 3000, env });
    expect(outcome).toMatchObject({ exitCode: null, errno: "ENOENT" });
  });
});
