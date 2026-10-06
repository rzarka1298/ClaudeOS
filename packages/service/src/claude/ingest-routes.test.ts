import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_HOOK_EVENTS_PATH,
  HANDSHAKE_PATH,
  type HandshakeResponse,
  newRunId,
  type RunId,
  SessionUpsertedPayloadSchema,
  SNAPSHOT_PATH,
  SnapshotResponseSchema,
} from "@ccc/domain";
import {
  applyMigrations,
  getSessionRun,
  type OperationalStore,
  openStore,
} from "@ccc/operational-store";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `routes.ts` imports the logger singleton, which opens its log file at
// import time: point the runtime dir (and the Claude config dir) at a short
// test path BEFORE any import resolves (PATTERNS "Temp dirs").
const env = vi.hoisted(() => {
  const base = `${process.env.HOME}/.ccc-test/ir-${process.pid}`;
  process.env.CCC_RUNTIME_DIR = base;
  process.env.CLAUDE_CONFIG_DIR = `${base}/claude`;
  return { base };
});

import { createEventBus, type EventBus } from "../events/event-bus.js";
import { createLogger } from "../logging.js";
import { createRequestListener } from "../routes.js";
import { startSocketServer } from "../socket-server.js";
import { createClaudePipeline, type SessionFactsProvider } from "./pipeline.js";

const TEST_BASE = join(homedir(), ".ccc-test");

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

/** Raw `node:http` over the socket, with a body (the vault-setup-routes.test.ts helper). */
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

async function handshake(socketPath: string): Promise<string> {
  const res = await request<HandshakeResponse>(socketPath, {
    method: "POST",
    path: HANDSHAKE_PATH,
  });
  expect(res.status).toBe(200);
  return res.body.token;
}

function hookRecord(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: randomUUID(),
    observedAt: new Date().toISOString(),
    hook_event_name: event,
    session_id: "sess-ingest-1",
    cwd: join(dir, "code", "demo"),
    env: { CLAUDE_PID: "4242" },
    ...extra,
  };
}

function lastEvent(bus: EventBus) {
  const replay = bus.buffer.since(0);
  if (replay.mode !== "replay") throw new Error("expected a replay");
  return replay.events.at(-1);
}

let dir: string;
let socketPath: string;
let store: OperationalStore;
let bus: EventBus;
let server: Server;

beforeEach(async () => {
  mkdirSync(TEST_BASE, { recursive: true });
  dir = mkdtempSync(join(TEST_BASE, "ir-"));
  socketPath = join(dir, "t.sock");
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
  bus = createEventBus();
  const pipeline = createClaudePipeline({
    db: store.db,
    bus,
    logger: createLogger(join(dir, "logs", "service.log")),
    now: () => new Date(),
    mintRunId: newRunId,
    facts: NULL_FACTS,
  });
  server = await startSocketServer({
    socketPath,
    requestListener: createRequestListener({
      store,
      getSecret: (() => {
        const secret = randomBytes(32);
        return () => secret;
      })(),
      eventBus: bus,
      claude: { pipeline },
    }),
  });
});

afterEach(() => {
  server.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(env.base, { recursive: true, force: true });
});

