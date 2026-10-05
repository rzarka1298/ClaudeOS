import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import http, { type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  HANDSHAKE_PATH,
  type HandshakeResponse,
  newRunId,
  type RunId,
  SESSION_ACTION_ERROR_CODES,
  SESSION_ASSOCIATE_PATH,
  SESSION_BRANCH_PATH,
  SESSION_FOCUS_PATH,
  SESSION_OPEN_TRANSCRIPT_PATH,
  SESSION_RESUME_PATH,
  SESSION_TERMINATE_REQUEST_PATH,
  SESSION_WORKTREES_PATH,
  type SessionRun,
  type SessionTerminalLauncher,
  WorktreeListResponseSchema,
} from "@ccc/domain";
import {
  applyMigrations,
  getSessionOverride,
  getSessionRun,
  latestRunBySession,
  listSessionRunsForView,
  type OperationalStore,
  openStore,
  upsertSessionRun,
} from "@ccc/operational-store";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `routes.ts` imports the logger singleton, which opens its log file at
// import time: point the runtime dir at a short test path BEFORE any import
// resolves (PATTERNS "Temp dirs").
const env = vi.hoisted(() => {
  const base = `${process.env.HOME}/.ccc-test/sa-${process.pid}`;
  process.env.CCC_RUNTIME_DIR = base;
  process.env.CLAUDE_CONFIG_DIR = `${base}/claude`;
  return { base };
});

import type { Logger } from "pino";
import { createEventBus, type EventBus } from "../events/event-bus.js";
import { createLogger } from "../logging.js";
import { createRequestListener } from "../routes.js";
import { startSocketServer } from "../socket-server.js";
import {
  FakeProposeForceTerminate,
  FakeSessionTerminalLauncher,
} from "../test-support/fake-ports.js";
import { createAttribution } from "./attribution.js";
import { approvalUnavailableProposer, unconfiguredTerminalLauncher } from "./default-ports.js";
import type { FocusOutcome } from "./focus.js";
import { READ_ONLY_GIT_ARGV, type RunGit, runGit } from "./git-readonly.js";
import { createLaunchGuard, listWorktrees } from "./launch-guard.js";
import {
  type ClaudePipeline,
  createClaudePipeline,
  type SessionFactsProvider,
} from "./pipeline.js";
import { createSessionFactsProvider, type ProcessFacts } from "./process-facts.js";
import { createStoreProjectLookup } from "./project-lookup.js";
import type { SessionActionDeps } from "./session-action-routes.js";

const TEST_BASE = join(homedir(), ".ccc-test");
const CLAUDE_BIN = "/opt/claude-test/bin/claude";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const NULL_FACTS: SessionFactsProvider = {
  factsFor: async () => ({
    pidStartedAt: null,
    launchSource: null,
    projectId: null,
    worktreeRoot: null,
    transcriptPath: null,
  }),
};

interface SocketReply<T> {
  status: number;
  body: T;
}

