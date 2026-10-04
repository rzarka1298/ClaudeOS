import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_PROJECTS_SNAPSHOT,
  HANDSHAKE_PATH,
  type HandshakeResponse,
  newRunId,
  type ProjectsSnapshot,
  SNAPSHOT_PATH,
  SnapshotResponseSchema,
} from "@ccc/domain";
import { applyMigrations, type OperationalStore, openStore } from "@ccc/operational-store";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
  const base = `${process.env.HOME}/.ccc-test/sm-${process.pid}`;
  process.env.CCC_RUNTIME_DIR = base;
  process.env.CLAUDE_CONFIG_DIR = `${base}/claude`;
  return { base };
});

import { createClaudePipeline, type SessionFactsProvider } from "./claude/pipeline.js";
import { startUsageServices, type UsageServices } from "./claude/usage-services.js";
import { createEventBus } from "./events/event-bus.js";
import { createLogger } from "./logging.js";
import type { ProjectServices } from "./projects/project-routes.js";
import { createRequestListener } from "./routes.js";
import { startSocketServer } from "./socket-server.js";

/**
 * Audit (05-16 merge reconcile, area 3): after the Phase 4 / Phase 5 merge the
 * one snapshot route must answer Phase 4's `projects` AND Phase 5's
 * `sessions`/`usage`/`claudeIntegration` when both contexts are present, and
 * must not invent Phase 5 fields when the Claude context is absent.
 */

const NULL_FACTS: SessionFactsProvider = {
  factsFor: async () => ({
    pidStartedAt: null,
    launchSource: null,
    projectId: null,
    worktreeRoot: null,
    transcriptPath: null,
  }),
};

const PROJECTS: ProjectsSnapshot = {
  ...EMPTY_PROJECTS_SNAPSHOT,
  projects: [
    {
      projectId: "0000000000123456789abcdef" as never,
      displayName: "merge-audit-project",
      displayPath: "~/code/merge-audit-project",
      pinned: false,
      lastOpenedAt: null,
      observedAt: null,
      gitReadFailed: false,
      git: { kind: "pending" },
      github: { kind: "none" },
    },
  ],
};

function call(socketPath: string, path: string, token?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method: path === HANDSHAKE_PATH ? "POST" : "GET",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let dir: string;
let store: OperationalStore;
let server: Server;
let usage: UsageServices;
let socketPath: string;

async function boot(withProjects: boolean, withClaude: boolean): Promise<string> {
  const bus = createEventBus();
  const logger = createLogger(join(dir, "logs", "service.log"));
  const pipeline = createClaudePipeline({
    db: store.db,
    bus,
    logger,
    now: () => new Date(),
    mintRunId: newRunId,
    facts: NULL_FACTS,
  });
  usage = startUsageServices({
    db: store.db,
    bus,
    pipeline,
    poller: { setStatusLineSink() {}, dropCount: () => 0 },
    logger,
    env: {},
    now: () => new Date(),
    settingsFacts: () => ({ statusLine: "installed", cleanupPeriodDays: 30 }),
  });
  const secret = randomBytes(32);
  server = await startSocketServer({
    socketPath,
    requestListener: createRequestListener({
      store,
      getSecret: () => secret,
      eventBus: bus,
      ...(withProjects
        ? { projects: { snapshot: () => PROJECTS } as unknown as ProjectServices }
        : {}),
      ...(withClaude ? { claude: { pipeline, usage } } : {}),
    }),
  });
  const hs = (await call(socketPath, HANDSHAKE_PATH)) as HandshakeResponse;
  return hs.token;
}

beforeEach(() => {
  mkdirSync(join(homedir(), ".ccc-test"), { recursive: true });
  dir = mkdtempSync(join(homedir(), ".ccc-test", "sm-"));
  socketPath = join(dir, "t.sock");
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
});

afterEach(async () => {
  server.close();
  await usage.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => rmSync(env.base, { recursive: true, force: true }));

describe("GET snapshot after the Phase 4 + Phase 5 merge", () => {
  it("returns projects AND sessions, usage and claudeIntegration when both contexts are present", async () => {
    const token = await boot(true, true);
    const snap = SnapshotResponseSchema.parse(await call(socketPath, SNAPSHOT_PATH, token));
    expect(snap.state.projects.projects.map((p) => p.displayName)).toEqual(["merge-audit-project"]);
    expect(snap.state.sessions).toEqual([]);
    expect(snap.state.usage).toBeDefined();
    expect(snap.state.claudeIntegration).toBeDefined();
  });

  it("omits Phase 5 fields, never inventing them, when the Claude context is absent", async () => {
    const token = await boot(true, false);
    const snap = SnapshotResponseSchema.parse(await call(socketPath, SNAPSHOT_PATH, token));
    expect(snap.state.projects.projects).toHaveLength(1);
    expect(snap.state.sessions).toBeUndefined();
    expect(snap.state.usage).toBeUndefined();
    expect(snap.state.claudeIntegration).toBeUndefined();
  });

  it("returns Phase 5 fields beside the empty projects state when only the Claude context is present", async () => {
    const token = await boot(false, true);
    const snap = SnapshotResponseSchema.parse(await call(socketPath, SNAPSHOT_PATH, token));
    expect(snap.state.projects).toEqual(EMPTY_PROJECTS_SNAPSHOT);
    expect(snap.state.sessions).toEqual([]);
    expect(snap.state.usage).toBeDefined();
  });
});
