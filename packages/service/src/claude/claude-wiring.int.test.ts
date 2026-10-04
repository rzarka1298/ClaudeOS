import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import http, { type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  HANDSHAKE_PATH,
  type HandshakeResponse,
  LAUNCH_PATH,
  type LaunchResponse,
  newRunId,
  type ProjectId,
  SESSION_BRANCH_PATH,
  SESSION_RESUME_PATH,
  SESSION_WORKTREES_PATH,
  type SessionRun,
} from "@ccc/domain";
import {
  applyMigrations,
  insertProject,
  listConflictCandidates,
  type OperationalStore,
  openStore,
  saveLauncherConfig,
  upsertSessionRun,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `routes.ts` imports the logger singleton, which opens its log file at
// import time (the session-action-routes.test.ts precedent).
vi.hoisted(() => {
  const base = `${process.env.HOME}/.ccc-test/cw-${process.pid}`;
  process.env.CCC_RUNTIME_DIR = base;
  process.env.CLAUDE_CONFIG_DIR = `${base}/claude`;
});

import { execFileSync } from "node:child_process";
import { createEventBus } from "../events/event-bus.js";
import { createLogger } from "../logging.js";
import { createLaunchService } from "../projects/launch-service.js";
import { createStoreProjectLookup as createPhase4Lookup } from "../projects/project-lookup.js";
import { ensureScriptDir } from "../projects/script-dir.js";
import { createRequestListener } from "../routes.js";
import { startSocketServer } from "../socket-server.js";
import { createFakeSpawner, type FakeSpawner } from "../test-support/fake-spawner.js";
import { runGit } from "./git-readonly.js";
import { createLaunchGuard, listWorktrees } from "./launch-guard.js";
import { createPhase4Bridge } from "./phase4-bridge.js";
import { type ClaudePipeline, createClaudePipeline } from "./pipeline.js";
import { createStoreProjectLookup } from "./project-lookup.js";
import type { SessionActionDeps } from "./session-action-routes.js";

/**
 * 05-17 Task 2: the real service routes with Phase 4's real launcher
 * (the Terminal.app script adapter) behind a fake spawner. Resume and
 * branch reach the terminal through the Phase 4 adapter, and Phase 4's own
 * "Start Claude Code" launch runs Phase 5's concurrent-write guard.
 */

const CLAUDE_EXE = "/usr/bin/true";
const SESSION_ID = "claude-session-abc";
const FORK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let dir: string;
let socketPath: string;
let store: OperationalStore;
let server: Server;
let spawner: FakeSpawner;
let scriptDir: string;
let repo: string;
let projectId: ProjectId;
let pipeline: ClaudePipeline;

function testGit(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function seedRun(patch: Partial<SessionRun>): SessionRun {
  const now = new Date(Date.now() - 60_000).toISOString();
  const run: SessionRun = {
    runId: newRunId(),
    revision: 1,
    claudeSessionId: randomUUID(),
    pid: null,
    pidStartedAt: null,
    state: "completed",
    activity: null,
    projectId,
    name: null,
    model: null,
    effort: null,
    launchSource: null,
    cwd: repo,
    worktreeRoot: repo,
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
    endedAt: patch.state === undefined || patch.state === "completed" ? now : null,
    terminateRequestedAt: null,
    endObservedAt: null,
    ...patch,
  };
  upsertSessionRun(store.db, run);
  return run;
}

function post<T>(path: string, body: unknown, token: string): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function handshake(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: HANDSHAKE_PATH, method: "POST" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve((JSON.parse(Buffer.concat(chunks).toString("utf8")) as HandshakeResponse).token),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

/** The script body Phase 4's Terminal.app adapter handed to `open` (the last hand-off). */
function lastScript(): string {
  const call = spawner.calls.at(-1);
  if (call === undefined) throw new Error("the spawner was never called");
  return readFileSync(call.argv[3] ?? "", "utf8");
}

beforeEach(async () => {
  const base = join(homedir(), ".ccc-test");
  mkdirSync(base, { recursive: true });
  dir = realpathSync(mkdtempSync(join(base, "cw-")));
  socketPath = join(dir, "t.sock");
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
  const bus = createEventBus();
  const logger = createLogger(join(dir, "logs", "service.log"));
  repo = join(dir, "code", "alpha");
  mkdirSync(repo, { recursive: true });
  testGit(repo, "init", "-q", "-b", "main");
  testGit(repo, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
  projectId = insertProject(store.db, { path: repo, displayName: "Alpha" }).record.projectId;
  saveLauncherConfig(store.db, "claude-code", {
    executablePath: CLAUDE_EXE,
    args: [],
    terminal: { kind: "terminal-app" },
  });
  spawner = createFakeSpawner();
  scriptDir = ensureScriptDir(join(dir, "runtime"));

  pipeline = createClaudePipeline({
    db: store.db,
    bus,
    logger,
    now: () => new Date(),
    mintRunId: newRunId,
    facts: {
      factsFor: async () => ({
        pidStartedAt: null,
        launchSource: null,
        projectId: null,
        worktreeRoot: null,
        transcriptPath: null,
      }),
    },
  });
  const guard = createLaunchGuard({ db: store.db, runGit, realpath });
  const bridge = createPhase4Bridge({
    store,
    spawner,
    scriptDir,
    lookup: createPhase4Lookup(store),
    guard,
    listWorktrees: (root) => listWorktrees(root, { runGit, realpath }),
    installedClaudeBin: () => "/opt/installer-recorded/claude",
    pipeline,
    mintRunId: newRunId,
    now: () => new Date(),
  });
  const actions: SessionActionDeps = {
    db: store.db,
    launcher: bridge.terminalLauncher,
    guard,
    lookup: createStoreProjectLookup(store.db),
    listWorktrees: (root) => listWorktrees(root, { runGit, realpath }),
    focus: { focus: async () => ({ ok: true, response: { outcome: "focused" } }) },
    proposer: { propose: async () => ({ ok: false, reason: "approval-unavailable" }) },
    claudeBin: bridge.claudeBin,
    claudeProjectsRoot: join(dir, "claude", "projects"),
    openFile: async () => undefined,
    now: () => new Date(),
    mintRunId: newRunId,
  };
  const launch = createLaunchService({
    store,
    spawner,
    lookup: createPhase4Lookup(store),
    collector: {
      refresh: () => undefined,
      onRegistryChanged: () => undefined,
      gitState: () => null,
    },
    logger: { info: () => undefined, warn: () => undefined },
    scriptDir,
    guard: bridge.startGuard,
  });
  const secret = randomBytes(32);
  server = await startSocketServer({
    socketPath,
    requestListener: createRequestListener({
      store,
      getSecret: () => secret,
      eventBus: bus,
      claude: { pipeline, actions },
      launch,
    }),
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("resume and branch launch through Phase 4's terminal launcher", () => {
  it("resume hands Phase 4's Terminal adapter an argv ending in --resume, S, with CCC_RUN_ID", async () => {
    const token = await handshake();
    const source = seedRun({ claudeSessionId: SESSION_ID });

    const res = await post<{ outcome: string }>(
      SESSION_RESUME_PATH,
      { runId: source.runId },
      token,
    );

    expect(res.body).toEqual({ outcome: "launched" });
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]?.argv.slice(0, 3)).toEqual([
      "/usr/bin/open",
      "-b",
      "com.apple.Terminal",
    ]);
    const script = lastScript();
    // The saved launcher's absolute claude wins over the installer's record.
    expect(script).toContain(`'${CLAUDE_EXE}' '--resume' '${SESSION_ID}'`);
    expect(script).toMatch(/CCC_RUN_ID='[0-9a-z]{25}'/);
    expect(script).not.toContain("/opt/installer-recorded/claude");
  });

  it("branch ends its argv in --fork-session, --session-id, U", async () => {
    const token = await handshake();
    const source = seedRun({ claudeSessionId: SESSION_ID });

    const res = await post<{ outcome: string; childRunId: string }>(
      SESSION_BRANCH_PATH,
      { runId: source.runId },
      token,
    );

    expect(res.body.outcome).toBe("launched");
    const script = lastScript();
    const forked = script.match(/'--fork-session' '--session-id' '([^']+)'/);
    expect(forked?.[1]).toMatch(FORK_UUID);
    expect(script).toContain(`'--resume' '${SESSION_ID}'`);
  });
});

describe("the concurrent-write guard runs inside Phase 4's Start Claude Code launch", () => {
  it("answers the guard's conflict shape and never calls the spawner", async () => {
    const token = await handshake();
    seedRun({ state: "running", endedAt: null, name: "Refactor parser" });

    const res = await post<LaunchResponse>(
      LAUNCH_PATH,
      { action: "claude-code", projectId },
      token,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: false,
      conflict: { projectName: "Alpha", conflicts: [{ sessionName: "Refactor parser" }] },
    });
    expect(spawner.calls).toHaveLength(0);
  });

  it("a retry with choice plan spawns with --permission-mode plan", async () => {
    const token = await handshake();
    seedRun({ state: "running", endedAt: null });

    const res = await post<LaunchResponse>(
      LAUNCH_PATH,
      { action: "claude-code", projectId, choice: { kind: "plan" } },
      token,
    );

    expect(res.body).toEqual({ ok: true });
    expect(spawner.calls).toHaveLength(1);
    expect(lastScript()).toContain(`'${CLAUDE_EXE}' '--permission-mode' 'plan'`);
  });

  it("a retry with choice continue launches with the stored argv unchanged", async () => {
    const token = await handshake();
    seedRun({ state: "running", endedAt: null });

    const res = await post<LaunchResponse>(
      LAUNCH_PATH,
      { action: "claude-code", projectId, choice: { kind: "continue" } },
      token,
    );

    expect(res.body).toEqual({ ok: true });
    expect(lastScript()).not.toContain("--permission-mode");
  });

  it("a new worktree choice appends --worktree NAME and nothing else", async () => {
    const token = await handshake();
    seedRun({ state: "running", endedAt: null });

    const res = await post<LaunchResponse>(
      LAUNCH_PATH,
      { action: "claude-code", projectId, choice: { kind: "new-worktree", name: "feature-x" } },
      token,
    );

    expect(res.body).toEqual({ ok: true });
    expect(lastScript()).toContain(`'${CLAUDE_EXE}' '--worktree' 'feature-x'`);
  });

  it("an existing-worktree id the service never issued launches nothing", async () => {
    const token = await handshake();

    const res = await post<LaunchResponse>(
      LAUNCH_PATH,
      {
        action: "claude-code",
        projectId,
        choice: { kind: "existing-worktree", worktreeId: "0123456789abcdef" },
      },
      token,
    );

    expect(res.body).toEqual({ ok: false, error: "spawn-failed" });
    expect(spawner.calls).toHaveLength(0);
  });

  it("an existing-worktree choice launches in the worktree while {projectPath} stays the project root", async () => {
    const token = await handshake();
    saveLauncherConfig(store.db, "claude-code", {
      executablePath: CLAUDE_EXE,
      args: ["--add-dir", "{projectPath}"],
      terminal: { kind: "terminal-app" },
    });
    const tree = join(dir, "trees", "feature");
    mkdirSync(join(dir, "trees"));
    testGit(repo, "worktree", "add", "-q", "-b", "feature", tree);
    const listed = await post<{ worktrees: Array<{ worktreeId: string; branch: string }> }>(
      SESSION_WORKTREES_PATH,
      { projectId },
      token,
    );
    const feature = listed.body.worktrees.find((w) => w.branch === "feature");
    expect(feature).toBeDefined();

    const res = await post<LaunchResponse>(
      LAUNCH_PATH,
      {
        action: "claude-code",
        projectId,
        choice: { kind: "existing-worktree", worktreeId: feature?.worktreeId },
      },
      token,
    );

    expect(res.body).toEqual({ ok: true });
    const script = lastScript();
    expect(script).toContain(`cd -- '${realpathSync(tree)}'`);
    expect(script).toContain(`'--add-dir' '${repo}'`);
  });

  it("launches straight through when nothing conflicts", async () => {
    const token = await handshake();
    const res = await post<LaunchResponse>(
      LAUNCH_PATH,
      { action: "claude-code", projectId },
      token,
    );
    expect(res.body).toEqual({ ok: true });
    expect(spawner.calls).toHaveLength(1);
  });

  it("the guard does not intercept other launch actions", async () => {
    const token = await handshake();
    seedRun({ state: "running", endedAt: null });
    const res = await post<LaunchResponse>(LAUNCH_PATH, { action: "finder", projectId }, token);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("Codex review findings 1 and 2: launch registration and serialization", () => {
  it("finding 1: a fresh Start is pre-registered as a dashboard Run before the terminal opens, so a second Start conflicts", async () => {
    const token = await handshake();

    const first = await post<LaunchResponse>(
      LAUNCH_PATH,
      { action: "claude-code", projectId },
      token,
    );
    expect(first.body).toEqual({ ok: true });

    // No SessionStart hook has arrived: the Run exists only because the launch registered it.
    const candidates = listConflictCandidates(store.db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.state).toBe("starting");
    expect(lastScript()).toContain(`CCC_RUN_ID='${candidates[0]?.runId}'`);
    expect(lastScript()).toContain("CCC_LAUNCH_SOURCE='dashboard'");

    const second = await post<LaunchResponse>(
      LAUNCH_PATH,
      { action: "claude-code", projectId },
      token,
    );
    expect(second.body).toMatchObject({ ok: false, conflict: { projectName: "Alpha" } });
    expect(spawner.calls).toHaveLength(1);
  });

  it("finding 1: a refused hand-off leaves no pre-registered Run behind", async () => {
    const token = await handshake();
    const bad = await post<LaunchResponse>(
      LAUNCH_PATH,
      {
        action: "claude-code",
        projectId,
        choice: { kind: "existing-worktree", worktreeId: "0123456789abcdef" },
      },
      token,
    );
    expect(bad.body).toEqual({ ok: false, error: "spawn-failed" });
    expect(listConflictCandidates(store.db)).toHaveLength(0);
  });

  it("finding 2: concurrent resumes from different subdirectories of one repo cannot both write", async () => {
    const token = await handshake();
    const subA = join(repo, "sub-a");
    const subB = join(repo, "sub-b");
    mkdirSync(subA);
    mkdirSync(subB);
    const a = seedRun({ projectId: null, cwd: subA, worktreeRoot: null });
    const b = seedRun({ projectId: null, cwd: subB, worktreeRoot: null });

    const [ra, rb] = await Promise.all([
      post<{ outcome: string }>(SESSION_RESUME_PATH, { runId: a.runId }, token),
      post<{ outcome: string }>(SESSION_RESUME_PATH, { runId: b.runId }, token),
    ]);

    expect([ra.body.outcome, rb.body.outcome].sort()).toEqual(["conflict", "launched"]);
    expect(spawner.calls).toHaveLength(1);
  });

  it("finding 2: a fresh Start and a resume into the same repo share one lock", async () => {
    const token = await handshake();
    const sub = join(repo, "sub-c");
    mkdirSync(sub);
    const src = seedRun({ projectId: null, cwd: sub, worktreeRoot: null });

    const [start, resume] = await Promise.all([
      post<LaunchResponse>(LAUNCH_PATH, { action: "claude-code", projectId }, token),
      post<{ outcome: string }>(SESSION_RESUME_PATH, { runId: src.runId }, token),
    ]);

    const startOk = "ok" in start.body && start.body.ok === true;
    const resumeOk = resume.body.outcome === "launched";
    expect(startOk !== resumeOk).toBe(true);
    expect(spawner.calls).toHaveLength(1);
  });
});
