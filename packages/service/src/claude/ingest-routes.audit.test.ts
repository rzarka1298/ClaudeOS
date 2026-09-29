// Wave-3 audit (05-08): HTTP-level shape degradation, eventId idempotency over
// the socket, and the 500-event default buffer (PR-05). Setup mirrors
// ingest-routes.test.ts.
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
} from "@ccc/domain";
import { applyMigrations, type OperationalStore, openStore } from "@ccc/operational-store";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `routes.ts` imports the logger singleton, which opens its log file at
// import time: point the runtime dir (and the Claude config dir) at a short
// test path BEFORE any import resolves (PATTERNS "Temp dirs").
const env = vi.hoisted(() => {
  const base = `${process.env.HOME}/.ccc-test/ira-${process.pid}`;
  process.env.CCC_RUNTIME_DIR = base;
  process.env.CLAUDE_CONFIG_DIR = `${base}/claude`;
  return { base };
});

import { createEventBus, type EventBus } from "../events/event-bus.js";
import { createRingBuffer } from "../events/ring-buffer.js";
import { createLogger } from "../logging.js";
import { createRequestListener } from "../routes.js";
import { startSocketServer } from "../socket-server.js";
import {
  type ClaudePipeline,
  createClaudePipeline,
  type SessionFactsProvider,
} from "./pipeline.js";

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
let pipelineRef: ClaudePipeline;

beforeEach(async () => {
  mkdirSync(TEST_BASE, { recursive: true });
  dir = mkdtempSync(join(TEST_BASE, "ira-"));
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
  pipelineRef = pipeline;
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

describe("05-08 audit: POST /api/v1/claude/hook-events", () => {
  it("answers the constant 400 body for a known event whose shape changed, applies nothing, and flags health", async () => {
    const token = await handshake(socketPath);
    // SessionStart without its required `source`: a known event, wrong shape.
    const res = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_HOOK_EVENTS_PATH,
      rawBody: JSON.stringify(hookRecord("SessionStart")),
      token,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid request body" });
    expect(lastEvent(bus)).toBeUndefined();
    expect(pipelineRef.health().shapeChanged).toBe("SessionStart");
  });

  it("treats a second POST of the same eventId as a no-op", async () => {
    const token = await handshake(socketPath);
    const rec = hookRecord("SessionStart", { source: "startup" });
    const first = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_HOOK_EVENTS_PATH,
      rawBody: JSON.stringify(rec),
      token,
    });
    const idAfterFirst = bus.buffer.latestId();
    const second = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_HOOK_EVENTS_PATH,
      rawBody: JSON.stringify(rec),
      token,
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(idAfterFirst).toBeGreaterThan(0);
    expect(bus.buffer.latestId()).toBe(idAfterFirst);
    expect(pipelineRef.listSessionViews()).toHaveLength(1);
  });
});

describe("05-08 audit: event buffer depth (PR-05)", () => {
  it.skipIf(process.env.CCC_EVENT_BUFFER_CAPACITY !== undefined)(
    "retains exactly 500 events by default",
    () => {
      const buffer = createRingBuffer();
      for (let i = 0; i < 500; i++) buffer.push("session.upserted", new Date(0).toISOString(), {});
      expect(buffer.has(1)).toBe(true);
      buffer.push("session.upserted", new Date(0).toISOString(), {});
      expect(buffer.has(1)).toBe(false);
      expect(buffer.has(2)).toBe(true);
    },
  );
});
