/**
 * Wave-5 audit (05-14): adversarial inputs to the session-action routes.
 * Hostile stored session ids and worktree names must never reach a launch
 * argv, and a stored transcript path must not escape the projects root
 * through a symlink or a `..` segment.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import http, { type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  HANDSHAKE_PATH,
  type HandshakeResponse,
  newRunId,
  SESSION_BRANCH_PATH,
  SESSION_OPEN_TRANSCRIPT_PATH,
  SESSION_RESUME_PATH,
  SESSION_TERMINATE_REQUEST_PATH,
  type SessionRun,
} from "@ccc/domain";
import {
  applyMigrations,
  type OperationalStore,
  openStore,
  upsertSessionRun,
} from "@ccc/operational-store";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
  const base = `${process.env.HOME}/.ccc-test/saa-${process.pid}`;
  process.env.CCC_RUNTIME_DIR = base;
  process.env.CLAUDE_CONFIG_DIR = `${base}/claude`;
  return { base };
});

import { createEventBus } from "../events/event-bus.js";
import { createLogger } from "../logging.js";
import { createRequestListener } from "../routes.js";
import { startSocketServer } from "../socket-server.js";
import {
  FakeProposeForceTerminate,
  FakeSessionTerminalLauncher,
} from "../test-support/fake-ports.js";
import { runGit } from "./git-readonly.js";
import { createLaunchGuard, listWorktrees } from "./launch-guard.js";
import { type ClaudePipeline, createClaudePipeline } from "./pipeline.js";
import { createStoreProjectLookup } from "./project-lookup.js";

const TEST_BASE = join(homedir(), ".ccc-test");
const CLAUDE_BIN = "/opt/claude-test/bin/claude";

let dir: string;
let socketPath: string;
let store: OperationalStore;
let server: Server;
let pipeline: ClaudePipeline;
let fake: FakeSessionTerminalLauncher;
let proposer: FakeProposeForceTerminate;
let openCalls: string[][];
let repo: string;

function request<T>(
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: (raw ? JSON.parse(raw) : undefined) as T });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function handshake(): Promise<string> {
  const res = await request<HandshakeResponse>(HANDSHAKE_PATH, undefined);
  return res.body.token;
}

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
    projectId: "alpha",
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

beforeEach(async () => {
  mkdirSync(TEST_BASE, { recursive: true });
  dir = realpathSync(mkdtempSync(join(TEST_BASE, "saa-")));
  socketPath = join(dir, "t.sock");
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
  const bus = createEventBus();
  const logger = createLogger(join(dir, "logs", "service.log"));
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
      deferredFactsFor: () => null,
    },
  });
  fake = new FakeSessionTerminalLauncher();
  proposer = new FakeProposeForceTerminate();
  openCalls = [];
  repo = join(dir, "code", "alpha");
  mkdirSync(repo, { recursive: true });
  testGit(repo, "init", "-q", "-b", "main");
  testGit(repo, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
  store.db
    .prepare(
      "INSERT INTO projects (project_id, path, workspace_id, display_name, registered_at) VALUES (?, ?, NULL, ?, ?)",
    )
    .run("alpha", repo, "Alpha", "2026-09-29T00:00:00.000Z");
  server = await startSocketServer({
    socketPath,
    requestListener: createRequestListener({
      store,
      getSecret: (() => {
        const secret = randomBytes(32);
        return () => secret;
      })(),
      eventBus: bus,
      claude: {
        pipeline,
        actions: {
          db: store.db,
          launcher: { launch: (req) => fake.launch(req) },
          guard: createLaunchGuard({ db: store.db, runGit, realpath }),
          lookup: createStoreProjectLookup(store.db),
          listWorktrees: (root) => listWorktrees(root, { runGit, realpath }),
          focus: { focus: async () => ({ ok: true, response: { outcome: "focused" } }) },
          proposer: { propose: (req) => proposer.propose(req) },
          claudeBin: () => CLAUDE_BIN,
          claudeProjectsRoot: join(dir, "claude", "projects"),
          openFile: async (args) => {
            openCalls.push([...args]);
          },
          now: () => new Date(),
          mintRunId: newRunId,
        },
      },
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

describe("audit 05-14: hostile stored session ids never reach the argv", () => {
  for (const hostile of ["--dangerously-skip-permissions", "-p", "a b", "x;rm -rf ~", "$(id)"]) {
    it(`refuses resume and branch for a stored session id ${JSON.stringify(hostile)}`, async () => {
      const token = await handshake();
      const run = seedRun({ claudeSessionId: hostile });
      const resume = await request<{ error?: string }>(
        SESSION_RESUME_PATH,
        { runId: run.runId },
        token,
      );
      const branch = await request<{ error?: string }>(
        SESSION_BRANCH_PATH,
        { runId: run.runId },
        token,
      );
      expect(resume.status).toBeGreaterThanOrEqual(400);
      expect(branch.status).toBeGreaterThanOrEqual(400);
      expect(fake.requests).toHaveLength(0);
      expect(JSON.stringify([resume.body, branch.body])).not.toContain(hostile);
    });
  }
});

describe("audit 05-14: hostile new-worktree names never reach the argv", () => {
  for (const name of ["-rf", "--dangerously-skip-permissions", ".", "..", "../x", "a/b", ""]) {
    it(`refuses the new-worktree name ${JSON.stringify(name)} and launches nothing`, async () => {
      const token = await handshake();
      const run = seedRun({});
      const res = await request<{ error?: string }>(
        SESSION_RESUME_PATH,
        { runId: run.runId, choice: { kind: "new-worktree", name } },
        token,
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(fake.requests).toHaveLength(0);
    });
  }
});

describe("audit 05-14: transcript containment", () => {
  it("refuses a stored path that escapes the projects root through a symlinked file", async () => {
    const token = await handshake();
    const outside = join(dir, "secret.jsonl");
    writeFileSync(outside, "{}\n");
    const folder = join(dir, "claude", "projects", "-code-alpha");
    mkdirSync(folder, { recursive: true });
    const link = join(folder, `${randomUUID()}.jsonl`);
    symlinkSync(outside, link);
    const run = seedRun({ transcriptPath: link });
    const res = await request(
      SESSION_OPEN_TRANSCRIPT_PATH,
      { runId: run.runId, mode: "open" },
      token,
    );
    expect(res.status).toBe(409);
    expect(openCalls).toEqual([]);
  });

  it("refuses a stored path that escapes the projects root through a symlinked folder", async () => {
    const token = await handshake();
    const outsideDir = join(dir, "elsewhere");
    mkdirSync(outsideDir);
    const id = randomUUID();
    writeFileSync(join(outsideDir, `${id}.jsonl`), "{}\n");
    mkdirSync(join(dir, "claude", "projects"), { recursive: true });
    symlinkSync(outsideDir, join(dir, "claude", "projects", "-evil"));
    const run = seedRun({
      transcriptPath: join(dir, "claude", "projects", "-evil", `${id}.jsonl`),
    });
    const res = await request(
      SESSION_OPEN_TRANSCRIPT_PATH,
      { runId: run.runId, mode: "reveal" },
      token,
    );
    expect(res.status).toBe(409);
    expect(openCalls).toEqual([]);
  });

  it("refuses a stored path with a `..` segment climbing out of the root", async () => {
    const token = await handshake();
    const outside = join(dir, "secret.jsonl");
    writeFileSync(outside, "{}\n");
    const run = seedRun({
      transcriptPath: `${join(dir, "claude", "projects", "-code-alpha")}/../../../secret.jsonl`,
    });
    mkdirSync(join(dir, "claude", "projects", "-code-alpha"), { recursive: true });
    const res = await request(
      SESSION_OPEN_TRANSCRIPT_PATH,
      { runId: run.runId, mode: "open" },
      token,
    );
    expect(res.status).toBe(409);
    expect(openCalls).toEqual([]);
  });
});

describe("audit 05-14: terminate-request never records or proposes for a non-live Run", () => {
  it("a Run with no pid is invalid-state and nothing is proposed", async () => {
    const token = await handshake();
    const run = seedRun({ state: "running", pid: null, endedAt: null });
    const res = await request(SESSION_TERMINATE_REQUEST_PATH, { runId: run.runId }, token);
    expect(res).toMatchObject({ status: 409, body: { error: "invalid-state" } });
    expect(proposer.requests).toEqual([]);
  });

  it("an unauthenticated terminate-request is refused before any proposal", async () => {
    const run = seedRun({ state: "running", pid: 4242, endedAt: null });
    const res = await request(SESSION_TERMINATE_REQUEST_PATH, { runId: run.runId });
    expect(res.status).toBe(401);
    expect(proposer.requests).toEqual([]);
  });
});