describe("POST /api/v1/claude/hook-events", () => {
  it("turns an authenticated SessionStart into a running Run and a session.upserted event (Test 1)", async () => {
    const token = await handshake(socketPath);
    const res = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_HOOK_EVENTS_PATH,
      rawBody: JSON.stringify(hookRecord("SessionStart", { source: "startup" })),
      token,
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });

    const event = lastEvent(bus);
    expect(event?.type).toBe("session.upserted");
    const payload = SessionUpsertedPayloadSchema.parse(event?.payload);
    expect(payload.session.revision).toBe(1);
    expect(payload.session.state).toBe("running");

    const run = getSessionRun(store.db, payload.session.runId as RunId);
    expect(run).toMatchObject({
      state: "running",
      pid: 4242,
      claudeSessionId: "sess-ingest-1",
      revision: 1,
    });
  });

  it("refuses the same POST without a token with the shared 401 body (Test 2)", async () => {
    const res = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_HOOK_EVENTS_PATH,
      rawBody: JSON.stringify(hookRecord("SessionStart", { source: "startup" })),
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "authentication required" });
    expect(lastEvent(bus)).toBeUndefined();
  });

  it("serves the Run's view in the snapshot, with no private path in it (Test 3)", async () => {
    const token = await handshake(socketPath);
    await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_HOOK_EVENTS_PATH,
      rawBody: JSON.stringify(hookRecord("SessionStart", { source: "startup" })),
      token,
    });
    const res = await request<unknown>(socketPath, { method: "GET", path: SNAPSHOT_PATH, token });
    expect(res.status).toBe(200);
    const snapshot = SnapshotResponseSchema.parse(res.body);
    expect(snapshot.lastEventId).toBe(bus.buffer.latestId());
    expect(snapshot.state.sessions).toHaveLength(1);
    const view = snapshot.state.sessions?.[0];
    expect(view).toMatchObject({ claudeSessionId: "sess-ingest-1", cwdBasename: "demo" });
    expect(JSON.stringify(view)).not.toContain("/Users/");
  });

  it("completes the Run on SessionEnd and publishes revision 2 (Test 4)", async () => {
    const token = await handshake(socketPath);
    await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_HOOK_EVENTS_PATH,
      rawBody: JSON.stringify(hookRecord("SessionStart", { source: "startup" })),
      token,
    });
    const res = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_HOOK_EVENTS_PATH,
      rawBody: JSON.stringify(hookRecord("SessionEnd", { reason: "prompt_input_exit" })),
      token,
    });
    expect(res.status).toBe(202);
    const payload = SessionUpsertedPayloadSchema.parse(lastEvent(bus)?.payload);
    expect(payload.session.state).toBe("completed");
    expect(payload.session.revision).toBe(2);
    expect(getSessionRun(store.db, payload.session.runId as RunId)?.state).toBe("completed");
  });

  it("answers the constant 503 body when the composition carries no Claude pipeline (Test 5)", async () => {
    const bare = join(dir, "b.sock");
    const secret = randomBytes(32);
    const bareServer = await startSocketServer({
      socketPath: bare,
      requestListener: createRequestListener({
        store,
        getSecret: () => secret,
        eventBus: createEventBus(),
      }),
    });
    try {
      const token = await handshake(bare);
      const res = await request<unknown>(bare, {
        method: "POST",
        path: CLAUDE_HOOK_EVENTS_PATH,
        rawBody: JSON.stringify(hookRecord("SessionStart", { source: "startup" })),
        token,
      });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "claude ingest unavailable" });
      const snapshot = await request<{ state: Record<string, unknown> }>(bare, {
        method: "GET",
        path: SNAPSHOT_PATH,
        token,
      });
      expect(snapshot.body.state).not.toHaveProperty("sessions");
    } finally {
      bareServer.close();
    }
  });

  it("answers the constant 400 body for a record whose envelope is invalid", async () => {
    const token = await handshake(socketPath);
    const res = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_HOOK_EVENTS_PATH,
      rawBody: JSON.stringify({ hook_event_name: "SessionStart" }),
      token,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid request body" });
  });

  it("answers 202 for an unknown event and publishes nothing", async () => {
    const token = await handshake(socketPath);
    const res = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_HOOK_EVENTS_PATH,
      rawBody: JSON.stringify(hookRecord("SomeFutureEvent")),
      token,
    });
    expect(res.status).toBe(202);
    expect(lastEvent(bus)).toBeUndefined();
  });

  it("binds no TCP port: the ingest travels only over the Unix socket (SESS-02)", () => {
    const address = server.address();
    expect(typeof address).toBe("string");
    expect(address).toBe(socketPath);
  });
});
