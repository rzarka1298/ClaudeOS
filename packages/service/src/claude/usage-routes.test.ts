import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_STATUSLINE_PATH,
  HANDSHAKE_PATH,
  type HandshakeResponse,
  newRunId,
  PlanCapacitySchema,
  SNAPSHOT_PATH,
  SnapshotResponseSchema,
  UsageSummarySchema,
} from "@ccc/domain";
import {
  applyMigrations,
  latestCapacity,
  listCostSnapshots,
  type OperationalStore,
  openStore,
} from "@ccc/operational-store";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `routes.ts` imports the logger singleton, which opens its log file at
// import time: point the runtime dir (and the Claude config dir) at a short
// test path BEFORE any import resolves (PATTERNS "Temp dirs").
const env = vi.hoisted(() => {
  const base = `${process.env.HOME}/.ccc-test/ur-${process.pid}`;
  process.env.CCC_RUNTIME_DIR = base;
  process.env.CLAUDE_CONFIG_DIR = `${base}/claude`;
  return { base };
});

import { createEventBus, type EventBus } from "../events/event-bus.js";
import { createLogger } from "../logging.js";
import { createRequestListener } from "../routes.js";
import { startSocketServer } from "../socket-server.js";
import { createClaudePipeline, type SessionFactsProvider } from "./pipeline.js";
import { startUsageServices, type UsageServices } from "./usage-services.js";
import { buildPlanCapacity, EMPTY_STATUS_LINE_OBSERVATION } from "./usage-summary.js";

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

async function handshake(socketPath: string): Promise<string> {
  const res = await request<HandshakeResponse>(socketPath, {
    method: "POST",
    path: HANDSHAKE_PATH,
  });
  expect(res.status).toBe(200);
  return res.body.token;
}

function lastEvent(bus: EventBus) {
  const replay = bus.buffer.since(0);
  if (replay.mode !== "replay") throw new Error("expected a replay");
  return replay.events.at(-1);
}

/** A synthetic status-line snapshot, as the wrapper forwards it (PR-14). */
function statusLine(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: randomUUID(),
    observedAt: new Date().toISOString(),
    session_id: "sess-usage-1",
    model_id: "claude-opus-4-8",
    version: "2.1.283",
    ...extra,
  };
}

/** A reset five hours out, in epoch SECONDS (the status line's numeric form). */
const FIVE_HOUR_RESET_EPOCH_S = Math.floor(Date.now() / 1000) + 5 * 3600;
const SEVEN_DAY_RESET_ISO = new Date(Date.now() + 6 * 86_400_000).toISOString();

const RATE_LIMITS = {
  five_hour: { used_percentage: 62, resets_at: FIVE_HOUR_RESET_EPOCH_S },
  seven_day: { used_percentage: 18, resets_at: SEVEN_DAY_RESET_ISO },
};

let dir: string;
let socketPath: string;
let store: OperationalStore;
let bus: EventBus;
let server: Server;
let usage: UsageServices;
let spooledSink: ((snapshot: unknown) => void) | undefined;

beforeEach(async () => {
  mkdirSync(TEST_BASE, { recursive: true });
  dir = mkdtempSync(join(TEST_BASE, "ur-"));
  socketPath = join(dir, "t.sock");
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
  bus = createEventBus();
  const logger = createLogger(join(dir, "logs", "service.log"));
  const pipeline = createClaudePipeline({
    db: store.db,
    bus,
    logger,
    now: () => new Date(),
    mintRunId: newRunId,
    facts: NULL_FACTS,
  });
  spooledSink = undefined;
  usage = startUsageServices({
    db: store.db,
    bus,
    pipeline,
    poller: {
      setStatusLineSink(sink) {
        spooledSink = sink;
      },
      dropCount: () => 0,
    },
    logger,
    env: {},
    now: () => new Date(),
    settingsFacts: () => ({ statusLine: "installed", cleanupPeriodDays: 30 }),
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
      claude: { pipeline, usage },
    }),
  });
});

afterEach(async () => {
  server.close();
  await usage.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(env.base, { recursive: true, force: true });
});

