import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { newRunId, type SessionRun } from "@ccc/domain";
import {
  applyMigrations,
  type OperationalStore,
  openStore,
  upsertSessionRun,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { READ_ONLY_GIT_ARGV, type RunGit, runGit } from "./git-readonly.js";
import { createLaunchGuard, listWorktrees } from "./launch-guard.js";

const TEST_BASE = join(homedir(), ".ccc-test");

let base: string;
let store: OperationalStore;
let gitCalls: string[][];

/** Wraps the real read-only gateway, recording every argv it is asked to run. */
const spyGit: RunGit = (cwd, argv, options) => {
  gitCalls.push([...argv]);
  return runGit(cwd, argv, options);
};

/** The TEST's own git setup (a write, so never through the service gateway). */
function testGit(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: base,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function makeRepo(name: string): string {
  const repo = join(base, name);
  mkdirSync(join(repo, "sub"), { recursive: true });
  testGit(repo, "init", "-q", "-b", "main");
  testGit(repo, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
  return realpathSync(repo);
}

function seedRun(patch: Partial<SessionRun>): SessionRun {
  const now = new Date().toISOString();
  const run: SessionRun = {
    runId: newRunId(),
    revision: 1,
    claudeSessionId: randomUUID(),
    pid: null,
    pidStartedAt: null,
    state: "running",
    activity: null,
    projectId: null,
    name: null,
    model: null,
    effort: null,
    launchSource: null,
    cwd: null,
    worktreeRoot: null,
    permissionMode: null,
    lastError: null,
    claudeVersion: null,
    transcriptPath: null,
    linkKind: null,
    linkedFromRunId: null,
    subagentActiveIds: [],
    subagentLastType: null,
    startedAt: now,
    lastActivityAt: now,
    endedAt: null,
    terminateRequestedAt: null,
    endObservedAt: null,
    ...patch,
  };
  upsertSessionRun(store.db, run);
  return run;
}

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  base = realpathSync(mkdtempSync(join(TEST_BASE, "lg-")));
  store = openStore(join(base, "operational.db"));
  applyMigrations(store.db);
  gitCalls = [];
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("the concurrent-write guard (Task 1 Test 1, D-27, SESS-10)", () => {
  it("returns the three write-capable Runs in the same toplevel, stale included, and not the plan one", async () => {
    const repo = makeRepo("repo");
    const other = makeRepo("other");
    const auto = seedRun({ permissionMode: "auto", worktreeRoot: repo, name: "Auto run" });
    const dflt = seedRun({
      permissionMode: "default",
      worktreeRoot: repo,
      state: "waiting-for-approval",
    });
    const stale = seedRun({ permissionMode: null, worktreeRoot: repo, state: "stale" });
    seedRun({ permissionMode: "plan", worktreeRoot: repo });
    seedRun({ permissionMode: "auto", worktreeRoot: other });
    seedRun({
      permissionMode: "auto",
      worktreeRoot: repo,
      state: "completed",
      endedAt: new Date().toISOString(),
    });

    const guard = createLaunchGuard({ db: store.db, runGit: spyGit, realpath });
    const result = await guard.check({ cwd: join(repo, "sub") });

    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.conflicts.map((c) => c.runId).sort()).toEqual(
      [auto.runId, dflt.runId, stale.runId].sort(),
    );
    const named = result.conflicts.find((c) => c.runId === auto.runId);
    expect(named?.sessionName).toBe("Auto run");
    expect(named?.state).toBe("running");
    // Every conflict carries a display name, never a path.
    for (const conflict of result.conflicts) {
      expect(conflict.sessionName.length).toBeGreaterThan(0);
      expect(conflict.sessionName).not.toContain("/");
    }
  });

  it("is clear for a cwd in a different repository and for a non-git cwd", async () => {
    const repo = makeRepo("repo");
    const other = makeRepo("other");
    const plain = join(base, "plain");
    mkdirSync(plain);
    seedRun({ permissionMode: "auto", worktreeRoot: repo });

    const guard = createLaunchGuard({ db: store.db, runGit: spyGit, realpath });
    expect(await guard.check({ cwd: other })).toEqual({ kind: "clear" });
    expect(await guard.check({ cwd: plain })).toEqual({ kind: "clear" });
  });

  it("runs only read-only git (Test 5)", async () => {
    const repo = makeRepo("repo");
    seedRun({ permissionMode: "auto", worktreeRoot: repo });
    const guard = createLaunchGuard({ db: store.db, runGit: spyGit, realpath });
    await guard.check({ cwd: repo });
    await listWorktrees(repo, { runGit: spyGit, realpath });
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const argv of gitCalls) {
      expect(
        READ_ONLY_GIT_ARGV.some((allowed) => JSON.stringify(allowed) === JSON.stringify(argv)),
      ).toBe(true);
    }
  });
});

describe("listWorktrees (D-28, PR-25)", () => {
  it("parses the porcelain list into opaque ids, branches and basenames", async () => {
    const repo = makeRepo("repo");
    const tree = join(base, "trees", "feature-x");
    mkdirSync(join(base, "trees"));
    testGit(repo, "worktree", "add", "-q", "-b", "feature-x", tree);

    const entries = await listWorktrees(repo, { runGit: spyGit, realpath });
    expect(entries.map((e) => [e.branch, e.folderBasename])).toEqual([
      ["main", "repo"],
      ["feature-x", "feature-x"],
    ]);
    for (const entry of entries) {
      expect(entry.worktreeId).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(entries[1]?.path).toBe(realpathSync(tree));
    // Stable: the same realpath always yields the same id.
    const again = await listWorktrees(join(repo, "sub"), { runGit: spyGit, realpath });
    expect(again.map((e) => e.worktreeId)).toEqual(entries.map((e) => e.worktreeId));
  });

  it("answers an empty list outside a repository", async () => {
    const plain = join(base, "plain");
    mkdirSync(plain);
    expect(await listWorktrees(plain, { runGit: spyGit, realpath })).toEqual([]);
  });
});
