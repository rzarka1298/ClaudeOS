import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_HOOK_EVENTS_PATH,
  CLAUDE_INTEGRATION_PATH,
  CLAUDE_SESSION_USAGE_PATH,
  CLAUDE_STATUSLINE_PATH,
  CLAUDE_TRANSCRIPT_ANALYSIS_PATH,
  CLAUDE_USAGE_DELETE_PATH,
  ClaudeIntegrationStatusSchema,
  HANDSHAKE_PATH,
  type HandshakeResponse,
  newRunId,
  PlanCapacitySchema,
  SessionUsageSchema,
  SNAPSHOT_PATH,
  SnapshotResponseSchema,
  UsageSummarySchema,
} from "@ccc/domain";
import {
  applyMigrations,
  getCollectorSetting,
  latestCapacity,
  latestRunBySession,
  listCostSnapshots,
  listToggleLog,
  markDayCovered,
  type OperationalStore,
  openStore,
  queryTokenActivity,
  recordUsage,
  setCollectorSetting,
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
import {
  startUsageServices,
  TRANSCRIPT_ANALYSIS_SETTING,
  type UsageServices,
} from "./usage-services.js";
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
let pipelineRef: ReturnType<typeof createClaudePipeline>;
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
  pipelineRef = pipeline;
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

  it("merges status-line session metadata into the matching Run and publishes it (Codex 6)", async () => {
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    await pipelineRef.ingest(
      {
        eventId: randomUUID(),
        observedAt: startedAt,
        hook_event_name: "SessionStart",
        session_id: "sess-usage-1",
        source: "startup",
        model: "old-model",
        session_title: "old name",
        env: { CLAUDE_PID: "4242" },
      },
      "socket",
    );
    const before = pipelineRef.listSessionViews();
    expect(before).toHaveLength(1);
    const token = await handshake(socketPath);
    const res = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_STATUSLINE_PATH,
      rawBody: JSON.stringify(
        statusLine({ session_name: "Renamed", model_id: "new-model", effort_level: "high" }),
      ),
      token,
    });
    expect(res.status).toBe(202);
    const [view] = pipelineRef.listSessionViews();
    expect(view).toMatchObject({
      name: "Renamed",
      model: "new-model",
      effort: "high",
      claudeVersion: "2.1.283",
      state: before[0]?.state,
    });
    expect(view?.revision).toBeGreaterThan(before[0]?.revision ?? 0);
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

const WIDE = { start: "2020-01-01T00:00:00.000Z", end: "2100-01-01T00:00:00.000Z" };

function hookRecord(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: randomUUID(),
    observedAt: new Date().toISOString(),
    hook_event_name: event,
    session_id: "sess-usage-1",
    cwd: join(dir, "code", "demo"),
    env: { CLAUDE_PID: "4242" },
    ...extra,
  };
}

function eventsOf(type: string) {
  const replay = bus.buffer.since(0);
  if (replay.mode !== "replay") throw new Error("expected a replay");
  return replay.events.filter((event) => event.type === type);
}

function seedUsage(): void {
  recordUsage(
    store.db,
    [
      {
        messageId: "msg_seed_1",
        claudeSessionId: "sess-usage-1",
        timestamp: new Date().toISOString(),
        model: "claude-opus-4-8",
        skillKey: null,
        projectKey: null,
        counters: { input: 11, output: 22, cacheWrite: 0, cacheRead: 0 },
      },
    ],
    new Date().toISOString(),
  );
}