describe("POST /api/v1/claude/statusline (Task 1 tracer, D-02, D-42, D-43)", () => {
  it("turns a snapshot into plan capacity, a session cost and a usage.updated summary (Test 1)", async () => {
    const token = await handshake(socketPath);
    const res = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_STATUSLINE_PATH,
      rawBody: JSON.stringify(statusLine({ rate_limits: RATE_LIMITS, cost_total_usd: 3.5 })),
      token,
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });

    const windows = latestCapacity(store.db);
    expect(windows.map((w) => [w.window, w.usedPercent])).toEqual([
      ["five-hour", 62],
      ["seven-day", 18],
    ]);
    // A numeric resets_at is epoch seconds, normalized to ISO.
    expect(windows[0]?.resetsAt).toBe(new Date(FIVE_HOUR_RESET_EPOCH_S * 1000).toISOString());
    expect(listCostSnapshots(store.db)).toMatchObject([
      { claudeSessionId: "sess-usage-1", totalCostUsd: 3.5 },
    ]);

    const event = lastEvent(bus);
    expect(event?.type).toBe("usage.updated");
    const summary = UsageSummarySchema.parse(event?.payload);
    expect(summary.capacity.kind).toBe("available");
    if (summary.capacity.kind !== "available") throw new Error("unreachable");
    expect(summary.capacity.windows.map((w) => [w.window, w.usedPercent])).toEqual([
      ["five-hour", 62],
      ["seven-day", 18],
    ]);
    expect(summary.capacity.freshness).toBe("live");
    expect(summary.capacity.source).toBe("claude-code-status-line");
  });

  it("keeps the latest cost per session, never summed, over the socket and from the spool (Test 2)", async () => {
    const token = await handshake(socketPath);
    for (const cost of [3.5, 4.1]) {
      const res = await request<unknown>(socketPath, {
        method: "POST",
        path: CLAUDE_STATUSLINE_PATH,
        rawBody: JSON.stringify(statusLine({ rate_limits: RATE_LIMITS, cost_total_usd: cost })),
        token,
      });
      expect(res.status).toBe(202);
    }
    expect(listCostSnapshots(store.db)).toMatchObject([
      { claudeSessionId: "sess-usage-1", totalCostUsd: 4.1 },
    ]);
    const summary = UsageSummarySchema.parse(lastEvent(bus)?.payload);
    const today = summary.ranges.today.cost;
    expect(today.kind).toBe("available");
    if (today.kind !== "available") throw new Error("unreachable");
    expect(today.usd).toBe(4.1);
    expect(today.basis).toBe("claude-code-estimates");

    // The spool poller hands a spooled latest-only snapshot to the same sink.
    expect(spooledSink).toBeDefined();
    spooledSink?.(statusLine({ session_id: "sess-usage-2", cost_total_usd: 1.25 }));
    expect(listCostSnapshots(store.db)).toMatchObject([
      { claudeSessionId: "sess-usage-1", totalCostUsd: 4.1 },
      { claudeSessionId: "sess-usage-2", totalCostUsd: 1.25 },
    ]);
    const afterSpool = UsageSummarySchema.parse(lastEvent(bus)?.payload);
    const spooledToday = afterSpool.ranges.today.cost;
    if (spooledToday.kind !== "available") throw new Error("expected an available cost");
    expect(spooledToday.usd).toBeCloseTo(5.35, 10);
  });

  it("reports GET snapshot state.usage as a valid UsageSummary (Test 4)", async () => {
    const token = await handshake(socketPath);
    const res = await request<unknown>(socketPath, { method: "GET", path: SNAPSHOT_PATH, token });
    expect(res.status).toBe(200);
    const snapshot = SnapshotResponseSchema.parse(res.body);
    expect(snapshot.state.usage).toBeDefined();
    const usageState = UsageSummarySchema.parse(snapshot.state.usage);
    expect(usageState.capacity).toEqual({
      kind: "unavailable",
      reason: "no-report-yet",
      version: null,
    });
    expect(usageState.analysis).toEqual({ enabled: false, firstScanPending: false });
  });

  it("refuses without a token (401) and answers an invalid snapshot with the constant 400, storing nothing (Test 5)", async () => {
    const unauth = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_STATUSLINE_PATH,
      rawBody: JSON.stringify(statusLine({ rate_limits: RATE_LIMITS })),
    });
    expect(unauth.status).toBe(401);
    expect(unauth.body).toEqual({ error: "authentication required" });

    const token = await handshake(socketPath);
    const invalid = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_STATUSLINE_PATH,
      rawBody: JSON.stringify(
        statusLine({
          session_id: "not/an identifier",
          rate_limits: RATE_LIMITS,
          cost_total_usd: 9,
        }),
      ),
      token,
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: "invalid request body" });
    const notJson = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_STATUSLINE_PATH,
      rawBody: "{not json",
      token,
    });
    expect(notJson.status).toBe(400);
    expect(notJson.body).toEqual({ error: "invalid request body" });
    expect(latestCapacity(store.db)).toEqual([]);
    expect(listCostSnapshots(store.db)).toEqual([]);
  });
});

describe("buildPlanCapacity: unavailable is never a number (Test 3, D-38, USAGE-06)", () => {
  const hasNumber = (value: unknown): boolean =>
    typeof value === "number" ||
    (typeof value === "object" && value !== null && Object.values(value).some(hasNumber));

  it("reads wrapper-not-installed before any report when the wrapper is not installed", () => {
    const capacity = buildPlanCapacity({
      db: store.db,
      statusLineInstall: "not-installed",
      observation: EMPTY_STATUS_LINE_OBSERVATION,
      now: new Date(),
    });
    expect(PlanCapacitySchema.parse(capacity)).toEqual({
      kind: "unavailable",
      reason: "wrapper-not-installed",
      version: null,
    });
    expect(hasNumber(capacity)).toBe(false);
  });

  it("reads no-report-yet when the wrapper is installed but has not reported", () => {
    const capacity = buildPlanCapacity({
      db: store.db,
      statusLineInstall: "installed",
      observation: EMPTY_STATUS_LINE_OBSERVATION,
      now: new Date(),
    });
    expect(capacity).toEqual({ kind: "unavailable", reason: "no-report-yet", version: null });
    expect(hasNumber(capacity)).toBe(false);
  });

  it("reads sign-in-no-limits after a snapshot without rate_limits", () => {
    const result = usage.handleStatusLine(statusLine({ cost_total_usd: 0.5 }));
    expect(result).toBe("applied");
    const summary = usage.summary();
    expect(summary.capacity).toEqual({
      kind: "unavailable",
      reason: "sign-in-no-limits",
      version: null,
    });
    expect(hasNumber(summary.capacity)).toBe(false);
    expect(latestCapacity(store.db)).toEqual([]);
  });
});