/** Raw `node:http` over the socket, with a body (the ingest-routes.test.ts helper). */
function request<T>(
  socketPath: string,
  opts: { method: string; path: string; rawBody?: string; token?: string },
): Promise<SocketReply<T>> {
  return new Promise((resolve, reject) => {
    const payload = opts.rawBody ?? "";
    const req = http.request(
      {
        socketPath,
        path: opts.path,
        method: opts.method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            body: (raw.length > 0 ? JSON.parse(raw) : undefined) as T,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function handshake(): Promise<string> {
  const res = await request<HandshakeResponse>(socketPath, {
    method: "POST",
    path: HANDSHAKE_PATH,
  });
  expect(res.status).toBe(200);
  return res.body.token;
}

/** Every body an action route answered, for the no-path/no-pid sweep (Test 6). */
const answered: Array<{ status: number; body: unknown }> = [];

async function post<T>(path: string, body: unknown, token: string): Promise<SocketReply<T>> {
  const res = await request<T>(socketPath, {
    method: "POST",
    path,
    rawBody: JSON.stringify(body),
    token,
  });
  answered.push(res);
  return res;
}

/** The TEST's own git setup (a write, so never through the service gateway). */
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

/** Test seeding only: product code never writes `projects` (D-57). */
function registerProject(projectId: string, root: string, name = projectId): void {
  store.db
    .prepare(
      "INSERT INTO projects (project_id, path, workspace_id, display_name, registered_at) VALUES (?, ?, NULL, ?, ?)",
    )
    .run(projectId, root, name, "2026-09-29T00:00:00.000Z");
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
    endedAt: patch.state === undefined || patch.state === "completed" ? now : null,
    terminateRequestedAt: null,
    endObservedAt: null,
    ...patch,
  };
  upsertSessionRun(store.db, run);
  return run;
}

/** Runs linked from `runId` (the pre-registered resume or fork children). */
function childrenOf(runId: RunId): SessionRun[] {
  return listSessionRunsForView(store.db, { endedSince: "2000-01-01T00:00:00.000Z" }).filter(
    (run) => run.linkedFromRunId === runId,
  );
}

let dir: string;
let socketPath: string;
let store: OperationalStore;
let bus: EventBus;
let server: Server;
let pipeline: ClaudePipeline;
let launcher: SessionTerminalLauncher;
let fake: FakeSessionTerminalLauncher;
let proposer: FakeProposeForceTerminate;
let gitCalls: string[][];
let repo: string;
let claudeBin: string | null;
let openCalls: string[][];
let focusAnswer: FocusOutcome;
let focusCalls: RunId[];
let facts: SessionFactsProvider;
let logger: Logger;
/** Wave 5: extra latency before each guard check, and the flow budget override. */
let guardDelayMs: number;
let launchBudgetMs: number | undefined;
/** When true, every git read fails, so the guard cannot read the launch target's tree. */
let gitFailure = false;

const spyGit: RunGit = (cwd, argv, options) => {
  gitCalls.push([...argv]);
  if (gitFailure) return Promise.reject(new Error("git unavailable"));
  return runGit(cwd, argv, options);
};

beforeEach(async () => {
  gitFailure = false;
  mkdirSync(TEST_BASE, { recursive: true });
  dir = realpathSync(mkdtempSync(join(TEST_BASE, "sa-")));
  socketPath = join(dir, "t.sock");
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
  bus = createEventBus();
  logger = createLogger(join(dir, "logs", "service.log"));
  facts = NULL_FACTS;
  pipeline = createClaudePipeline({
    db: store.db,
    bus,
    logger,
    now: () => new Date(),
    mintRunId: newRunId,
    // Swappable per test: the associate test needs real attribution.
    facts: {
      factsFor: (record) => facts.factsFor(record),
      deferredFactsFor: (record) => facts.deferredFactsFor?.(record) ?? null,
    },
  });
  openCalls = [];
  focusCalls = [];
  focusAnswer = { ok: true, response: { outcome: "focused" } };
  fake = new FakeSessionTerminalLauncher();
  launcher = fake;
  proposer = new FakeProposeForceTerminate();
  gitCalls = [];
  claudeBin = CLAUDE_BIN;
  repo = join(dir, "code", "alpha");
  mkdirSync(join(repo, "src"), { recursive: true });
  testGit(repo, "init", "-q", "-b", "main");
  testGit(repo, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
  registerProject("alpha", repo, "Alpha");

  guardDelayMs = 0;
  launchBudgetMs = undefined;
  const realGuard = createLaunchGuard({ db: store.db, runGit: spyGit, realpath });
  const actions: SessionActionDeps = {
    db: store.db,
    launcher: { launch: (req) => launcher.launch(req) },
    guard: {
      check: async (target) => {
        if (guardDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, guardDelayMs));
        return realGuard.check(target);
      },
      worktreeRootOf: (cwd) => realGuard.worktreeRootOf(cwd),
    },
    launchBudgetMs: () => launchBudgetMs,
    lookup: createStoreProjectLookup(store.db),
    listWorktrees: (root) => listWorktrees(root, { runGit: spyGit, realpath }),
    focus: {
      focus: async (runId) => {
        focusCalls.push(runId);
        return focusAnswer;
      },
    },
    proposer: { propose: (req) => proposer.propose(req) },
    claudeBin: () => claudeBin,
    claudeProjectsRoot: join(dir, "claude", "projects"),
    openFile: async (args) => {
      openCalls.push([...args]);
    },
    now: () => new Date(),
    mintRunId: newRunId,
  };
  server = await startSocketServer({
    socketPath,
    requestListener: createRequestListener({
      store,
      getSecret: (() => {
        const secret = randomBytes(32);
        return () => secret;
      })(),
      eventBus: bus,
      claude: { pipeline, actions },
    }),
  });
});

afterEach(async () => {
  server.close();
  await pipeline.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(env.base, { recursive: true, force: true });
});

describe("POST /api/v1/sessions/resume (Task 1 tracer, SESS-13, D-32, PR-10, PR-25)", () => {
  it("launches `claude --resume S` at the project root with a pre-registered linked Run (Test 2)", async () => {
    const token = await handshake();
    const source = seedRun({ projectId: "alpha", cwd: join(repo, "src") });

    const res = await post(SESSION_RESUME_PATH, { runId: source.runId }, token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: "launched" });

    expect(fake.requests).toHaveLength(1);
    const [launch] = fake.requests;
    expect(launch?.cwd).toBe(repo);
    expect(launch?.argv).toEqual([CLAUDE_BIN, "--resume", source.claudeSessionId]);
    expect(launch?.argv).not.toContain("--session-id");
    expect(launch?.env?.CCC_LAUNCH_SOURCE).toBe("dashboard");
    expect(launch?.env).not.toHaveProperty("CCC_INTERNAL");
    expect(Object.keys(launch?.env ?? {}).sort()).toEqual(["CCC_LAUNCH_SOURCE", "CCC_RUN_ID"]);

    const childId = launch?.env?.CCC_RUN_ID as RunId;
    expect(childId).not.toBe(source.runId);
    const child = getSessionRun(store.db, childId);
    expect(child).toMatchObject({
      state: "starting",
      linkKind: "resume",
      linkedFromRunId: source.runId,
      claudeSessionId: source.claudeSessionId,
    });
  });

  it("lists the worktrees of a launched project by projectId, not by a Run's project (05-17)", async () => {
    const token = await handshake();
    const otherId = "otherproj0123456789abcdef";
    const otherRepo = join(dir, "other");
    mkdirSync(otherRepo);
    testGit(otherRepo, "init", "-q", "-b", "trunk");
    testGit(otherRepo, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
    registerProject(otherId, otherRepo, "Other");

    const byProject = await post(SESSION_WORKTREES_PATH, { projectId: otherId }, token);
    expect(byProject.status).toBe(200);
    expect(WorktreeListResponseSchema.parse(byProject.body).worktrees.map((w) => w.branch)).toEqual(
      ["trunk"],
    );
    expect(JSON.stringify(byProject.body)).not.toContain(dir);

    const unknown = await post(
      SESSION_WORKTREES_PATH,
      { projectId: "missingpr0123456789abcdef" },
      token,
    );
    expect(unknown.status).toBe(409);
  });

  it("returns the conflict list first, then launches each of the four choices (Test 3, D-28)", async () => {
    const token = await handshake();
    const source = seedRun({ projectId: "alpha", cwd: repo });
    const writer = seedRun({
      state: "running",
      permissionMode: "default",
      worktreeRoot: repo,
      name: "Busy writer",
    });

    const first = await post<{ outcome: string; projectName: string; conflicts: unknown[] }>(
      SESSION_RESUME_PATH,
      { runId: source.runId },
      token,
    );
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ outcome: "conflict", projectName: "Alpha" });
    expect(first.body.conflicts).toEqual([
      {
        runId: writer.runId,
        sessionName: "Busy writer",
        state: "running",
        lastActivityAt: writer.lastActivityAt,
      },
    ]);
    expect(fake.requests).toHaveLength(0);
    expect(childrenOf(source.runId)).toHaveLength(0);

    const plan = await post(
      SESSION_RESUME_PATH,
      { runId: source.runId, choice: { kind: "plan" } },
      token,
    );
    expect(plan.body).toEqual({ outcome: "launched" });
    expect(fake.requests.at(-1)?.argv).toEqual([
      CLAUDE_BIN,
      "--resume",
      source.claudeSessionId,
      "--permission-mode",
      "plan",
    ]);

    const fresh = await post(
      SESSION_RESUME_PATH,
      { runId: source.runId, choice: { kind: "new-worktree", name: "fix-parser" } },
      token,
    );
    expect(fresh.body).toEqual({ outcome: "launched" });
    expect(fake.requests.at(-1)?.argv).toEqual([
      CLAUDE_BIN,
      "--resume",
      source.claudeSessionId,
      "--worktree",
      "fix-parser",
    ]);
    expect(fake.requests.at(-1)?.cwd).toBe(repo);

    // An existing worktree is addressed by the opaque id the worktrees route issued.
    const tree = join(dir, "trees", "feature");
    mkdirSync(join(dir, "trees"));
    testGit(repo, "worktree", "add", "-q", "-b", "feature", tree);
    const listed = await post(SESSION_WORKTREES_PATH, { runId: source.runId }, token);
    expect(listed.status).toBe(200);
    const worktrees = WorktreeListResponseSchema.parse(listed.body).worktrees;
    expect(worktrees.map((w) => w.branch)).toEqual(["main", "feature"]);
    expect(JSON.stringify(listed.body)).not.toContain(dir);
    const feature = worktrees.find((w) => w.branch === "feature");

    const existing = await post(
      SESSION_RESUME_PATH,
      {
        runId: source.runId,
        choice: { kind: "existing-worktree", worktreeId: feature?.worktreeId },
      },
      token,
    );
    expect(existing.body).toEqual({ outcome: "launched" });
    expect(fake.requests.at(-1)?.cwd).toBe(realpathSync(tree));
    expect(fake.requests.at(-1)?.argv).toEqual([CLAUDE_BIN, "--resume", source.claudeSessionId]);

    const unknown = await post(
      SESSION_RESUME_PATH,
      {
        runId: source.runId,
        choice: { kind: "existing-worktree", worktreeId: "0123456789abcdef" },
      },
      token,
    );
    expect(unknown.status).toBe(409);
    expect(unknown.body).toEqual({ error: "invalid-state" });

    const count = fake.requests.length;
    const plain = await post(
      SESSION_RESUME_PATH,
      { runId: source.runId, choice: { kind: "continue" } },
      token,
    );
    expect(plain.body).toEqual({ outcome: "launched" });
    expect(fake.requests).toHaveLength(count + 1);
    expect(fake.requests.at(-1)?.argv).toEqual([CLAUDE_BIN, "--resume", source.claudeSessionId]);
  });

  it("refuses a running Run, a Run without a session id, an unknown Run and an unset launcher (Test 4, D-32, PR-17)", async () => {
    const token = await handshake();
    const running = seedRun({ state: "running", projectId: "alpha" });
    expect(await post(SESSION_RESUME_PATH, { runId: running.runId }, token)).toMatchObject({
      status: 409,
      body: { error: "invalid-state" },
    });

    const noSession = seedRun({ claudeSessionId: null, projectId: "alpha" });
    expect(await post(SESSION_RESUME_PATH, { runId: noSession.runId }, token)).toMatchObject({
      status: 409,
      body: { error: "invalid-state" },
    });

    expect(await post(SESSION_RESUME_PATH, { runId: newRunId() }, token)).toMatchObject({
      status: 404,
      body: { error: "run-not-found" },
    });

    const gone = seedRun({ projectId: null, cwd: join(dir, "moved-away") });
    expect(await post(SESSION_RESUME_PATH, { runId: gone.runId }, token)).toMatchObject({
      status: 409,
      body: { error: "project-missing" },
    });

    claudeBin = null;
    const noBin = seedRun({ projectId: "alpha" });
    expect(await post(SESSION_RESUME_PATH, { runId: noBin.runId }, token)).toMatchObject({
      status: 409,
      body: { error: "launcher-not-configured" },
    });
    claudeBin = CLAUDE_BIN;

    launcher = unconfiguredTerminalLauncher;
    const source = seedRun({ projectId: "alpha" });
    expect(await post(SESSION_RESUME_PATH, { runId: source.runId }, token)).toMatchObject({
      status: 409,
      body: { error: "launcher-not-configured" },
    });
    const children = childrenOf(source.runId);
    expect(children).toHaveLength(1);
    expect(children[0]?.state).toBe("failed");
    expect(fake.requests).toHaveLength(0);
  });

  it("maps every launcher failure to its own error code", async () => {
    const token = await handshake();
    fake.result = { ok: false, reason: "automation-denied" };
    const source = seedRun({ projectId: "alpha" });
    expect(await post(SESSION_RESUME_PATH, { runId: source.runId }, token)).toMatchObject({
      status: 409,
      body: { error: "automation-denied" },
    });
  });

  it("recorded cwd is the fallback when the Run has no project", async () => {
    const token = await handshake();
    const loose = join(dir, "scratch");
    mkdirSync(loose);
    const source = seedRun({ projectId: null, cwd: loose });
    const res = await post(SESSION_RESUME_PATH, { runId: source.runId }, token);
    expect(res.body).toEqual({ outcome: "launched" });
    expect(fake.requests.at(-1)?.cwd).toBe(loose);
  });
});

describe("no session action ever writes Git state (Test 5, SESS-11, D-30, T-05-61)", () => {
  it("the resume, worktree and guard flows run only allow-listed read-only argv", async () => {
    const token = await handshake();
    const source = seedRun({ projectId: "alpha" });
    seedRun({ state: "running", permissionMode: "auto", worktreeRoot: repo });
    await post(SESSION_RESUME_PATH, { runId: source.runId }, token);
    await post(SESSION_WORKTREES_PATH, { runId: source.runId }, token);
    await post(SESSION_RESUME_PATH, { runId: source.runId, choice: { kind: "continue" } }, token);
    await post(
      SESSION_RESUME_PATH,
      { runId: source.runId, choice: { kind: "new-worktree", name: "fresh" } },
      token,
    );
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const argv of gitCalls) {
      expect(
        READ_ONLY_GIT_ARGV.some((allowed) => JSON.stringify(allowed) === JSON.stringify(argv)),
      ).toBe(true);
    }
  });

  it("no non-test source under claude/ builds a git-write argv", () => {
    const claudeDir = import.meta.dirname;
    const quote = "[\"'`]";
    const writeArgv = new RegExp(
      `\\[\\s*${quote}(?:worktree${quote}\\s*,\\s*${quote}add|checkout|commit|switch|branch)${quote}`,
    );
    expect(writeArgv.test(`["worktree", "add", name]`)).toBe(true);
    expect(writeArgv.test(`['checkout', 'main']`)).toBe(true);
    const offenders = readdirSync(claudeDir)
      .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
      .filter((name) => writeArgv.test(readFileSync(join(claudeDir, name), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("every session action is authenticated and answers a fixed code (Test 6, D-36)", () => {
  const ROUTES = [
    SESSION_FOCUS_PATH,
    SESSION_RESUME_PATH,
    SESSION_BRANCH_PATH,
    SESSION_WORKTREES_PATH,
    SESSION_OPEN_TRANSCRIPT_PATH,
    SESSION_ASSOCIATE_PATH,
    SESSION_TERMINATE_REQUEST_PATH,
  ];

  it.each(ROUTES)("%s answers 401 without a token", async (path) => {
    const res = await request(socketPath, {
      method: "POST",
      path,
      rawBody: JSON.stringify({ runId: newRunId() }),
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "authentication required" });
  });

  it("every error body is a SESSION_ACTION_ERROR_CODES entry with no path or pid inside", async () => {
    const token = await handshake();
    const running = seedRun({ state: "running", projectId: "alpha", pid: 4242, cwd: repo });
    await post(SESSION_RESUME_PATH, { runId: running.runId }, token);
    await post(SESSION_RESUME_PATH, { runId: newRunId() }, token);
    await post(SESSION_WORKTREES_PATH, { runId: newRunId() }, token);
    launcher = unconfiguredTerminalLauncher;
    await post(SESSION_RESUME_PATH, { runId: seedRun({ projectId: "alpha" }).runId }, token);

    const errors = answered.filter((reply) => reply.status >= 400 && reply.status !== 400);
    expect(errors.length).toBeGreaterThanOrEqual(4);
    for (const reply of errors) {
      const body = reply.body as { error: string };
      expect(Object.keys(body)).toEqual(["error"]);
      expect(SESSION_ACTION_ERROR_CODES).toContain(body.error);
      const text = JSON.stringify(body);
      expect(text).not.toContain("/");
      expect(text).not.toContain("4242");
    }
  });

  it("a body with an extra key is refused with 400 (strict schema)", async () => {
    const token = await handshake();
    const source = seedRun({ projectId: "alpha" });
    const res = await post(SESSION_RESUME_PATH, { runId: source.runId, cwd: "/tmp" }, token);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid-state" });
    expect(fake.requests).toHaveLength(0);
  });

  it("maps unreadable guard state to a fixed code without registering or launching", async () => {
    const token = await handshake();
    const source = seedRun({ projectId: "alpha", cwd: repo });
    gitFailure = true;

    const reply = await post(SESSION_RESUME_PATH, { runId: source.runId }, token);

    expect(reply).toEqual({ status: 409, body: { error: "guard-unavailable" } });
    expect(childrenOf(source.runId)).toEqual([]);
    expect(fake.requests).toEqual([]);
  });
});

describe("POST /api/v1/sessions/branch (Task 2 Test 1, SESS-14, D-33, PR-10)", () => {
  it("launches --resume S --fork-session --session-id U and pre-registers the linked fork", async () => {
    const token = await handshake();
    const source = seedRun({ projectId: "alpha", state: "running" });

    const res = await post<{ outcome: string; childRunId: RunId }>(
      SESSION_BRANCH_PATH,
      { runId: source.runId },
      token,
    );
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("launched");
    expect(fake.requests).toHaveLength(1);
    const [launch] = fake.requests;
    const argv = launch?.argv ?? [];
    expect(argv.slice(0, 5)).toEqual([
      CLAUDE_BIN,
      "--resume",
      source.claudeSessionId,
      "--fork-session",
      "--session-id",
    ]);
    expect(argv).toHaveLength(6);
    const forkId = argv[5] as string;
    expect(forkId).toMatch(UUID);
    expect(forkId).not.toBe(source.claudeSessionId);
    expect(launch?.cwd).toBe(repo);
    expect(launch?.env).toEqual({
      CCC_RUN_ID: res.body.childRunId,
      CCC_LAUNCH_SOURCE: "dashboard",
    });

    expect(getSessionRun(store.db, res.body.childRunId)).toMatchObject({
      state: "starting",
      claudeSessionId: forkId,
      linkKind: "fork",
      linkedFromRunId: source.runId,
    });
  });

  it("runs the guard exactly as resume does", async () => {
    const token = await handshake();
    const source = seedRun({ projectId: "alpha" });
    seedRun({ state: "running", permissionMode: "auto", worktreeRoot: repo, name: "Writer" });

    const first = await post(SESSION_BRANCH_PATH, { runId: source.runId }, token);
    expect(first.body).toMatchObject({ outcome: "conflict", projectName: "Alpha" });
    expect(fake.requests).toHaveLength(0);

    const planned = await post<{ outcome: string }>(
      SESSION_BRANCH_PATH,
      { runId: source.runId, choice: { kind: "plan" } },
      token,
    );
    expect(planned.body.outcome).toBe("launched");
    expect(fake.requests.at(-1)?.argv.slice(-2)).toEqual(["--permission-mode", "plan"]);
    expect(fake.requests.at(-1)?.argv.slice(1, 4)).toEqual([
      "--resume",
      source.claudeSessionId,
      "--fork-session",
    ]);
  });

  it("refuses a Run without a session id and an unknown Run", async () => {
    const token = await handshake();
    const noSession = seedRun({ claudeSessionId: null, projectId: "alpha" });
    expect(await post(SESSION_BRANCH_PATH, { runId: noSession.runId }, token)).toMatchObject({
      status: 409,
      body: { error: "invalid-state" },
    });
    expect(await post(SESSION_BRANCH_PATH, { runId: newRunId() }, token)).toMatchObject({
      status: 404,
      body: { error: "run-not-found" },
    });
    expect(fake.requests).toHaveLength(0);
  });
});

describe("POST /api/v1/sessions/open-transcript (Task 2 Tests 2-3, SESS-15, D-34, PR-07)", () => {
  function transcriptFile(sessionId: string): string {
    const folder = join(dir, "claude", "projects", "-code-alpha");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `${sessionId}.jsonl`);
    writeFileSync(file, "{}\n");
    return file;
  }

  it("reveals with open -R, or opens in a text editor, only the Run's own transcript", async () => {
    const token = await handshake();
    const sessionId = randomUUID();
    const file = transcriptFile(sessionId);
    const run = seedRun({ claudeSessionId: sessionId, transcriptPath: file });

    const reveal = await post(
      SESSION_OPEN_TRANSCRIPT_PATH,
      { runId: run.runId, mode: "reveal" },
      token,
    );
    expect(reveal.status).toBe(200);
    expect(reveal.body).toEqual({ outcome: "opened" });
    expect(openCalls).toEqual([["-R", file]]);

    const open = await post(
      SESSION_OPEN_TRANSCRIPT_PATH,
      { runId: run.runId, mode: "open" },
      token,
    );
    expect(open.status).toBe(200);
    // A text editor, never the default-app handler (wave 5 review).
    expect(openCalls.at(-1)).toEqual(["-t", file]);
    expect(JSON.stringify(reveal.body) + JSON.stringify(open.body)).not.toContain(dir);
  });

  it("answers transcript-missing for a deleted file and for a Run with no transcript", async () => {
    const token = await handshake();
    const sessionId = randomUUID();
    const file = transcriptFile(sessionId);
    rmSync(file);
    const deleted = seedRun({ claudeSessionId: sessionId, transcriptPath: file });
    expect(
      await post(SESSION_OPEN_TRANSCRIPT_PATH, { runId: deleted.runId, mode: "reveal" }, token),
    ).toMatchObject({ status: 409, body: { error: "transcript-missing" } });

    const none = seedRun({ transcriptPath: null });
    expect(
      await post(SESSION_OPEN_TRANSCRIPT_PATH, { runId: none.runId, mode: "open" }, token),
    ).toMatchObject({ status: 409, body: { error: "transcript-missing" } });

    expect(
      await post(SESSION_OPEN_TRANSCRIPT_PATH, { runId: newRunId(), mode: "open" }, token),
    ).toMatchObject({ status: 404, body: { error: "run-not-found" } });
    expect(openCalls).toEqual([]);
  });

  it("refuses a body carrying a path (strict schema)", async () => {
    const token = await handshake();
    const file = transcriptFile(randomUUID());
    const run = seedRun({ transcriptPath: file });
    const res = await post(
      SESSION_OPEN_TRANSCRIPT_PATH,
      { runId: run.runId, mode: "reveal", path: "/etc/hosts" },
      token,
    );
    expect(res.status).toBe(400);
    expect(openCalls).toEqual([]);
  });

  it("re-checks containment at request time: a tampered row gives transcript-outside-root (Test 3)", async () => {
    const token = await handshake();
    const run = seedRun({ transcriptPath: null });
    // Inserted directly, as a tampered store row would be.
    store.db
      .prepare("UPDATE runs SET transcript_path = ? WHERE run_id = ?")
      .run("/etc/hosts", run.runId);

    const res = await post(SESSION_OPEN_TRANSCRIPT_PATH, { runId: run.runId, mode: "open" }, token);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "transcript-outside-root" });
    expect(openCalls).toEqual([]);
  });
});

describe("POST /api/v1/sessions/associate (Task 2 Test 4, SESS-17, D-24)", () => {
  const stubProcessFacts: ProcessFacts = {
    isAlive: () => false,
    readStartTimes: async () => new Map(),
    readTty: async () => null,
    readAncestry: async () => [],
  };

  it("writes the override for a registered project, re-attributes the Run, and later SessionStarts follow it", async () => {
    const token = await handshake();
    facts = createSessionFactsProvider({
      processFacts: stubProcessFacts,
      claudeProjectsRoot: join(dir, "claude", "projects"),
      logger,
      attribute: createAttribution({
        lookup: createStoreProjectLookup(store.db),
        getOverride: (id) => getSessionOverride(store.db, id),
        realpath,
        runGit,
        logger,
      }),
      getOverride: (id) => getSessionOverride(store.db, id),
    });
    const elsewhere = join(dir, "scratch", "notes");
    mkdirSync(elsewhere, { recursive: true });
    const sessionId = randomUUID();
    const run = seedRun({ claudeSessionId: sessionId, projectId: null, cwd: elsewhere });

    const res = await post(SESSION_ASSOCIATE_PATH, { runId: run.runId, projectId: "alpha" }, token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: "associated" });
    expect(getSessionOverride(store.db, sessionId)).toBe("alpha");
    expect(getSessionRun(store.db, run.runId)?.projectId).toBe("alpha");
    const replay = bus.buffer.since(0);
    if (replay.mode !== "replay") throw new Error("expected a replay");
    const upserted = replay.events.filter((event) => event.type === "session.upserted");
    expect(upserted.at(-1)?.payload).toMatchObject({
      session: { runId: run.runId, projectId: "alpha" },
    });

    // A later SessionStart of the same session (a new process) attributes to the chosen project.
    const outcome = await pipeline.ingest(
      {
        eventId: randomUUID(),
        observedAt: new Date().toISOString(),
        hook_event_name: "SessionStart",
        session_id: sessionId,
        cwd: elsewhere,
        source: "resume",
        env: { CLAUDE_PID: "4343" },
      },
      "socket",
    );
    expect(outcome).toBe("applied");
    await pipeline.stop();
    const later = latestRunBySession(store.db, sessionId);
    expect(later?.runId).not.toBe(run.runId);
    expect(later?.projectId).toBe("alpha");
  });

  it("refuses an unregistered project and a Run without a session id, writing nothing", async () => {
    const token = await handshake();
    const sessionId = randomUUID();
    const run = seedRun({ claudeSessionId: sessionId });
    expect(
      await post(SESSION_ASSOCIATE_PATH, { runId: run.runId, projectId: "not-registered" }, token),
    ).toMatchObject({ status: 409, body: { error: "project-not-registered" } });
    expect(getSessionOverride(store.db, sessionId)).toBeNull();

    const noSession = seedRun({ claudeSessionId: null });
    expect(
      await post(SESSION_ASSOCIATE_PATH, { runId: noSession.runId, projectId: "alpha" }, token),
    ).toMatchObject({ status: 409, body: { error: "invalid-state" } });
    expect(
      await post(SESSION_ASSOCIATE_PATH, { runId: newRunId(), projectId: "alpha" }, token),
    ).toMatchObject({ status: 404, body: { error: "run-not-found" } });
  });

  it("the session-action routes import nothing from the vault (source scan)", () => {
    const text = readFileSync(join(import.meta.dirname, "session-action-routes.ts"), "utf8");
    expect(text).toContain("setSessionOverride");
    expect(text).not.toMatch(/@ccc\/vault-repo/);
    expect(text).not.toMatch(/vault/i);
  });
});

describe("POST /api/v1/sessions/focus (Task 3, SESS-12, D-31, PR-27)", () => {
  it("answers the focus outcome, or its specific code", async () => {
    const token = await handshake();
    const run = seedRun({ state: "running", pid: 4242 });

    expect(await post(SESSION_FOCUS_PATH, { runId: run.runId }, token)).toMatchObject({
      status: 200,
      body: { outcome: "focused" },
    });
    expect(focusCalls).toEqual([run.runId]);

    focusAnswer = { ok: true, response: { outcome: "activated", terminalApp: "Ghostty" } };
    expect((await post(SESSION_FOCUS_PATH, { runId: run.runId }, token)).body).toEqual({
      outcome: "activated",
      terminalApp: "Ghostty",
    });

    for (const reason of [
      "background-session",
      "terminal-unsupported",
      "automation-denied",
      "process-ended",
      "timeout",
    ] as const) {
      focusAnswer = { ok: false, reason };
      expect(await post(SESSION_FOCUS_PATH, { runId: run.runId }, token)).toMatchObject({
        status: 409,
        body: { error: reason },
      });
    }
    focusAnswer = { ok: false, reason: "run-not-found" };
    expect(await post(SESSION_FOCUS_PATH, { runId: run.runId }, token)).toMatchObject({
      status: 404,
      body: { error: "run-not-found" },
    });
  });
});

describe("POST /api/v1/sessions/terminate-request (Task 3 Test 5, SESS-16, PR-13, PR-26)", () => {
  it("answers approval-unavailable before Phase 6, and only proposes once an inbox exists", async () => {
    const token = await handshake();
    const run = seedRun({ state: "running", pid: 4242, pidStartedAt: "2026-09-30T01:00:00.000Z" });

    proposer.result = await approvalUnavailableProposer.propose({ runId: run.runId });
    expect(await post(SESSION_TERMINATE_REQUEST_PATH, { runId: run.runId }, token)).toMatchObject({
      status: 409,
      body: { error: "approval-unavailable" },
    });

    proposer.result = { ok: true, proposalId: "proposal-1" };
    expect(await post(SESSION_TERMINATE_REQUEST_PATH, { runId: run.runId }, token)).toMatchObject({
      status: 200,
      body: { outcome: "proposed", proposalId: "proposal-1" },
    });
    expect(proposer.requests).toEqual([{ runId: run.runId }, { runId: run.runId }]);
    // A proposal changes nothing about the Run: no terminate is recorded or sent.
    expect(getSessionRun(store.db, run.runId)?.terminateRequestedAt).toBeNull();
  });

  it("re-validates the Run: unknown is run-not-found, ended is invalid-state, nothing is proposed", async () => {
    const token = await handshake();
    const ended = seedRun({ state: "completed" });
    expect(await post(SESSION_TERMINATE_REQUEST_PATH, { runId: ended.runId }, token)).toMatchObject(
      {
        status: 409,
        body: { error: "invalid-state" },
      },
    );
    expect(await post(SESSION_TERMINATE_REQUEST_PATH, { runId: newRunId() }, token)).toMatchObject({
      status: 404,
      body: { error: "run-not-found" },
    });
    expect(proposer.requests).toEqual([]);
  });

  it("no route can reach the signal executor (source scan)", () => {
    const text = readFileSync(join(import.meta.dirname, "session-action-routes.ts"), "utf8");
    expect(text).toContain("proposer.propose");
    expect(text).not.toMatch(/terminate-executor/);
    expect(text).not.toMatch(/SessionTerminator|createTerminateExecutor/);
    expect(text).not.toMatch(/\.kill\s*\(/);
  });
});

/** A launcher that holds every launch until released, answering `result` then. */
class GatedLauncher implements SessionTerminalLauncher {
  readonly requests: Parameters<SessionTerminalLauncher["launch"]>[0][] = [];
  private readonly waiting: Array<() => void> = [];
  constructor(
    private readonly result: Awaited<ReturnType<SessionTerminalLauncher["launch"]>> = { ok: true },
  ) {}
  launch(request: Parameters<SessionTerminalLauncher["launch"]>[0]) {
    this.requests.push(request);
    return new Promise<Awaited<ReturnType<SessionTerminalLauncher["launch"]>>>((resolve) => {
      this.waiting.push(() => resolve(this.result));
    });
  }
  release(): void {
    for (const go of this.waiting.splice(0)) go();
  }
}

/** Resolves once `predicate` holds, polling the event loop. */
async function until(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(predicate()).toBe(true);
  });
}

describe("wave 5 review: resume/branch guard, pre-registration, timeouts and budget", () => {
  it("runs the guard on an existing worktree choice (conflict), and launches when that tree is clear", async () => {
    const token = await handshake();
    const source = seedRun({ projectId: "alpha", cwd: repo });
    const tree = join(dir, "trees", "busy");
    mkdirSync(join(dir, "trees"));
    testGit(repo, "worktree", "add", "-q", "-b", "busy", tree);
    const listed = WorktreeListResponseSchema.parse(
      (await post(SESSION_WORKTREES_PATH, { runId: source.runId }, token)).body,
    ).worktrees;
    const busy = listed.find((w) => w.branch === "busy");
    const writer = seedRun({
      state: "running",
      permissionMode: "default",
      worktreeRoot: realpathSync(tree),
      name: "Tree writer",
    });

    const res = await post<{ outcome: string; conflicts: Array<{ runId: string }> }>(
      SESSION_RESUME_PATH,
      { runId: source.runId, choice: { kind: "existing-worktree", worktreeId: busy?.worktreeId } },
      token,
    );
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("conflict");
    expect(res.body.conflicts.map((c) => c.runId)).toEqual([writer.runId]);
    expect(fake.requests).toHaveLength(0);
    expect(childrenOf(source.runId)).toHaveLength(0);

    // A writer in the MAIN tree does not block the isolated one.
    store.db.prepare("UPDATE runs SET worktree_root = ? WHERE run_id = ?").run(repo, writer.runId);
    const clear = await post(
      SESSION_RESUME_PATH,
      { runId: source.runId, choice: { kind: "existing-worktree", worktreeId: busy?.worktreeId } },
      token,
    );
    expect(clear.body).toEqual({ outcome: "launched" });
  });

  it("pre-registers the linked Run with its worktree root, so it is a conflict candidate while queued and starting", async () => {
    const token = await handshake();
    const first = seedRun({ projectId: "alpha", cwd: repo });
    const second = seedRun({ projectId: "alpha", cwd: repo });
    const gated = new GatedLauncher();
    launcher = gated;

    const pending = post(SESSION_RESUME_PATH, { runId: first.runId }, token);
    await until(() => gated.requests.length === 1);
    const [queued] = childrenOf(first.runId);
    expect(queued).toMatchObject({ state: "queued", worktreeRoot: repo, permissionMode: null });

    const blocked = await post<{ outcome: string; conflicts: Array<{ runId: string }> }>(
      SESSION_RESUME_PATH,
      { runId: second.runId },
      token,
    );
    expect(blocked.body.outcome).toBe("conflict");
    expect(blocked.body.conflicts.map((c) => c.runId)).toEqual([queued?.runId]);

    gated.release();
    expect((await pending).body).toEqual({ outcome: "launched" });
    expect(getSessionRun(store.db, queued?.runId as RunId)?.state).toBe("starting");
    const again = await post<{ outcome: string; conflicts: Array<{ runId: string }> }>(
      SESSION_RESUME_PATH,
      { runId: second.runId },
      token,
    );
    expect(again.body.conflicts.map((c) => c.runId)).toEqual([queued?.runId]);
  });

  it("a plan-mode pre-registration is not write-capable and a new worktree has no root yet", async () => {
    const token = await handshake();
    const source = seedRun({ projectId: "alpha", cwd: repo });
    await post(SESSION_RESUME_PATH, { runId: source.runId, choice: { kind: "plan" } }, token);
    await post(
      SESSION_RESUME_PATH,
      { runId: source.runId, choice: { kind: "new-worktree", name: "iso" } },
      token,
    );
    const children = childrenOf(source.runId);
    expect(children.map((c) => [c.permissionMode, c.worktreeRoot]).sort()).toEqual(
      [
        ["plan", repo],
        [null, null],
      ].sort(),
    );
    const other = seedRun({ projectId: "alpha", cwd: repo });
    expect((await post(SESSION_RESUME_PATH, { runId: other.runId }, token)).body).toEqual({
      outcome: "launched",
    });
  });

  it("refuses a second launch of the same Run while the first is in flight (server-side lock)", async () => {
    const token = await handshake();
    const source = seedRun({ projectId: "alpha", cwd: repo });
    const gated = new GatedLauncher();
    launcher = gated;
    const body = { runId: source.runId, choice: { kind: "continue" } };
    const pending = post(SESSION_RESUME_PATH, body, token);
    await until(() => gated.requests.length === 1);
    expect(await post(SESSION_BRANCH_PATH, body, token)).toMatchObject({
      status: 409,
      body: { error: "invalid-state" },
    });
    gated.release();
    expect((await pending).body).toEqual({ outcome: "launched" });
    expect(gated.requests).toHaveLength(1);
    // Released: the next one goes through.
    launcher = fake;
    expect((await post(SESSION_RESUME_PATH, body, token)).body).toEqual({ outcome: "launched" });
  });

  it("a launcher timeout leaves the Run stale, never failed; only a definite failure records failed", async () => {
    const token = await handshake();
    fake.result = { ok: false, reason: "timeout" };
    const timedOut = seedRun({ projectId: "alpha", cwd: repo });
    expect(await post(SESSION_RESUME_PATH, { runId: timedOut.runId }, token)).toMatchObject({
      status: 409,
      body: { error: "timeout" },
    });
    const [uncertain] = childrenOf(timedOut.runId);
    expect(uncertain?.state).toBe("stale");
    expect(uncertain?.endedAt).toBeNull();

    // The stale child still guards its tree; `continue` accepts that and launches.
    fake.result = { ok: false, reason: "spawn-failed" };
    const failed = seedRun({ projectId: "alpha", cwd: repo });
    expect(
      await post(SESSION_RESUME_PATH, { runId: failed.runId, choice: { kind: "continue" } }, token),
    ).toMatchObject({ status: 409, body: { error: "spawn-failed" } });
    expect(childrenOf(failed.runId)[0]?.state).toBe("failed");
  });

  it("one deadline covers the whole flow: a slow guard plus a slow launch answers timeout, the Run stale", async () => {
    const token = await handshake();
    launchBudgetMs = 400;
    guardDelayMs = 200;
    const gated = new GatedLauncher();
    launcher = gated;
    const source = seedRun({ projectId: "alpha", cwd: repo });
    const started = Date.now();
    const res = await post(SESSION_RESUME_PATH, { runId: source.runId }, token);
    expect(res).toMatchObject({ status: 409, body: { error: "timeout" } });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(gated.requests).toHaveLength(1);
    expect(childrenOf(source.runId)[0]?.state).toBe("stale");
    gated.release();

    // A guard slower than the whole budget: nothing is registered or launched.
    // (The stale child is ended first, so the late guard would answer clear.)
    store.db
      .prepare("UPDATE runs SET state = 'completed', ended_at = ? WHERE linked_from_run_id = ?")
      .run(new Date().toISOString(), source.runId);
    guardDelayMs = 600;
    const late = seedRun({ projectId: "alpha", cwd: join(repo, "src") });
    const other = new GatedLauncher();
    launcher = other;
    expect(await post(SESSION_RESUME_PATH, { runId: late.runId }, token)).toMatchObject({
      status: 409,
      body: { error: "timeout" },
    });
    // Nor later, once the slow guard finally answers after the deadline.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(childrenOf(late.runId)).toHaveLength(0);
    expect(other.requests).toHaveLength(0);
  });

  it("open-transcript refuses anything but a .jsonl, including a .jsonl symlink to another file type", async () => {
    const token = await handshake();
    const folder = join(dir, "claude", "projects", "-code-alpha");
    mkdirSync(folder, { recursive: true });
    const script = join(folder, "run-me.command");
    writeFileSync(script, "#!/bin/sh\n");
    const direct = seedRun({ transcriptPath: script });
    const link = join(folder, `${randomUUID()}.jsonl`);
    symlinkSync(script, link);
    const linked = seedRun({ transcriptPath: link });
    for (const run of [direct, linked]) {
      for (const mode of ["open", "reveal"] as const) {
        expect(
          await post(SESSION_OPEN_TRANSCRIPT_PATH, { runId: run.runId, mode }, token),
        ).toMatchObject({ status: 409, body: { error: "transcript-outside-root" } });
      }
    }
    expect(openCalls).toEqual([]);
  });
});