describe("POST transcript-analysis (Test 4, D-03, D-47, USAGE-07)", () => {
  it("turns analysis on: persisted, logged, first scan pending, a sweep, and both streams republished", async () => {
    const token = await handshake(socketPath);
    const res = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_TRANSCRIPT_ANALYSIS_PATH,
      rawBody: JSON.stringify({ enabled: true }),
      token,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });
    expect(getCollectorSetting(store.db, TRANSCRIPT_ANALYSIS_SETTING)).toBe("true");
    expect(listToggleLog(store.db)).toMatchObject([{ enabled: true }]);

    const pending = eventsOf("usage.updated").map((e) => UsageSummarySchema.parse(e.payload));
    expect(pending.some((s) => s.analysis.enabled && s.analysis.firstScanPending)).toBe(true);
    // The triggered sweep completes (the synthetic projects root is empty).
    await vi.waitFor(() => {
      expect(usage.summary().analysis).toEqual({ enabled: true, firstScanPending: false });
    });
    const integration = eventsOf("claude-integration.updated").map((e) =>
      ClaudeIntegrationStatusSchema.parse(e.payload),
    );
    expect(integration.at(-1)?.transcriptAnalysis).toEqual({ enabled: true });
  });

  it("turns analysis off: persisted, keeps aggregates, and a parallel SessionStart still applies", async () => {
    const token = await handshake(socketPath);
    setCollectorSetting(store.db, TRANSCRIPT_ANALYSIS_SETTING, "true", new Date().toISOString());
    seedUsage();
    const [toggle, hook] = await Promise.all([
      request<unknown>(socketPath, {
        method: "POST",
        path: CLAUDE_TRANSCRIPT_ANALYSIS_PATH,
        rawBody: JSON.stringify({ enabled: false }),
        token,
      }),
      request<unknown>(socketPath, {
        method: "POST",
        path: CLAUDE_HOOK_EVENTS_PATH,
        rawBody: JSON.stringify(hookRecord("SessionStart", { source: "startup" })),
        token,
      }),
    ]);
    expect(toggle.status).toBe(200);
    expect(toggle.body).toEqual({ enabled: false });
    expect(hook.status).toBe(202);
    expect(latestRunBySession(store.db, "sess-usage-1")?.state).toBe("running");
    expect(getCollectorSetting(store.db, TRANSCRIPT_ANALYSIS_SETTING)).toBe("false");
    expect(listToggleLog(store.db)).toMatchObject([{ enabled: false }]);
    expect(queryTokenActivity(store.db, WIDE).totals.input).toBe(11);
    expect(usage.integration().transcriptAnalysis).toEqual({ enabled: false });
    expect(usage.summary().ranges.today.activity).toMatchObject({ reason: "analysis-off" });
  });

  it("refuses a malformed toggle with the constant 400", async () => {
    const token = await handshake(socketPath);
    const res = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_TRANSCRIPT_ANALYSIS_PATH,
      rawBody: JSON.stringify({ enabled: "yes", path: "/etc" }),
      token,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid request body" });
    expect(getCollectorSetting(store.db, TRANSCRIPT_ANALYSIS_SETTING)).toBeNull();
  });
});

describe("POST usage/delete (Test 5, D-46, USAGE-08)", () => {
  it("empties the usage tables atomically, keeps Runs, and republishes usage.updated", async () => {
    const token = await handshake(socketPath);
    setCollectorSetting(store.db, TRANSCRIPT_ANALYSIS_SETTING, "true", new Date().toISOString());
    const hook = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_HOOK_EVENTS_PATH,
      rawBody: JSON.stringify(hookRecord("SessionStart", { source: "startup" })),
      token,
    });
    expect(hook.status).toBe(202);
    seedUsage();
    markDayCovered(store.db, "2026-09-20", new Date().toISOString());
    await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_STATUSLINE_PATH,
      rawBody: JSON.stringify(statusLine({ rate_limits: RATE_LIMITS, cost_total_usd: 2 })),
      token,
    });
    const runBefore = latestRunBySession(store.db, "sess-usage-1");

    const res = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_USAGE_DELETE_PATH,
      token,
    });
    expect(res.status).toBe(200);
    expect(queryTokenActivity(store.db, WIDE).totals.input).toBe(0);
    expect(latestCapacity(store.db)).toEqual([]);
    expect(listCostSnapshots(store.db)).toEqual([]);
    expect(latestRunBySession(store.db, "sess-usage-1")).toEqual(runBefore);
    expect(getCollectorSetting(store.db, TRANSCRIPT_ANALYSIS_SETTING)).toBe("true");

    const summary = UsageSummarySchema.parse(eventsOf("usage.updated").at(-1)?.payload);
    expect(summary.ranges.today.activity).toEqual({
      kind: "unavailable",
      reason: "no-coverage",
      version: null,
    });
    expect(summary.capacity.kind).toBe("unavailable");
  });

  it("refuses a body that is not empty or {}", async () => {
    const token = await handshake(socketPath);
    seedUsage();
    const res = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_USAGE_DELETE_PATH,
      rawBody: JSON.stringify({ table: "runs" }),
      token,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid request body" });
    expect(queryTokenActivity(store.db, WIDE).totals.input).toBe(11);
  });
});

describe("POST usage/session and GET integration (Tests 6-7, PR-23, PR-24)", () => {
  it("returns a SessionUsage for the Run's session, and 404 run-not-found for an unknown Run", async () => {
    const token = await handshake(socketPath);
    await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_HOOK_EVENTS_PATH,
      rawBody: JSON.stringify(hookRecord("SessionStart", { source: "startup" })),
      token,
    });
    await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_STATUSLINE_PATH,
      rawBody: JSON.stringify(statusLine({ cost_total_usd: 1.5 })),
      token,
    });
    const run = latestRunBySession(store.db, "sess-usage-1");
    if (run === null) throw new Error("expected a Run");

    const res = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_SESSION_USAGE_PATH,
      rawBody: JSON.stringify({ runId: run.runId }),
      token,
    });
    expect(res.status).toBe(200);
    const sessionUsage = SessionUsageSchema.parse(res.body);
    expect(sessionUsage.runId).toBe(run.runId);
    expect(sessionUsage.activity).toEqual({
      kind: "unavailable",
      reason: "analysis-off",
      version: null,
    });
    expect(sessionUsage.cost).toMatchObject({
      kind: "available",
      range: "session",
      usd: 1.5,
      basis: "claude-code-estimates",
    });

    const unknown = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_SESSION_USAGE_PATH,
      rawBody: JSON.stringify({ runId: newRunId() }),
      token,
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: "run-not-found" });

    const smuggled = await request<unknown>(socketPath, {
      method: "POST",
      path: CLAUDE_SESSION_USAGE_PATH,
      rawBody: JSON.stringify({ runId: run.runId, transcriptPath: "/etc/passwd" }),
      token,
    });
    expect(smuggled.status).toBe(400);
    expect(smuggled.body).toEqual({ error: "invalid request body" });
  });

  it("serves GET integration behind the token, and the snapshot carries claudeIntegration", async () => {
    const unauth = await request<unknown>(socketPath, {
      method: "GET",
      path: CLAUDE_INTEGRATION_PATH,
    });
    expect(unauth.status).toBe(401);

    const token = await handshake(socketPath);
    const res = await request<unknown>(socketPath, {
      method: "GET",
      path: CLAUDE_INTEGRATION_PATH,
      token,
    });
    expect(res.status).toBe(200);
    const status = ClaudeIntegrationStatusSchema.parse(res.body);
    // The synthetic Claude config dir holds no settings.json.
    expect(status.hooks).toBe("unknown");
    expect(status.transcriptAnalysis).toEqual({ enabled: false });
    expect(JSON.stringify(res.body)).not.toContain(dir);

    const snapshot = await request<unknown>(socketPath, {
      method: "GET",
      path: SNAPSHOT_PATH,
      token,
    });
    const parsed = SnapshotResponseSchema.parse(snapshot.body);
    expect(ClaudeIntegrationStatusSchema.parse(parsed.state.claudeIntegration)).toEqual(status);
  });
});
