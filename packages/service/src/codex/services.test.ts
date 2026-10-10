import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_TRANSCRIPT_ANALYSIS_PATH,
  CLAUDE_USAGE_DELETE_PATH,
  CODEX_FOLLOW_LOG_PATH,
  CODEX_HEADROOM_PATH,
  CODEX_HOOK_EVENTS_PATH,
  CODEX_INTEGRATION_PATH,
  CODEX_SESSIONS_PATH,
  CODEX_TOKEN_ACTIVITY_PATH,
  CODEX_USAGE_PATH,
  CodexIntegrationStatusSchema,
  CodexSessionsSnapshotSchema,
  CodexSessionsUpdatedPayloadSchema,
  CodexSnapshotStateSchema,
  CodexTokenSummarySchema,
  CodexTokensUpdatedPayloadSchema,
  CodexUsageSnapshotSchema,
  CodexUsageUpdatedPayloadSchema,
  HEALTH_PATH,
  HeadroomSignalSchema,
  SNAPSHOT_PATH,
  SnapshotResponseSchema,
} from "@ccc/domain";
import { projectDirName } from "@ccc/launchers";
import {
  getCollectorSetting,
  insertProject,
  markCodexDayCovered,
  markDayCovered,
  saveLauncherConfig,
  saveRateLimitSnapshot,
  setCollectorSetting,
} from "@ccc/operational-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShutdown } from "../shutdown.js";
import { createBridgeFixture } from "../test-support/bridge-fixtures.js";
import {
  type CodexComposition,
  type CodexCompositionOptions,
  type CompositionThread,
  codexHomeWithThreads,
  startCodexComposition,
  waitFor,
} from "../test-support/codex-composition.js";
import {
  nextRunId,
  writeLiveLog,
  writePendingResume,
  writeRunRecord,
} from "../test-support/codex-run-fixtures.js";
import { readFakeLog, weeklyReply } from "../test-support/fake-codex-app-server.js";
import {
  assertNoForbiddenAccess,
  assertNoMarkerLeak,
  createFakeCodexHome,
  recordingFs,
} from "../test-support/fake-codex-home.js";
import { runBoundedStopStep } from "./bounded-stop.js";
import type { BridgeStatus } from "./bridge-state.js";
import { createCodexHomePort } from "./codex-home.js";
import { CODEX_UNAVAILABLE_BODY } from "./route-support.js";
import { CODEX_SNAPSHOT_BUDGET_BYTES } from "./routes.js";

/**
 * Plan 05.1-28 Task 1 (tracer): the composed Codex services answer GET headroom
 * through the REAL request listener against a fake Codex home, a fake
 * app-server and the real Phase 5 usage services. Nothing here opens the
 * owner's runtime directory, the real Codex home or the real bridge state.
 */

const open: CodexComposition[] = [];

afterEach(async () => {
  for (const composition of open.splice(0)) await composition.close();
});

describe("stop() step isolation", () => {
  it("a step that never resolves is abandoned at its deadline and a failing step is contained", async () => {
    vi.useFakeTimers();
    try {
      const warnings: Array<Record<string, unknown>> = [];
      const logger = { warn: (fields: Record<string, unknown>) => warnings.push(fields) };
      const ran: string[] = [];
      const step = (name: string, run: () => void | Promise<void>) =>
        runBoundedStopStep({ name, run, deadlineMs: 100, logger });
      const all = (async () => {
        await step("hung", () => new Promise<void>(() => undefined));
        await step("throws", () => {
          throw new Error("secret detail");
        });
        await step("later", () => {
          ran.push("later");
        });
      })();
      await vi.advanceTimersByTimeAsync(150);
      await all;
      expect(ran).toEqual(["later"]);
      expect(warnings).toEqual([
        { reason: "stop-step-timeout", step: "hung" },
        { reason: "stop-step-failed", step: "throws", errorName: "Error" },
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a step that throws inside the real stop() does not keep the later steps from running", async () => {
    const c = await compose({
      appServer: { read: { kind: "hang" } },
      deps: {
        timers: {
          setInterval: () => 1,
          clearInterval: () => {
            throw new Error("clear failed");
          },
        },
      },
    });
    const pending = c.get(CODEX_HEADROOM_PATH);
    const deadline = Date.now() + 5000;
    while (c.appServerStarts() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const pids = (c.appServer === null ? [] : readFakeLog(c.appServer.logPath)).flatMap((entry) =>
      entry.t === "start" ? [entry.pid] : [],
    );
    expect(pids.length).toBeGreaterThan(0);
    await c.codex?.stop();
    await expectGone(pids);
    await pending;
  });
});

async function compose(options: CodexCompositionOptions): Promise<CodexComposition> {
  const composition = await startCodexComposition(options);
  open.push(composition);
  return composition;
}

/** A status-line snapshot at 62 percent of the five-hour window, as the wrapper forwards it. */
function claudeStatusLine(): Record<string, unknown> {
  return {
    eventId: randomUUID(),
    observedAt: new Date().toISOString(),
    session_id: "sess-codex-composition-1",
    model_id: "claude-opus-4-8",
    version: "2.1.283",
    rate_limits: {
      five_hour: {
        used_percentage: 62,
        resets_at: Math.floor(Date.now() / 1000) + 5 * 3600,
      },
    },
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A killed child takes a moment to be reaped; waits until every pid is gone (or the deadline). */
async function expectGone(pids: readonly number[]): Promise<void> {
  const deadline = Date.now() + 5000;
  while (pids.some((pid) => pidAlive(pid)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  for (const pid of pids) expect(pidAlive(pid)).toBe(false);
}

describe("Task 1 (tracer): GET headroom through the composed services", () => {
  it("Test 1: answers a strict signal with the Codex read and the Claude view", async () => {
    const c = await compose({
      appServer: { read: { kind: "result", result: weeklyReply(41) } },
      usage: "real",
    });
    expect(c.usage?.handleStatusLine(claudeStatusLine())).toBe("applied");

    const reply = await c.get(CODEX_HEADROOM_PATH);

    expect(reply.status).toBe(200);
    const signal = HeadroomSignalSchema.parse(reply.body);
    expect(signal.codex.verdict).toBe("allow");
    expect(signal.codex.reason).toBeNull();
    expect(signal.codex.source).toBe("app-server");
    expect(signal.codex.freshness).toBe("live");
    expect(signal.codex.worstWindow?.usedPercent).toBe(41);
    expect(signal.claude.kind).toBe("available");
    if (signal.claude.kind !== "available") throw new Error("unreachable");
    expect(signal.claude.usedPercent).toBe(62);
    expect(signal.claude.window).toBe("five-hour");
    expect(signal.claude.source).toBe("claude-code-status-line");
    expect(c.appServerStarts()).toBe(1);
  });

  it("Test 1b: the usage route answers the same read as a plain usage snapshot", async () => {
    const c = await compose({
      appServer: { read: { kind: "result", result: weeklyReply(41) } },
    });
    const reply = await c.get(CODEX_USAGE_PATH);
    expect(reply.status).toBe(200);
    const usage = CodexUsageSnapshotSchema.parse(reply.body);
    expect(usage.kind).toBe("available");
  });

  it("Test 2: without the codex member every Codex route is the constant 503 and nothing else changes", async () => {
    const c = await compose({ codex: false });

    const headroom = await c.get(CODEX_HEADROOM_PATH);
    expect(headroom.status).toBe(503);
    expect(headroom.body).toEqual(CODEX_UNAVAILABLE_BODY);

    const health = await c.get(HEALTH_PATH);
    expect(health.status).toBe(200);

    const snapshot = await c.get(SNAPSHOT_PATH);
    expect(snapshot.status).toBe(200);
    const parsed = SnapshotResponseSchema.parse(snapshot.body);
    expect(parsed.state.codex).toBeUndefined();
    expect(JSON.stringify(snapshot.body)).not.toContain("codex");
  });

  it("Test 4: stop() is idempotent, clears every timer it armed and leaves no child process", async () => {
    const c = await compose({
      appServer: { read: { kind: "result", result: weeklyReply(41) } },
    });
    expect(c.codex).toBeDefined();
    c.codex?.start();
    expect(c.timers.armed()).toBeGreaterThan(0);

    await c.get(CODEX_HEADROOM_PATH);
    const pids = (c.appServer === null ? [] : readFakeLog(c.appServer.logPath)).flatMap((entry) =>
      entry.t === "start" ? [entry.pid] : [],
    );
    expect(pids.length).toBeGreaterThan(0);

    await c.codex?.stop();
    await c.codex?.stop();

    expect(c.timers.armed()).toBe(0);
    await expectGone(pids);
  });

  it("Test 4b: stop() kills a read that is still in flight", async () => {
    const c = await compose({ appServer: { read: { kind: "hang" } } });
    const pending = c.get(CODEX_HEADROOM_PATH);
    const deadline = Date.now() + 5000;
    while (c.appServerStarts() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(c.appServerStarts()).toBe(1);
    const pids = (c.appServer === null ? [] : readFakeLog(c.appServer.logPath)).flatMap((entry) =>
      entry.t === "start" ? [entry.pid] : [],
    );

    await c.codex?.stop();

    await expectGone(pids);
    const reply = await pending;
    expect(reply.status).toBe(200);
    expect(HeadroomSignalSchema.parse(reply.body).codex.verdict).toBe("refuse");
  });

  it("Test 5: with no saved Codex row nothing is spawned; saving a row makes the next read spawn the fake", async () => {
    const clock = { ms: Date.now() };
    const c = await compose({
      appServer: { read: { kind: "result", result: weeklyReply(41) } },
      saveRow: false,
      now: () => clock.ms,
    });

    const headroom = await c.get(CODEX_HEADROOM_PATH);
    expect(headroom.status).toBe(200);
    const signal = HeadroomSignalSchema.parse(headroom.body);
    expect(signal.codex.verdict).toBe("refuse");
    expect(signal.codex.reason).toBe("usage-unavailable");

    const usage = await c.get(CODEX_USAGE_PATH);
    expect(usage.status).toBe(200);
    expect(CodexUsageSnapshotSchema.parse(usage.body).kind).toBe("unavailable");
    expect(c.appServerStarts()).toBe(0);

    if (c.appServer === null) throw new Error("unreachable");
    saveLauncherConfig(c.store.db, "codex", { executablePath: c.appServer.path, args: [] });
    clock.ms += 30_000;

    const after = await c.get(CODEX_HEADROOM_PATH);
    expect(HeadroomSignalSchema.parse(after.body).codex.verdict).toBe("allow");
    expect(c.appServerStarts()).toBe(1);
  });

  it("Test 5c: with no live read the composed usage route shows the newest rollout figure and the gate still refuses (plan 05.1-33)", async () => {
    const nowMs = Date.UTC(2026, 9, 10, 12, 0, 0);
    const stamp = nowMs - 4 * 60_000;
    const line = JSON.stringify({
      timestamp: new Date(stamp).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 37, window_minutes: 10_080, resets_at: 1_791_500_000 },
          secondary: null,
          plan_type: "DECOY-PLAN-TYPE",
        },
      },
    });
    const c = await compose({
      appServer: { read: { kind: "result", result: weeklyReply(41) } },
      saveRow: false,
      now: () => nowMs,
      home: {
        ...codexHomeWithThreads([]),
        rollouts: [
          {
            day: "2026-10-10",
            name: "rollout-2026-10-10T11-56-00-composed.jsonl",
            content: `${line}\n`,
            mtimeMs: stamp,
          },
        ],
      },
    });

    const usage = CodexUsageSnapshotSchema.parse((await c.get(CODEX_USAGE_PATH)).body);
    expect(usage).toMatchObject({ kind: "available", source: "rollout-fallback" });
    expect(usage.kind === "available" && usage.windows[0]?.usedPercent).toBe(37);
    expect(usage.kind === "available" && usage.observedAt).toBe(new Date(stamp).toISOString());

    const headroom = HeadroomSignalSchema.parse((await c.get(CODEX_HEADROOM_PATH)).body);
    expect(headroom.codex).toMatchObject({ verdict: "refuse", source: "rollout-fallback" });
    expect(c.appServerStarts()).toBe(0);
    expect(JSON.stringify([usage, headroom])).not.toContain("DECOY");
  });
});

// ---------------------------------------------------------------------------
// Task 2: the snapshot member, the events, the shared toggle, the combined delete

const THREAD = "thread-services-aaaa1111";

function thread(id: string, agoMs: number): CompositionThread {
  return {
    id,
    agoMs,
    lifecycle: [
      ["task_started", agoMs + 5000],
      ["task_complete", agoMs],
    ],
  };
}

describe("the snapshot's optional codex member", () => {
  it("Test 2: carries every part, each read from the services' caches, and parses strictly", async () => {
    const c = await compose({
      appServer: { read: { kind: "result", result: weeklyReply(41) } },
      home: codexHomeWithThreads([thread(THREAD, 2 * 3_600_000)]),
    });
    // Warm the caches the way the dashboard does.
    await c.get(CODEX_SESSIONS_PATH);
    await c.get(CODEX_HEADROOM_PATH);

    const reply = await c.get(SNAPSHOT_PATH);
    expect(reply.status).toBe(200);
    const snapshot = SnapshotResponseSchema.parse(reply.body);
    const codex = CodexSnapshotStateSchema.parse(snapshot.state.codex);
    expect(codex.sessions?.kind).toBe("available");
    expect(codex.usage?.kind).toBe("available");
    expect(codex.headroom?.codex.verdict).toBe("allow");
    expect(codex.tokens).toBeDefined();
    expect(codex.integration?.codex.installed).toBe(true);
    expect(snapshot.lastEventId).toBe(c.bus.buffer.latestId());
  });

  it("Test 2: omits only the parts nothing has observed yet, and never waits for a refresh", async () => {
    const c = await compose({
      appServer: { read: { kind: "hang" } },
      home: codexHomeWithThreads([thread(THREAD, 2 * 3_600_000)]),
    });
    const started = Date.now();
    const reply = await c.get(SNAPSHOT_PATH);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(reply.status).toBe(200);
    const snapshot = SnapshotResponseSchema.parse(reply.body);
    const codex = CodexSnapshotStateSchema.parse(snapshot.state.codex);
    expect(codex.usage).toBeUndefined();
    expect(codex.headroom).toBeUndefined();
    expect(codex.sessions).toBeUndefined();
    expect(codex.tokens).toBeDefined();
    expect(codex.integration).toBeDefined();
    // The snapshot asked each service for a fire-and-forget refresh.
    expect(await waitFor(() => c.appServerStarts() === 1)).toBe(true);
  });

  it("Test 2: a session list of 250 threads is trimmed to the byte budget and the rest counted as hidden", async () => {
    const hour = 3_600_000;
    const threads = Array.from({ length: 250 }, (_, index) =>
      thread(`thread-size-${String(index).padStart(4, "0")}`, 2 * hour + index * 1000),
    );
    const c = await compose({
      appServer: { read: { kind: "result", result: weeklyReply(41) } },
      home: codexHomeWithThreads(threads),
      subscribers: 1,
    });
    c.codex?.start();
    // One poll reads at most 40 rollouts and carries the rest, so poll until the list is full.
    let listed = 0;
    for (let attempt = 0; attempt < 20 && listed < 200; attempt += 1) {
      c.timers.tick();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const body = CodexSessionsSnapshotSchema.parse((await c.get(CODEX_SESSIONS_PATH)).body);
      listed = body.kind === "available" ? body.sessions.length : 0;
    }
    const full = CodexSessionsSnapshotSchema.parse((await c.get(CODEX_SESSIONS_PATH)).body);
    if (full.kind !== "available") throw new Error("unreachable");
    expect(full.sessions.length).toBe(200);

    const reply = await c.get(SNAPSHOT_PATH);
    const bytes = Buffer.byteLength(JSON.stringify(reply.body), "utf8");
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
    const snapshot = SnapshotResponseSchema.parse(reply.body);
    const member = snapshot.state.codex;
    expect(Buffer.byteLength(JSON.stringify(member), "utf8")).toBeLessThanOrEqual(
      CODEX_SNAPSHOT_BUDGET_BYTES,
    );
    const trimmed = member?.sessions;
    if (trimmed?.kind !== "available") throw new Error("unreachable");
    expect(trimmed.sessions.length).toBeLessThan(full.sessions.length);
    expect(trimmed.sessions.length).toBeGreaterThan(0);
    expect(trimmed.sessions).toEqual(full.sessions.slice(0, trimmed.sessions.length));
    expect(trimmed.sessions.length + trimmed.hiddenCount).toBe(
      full.sessions.length + full.hiddenCount,
    );
  });
});

describe("the four Codex events", () => {
  it("Test 3: a session change and a usage change each publish with a strict payload; an unchanged session re-poll publishes nothing", async () => {
    const c = await compose({
      appServer: { read: { kind: "result", result: weeklyReply(41) } },
      home: codexHomeWithThreads([thread(THREAD, 2 * 3_600_000)]),
      subscribers: 1,
    });
    c.codex?.start();
    c.timers.tick();
    expect(await waitFor(() => c.events("codex.sessions.updated").length === 1)).toBe(true);
    expect(await waitFor(() => c.events("codex.usage.updated").length === 1)).toBe(true);
    CodexSessionsUpdatedPayloadSchema.parse(c.events("codex.sessions.updated")[0]?.payload);
    CodexUsageUpdatedPayloadSchema.parse(c.events("codex.usage.updated")[0]?.payload);

    // A re-poll of an unchanged store publishes no sessions event. (A second usage read carries a
    // new observation time, which the headroom service counts as a change viewers see.)
    c.timers.tick();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(c.events("codex.sessions.updated")).toHaveLength(1);
    for (const event of c.events("codex.usage.updated")) {
      CodexUsageUpdatedPayloadSchema.parse(event.payload);
    }
  });

  it("Test 3: without subscribers the timers read nothing", async () => {
    const c = await compose({
      appServer: { read: { kind: "result", result: weeklyReply(41) } },
      home: codexHomeWithThreads([thread(THREAD, 2 * 3_600_000)]),
      subscribers: 0,
    });
    c.codex?.start();
    c.timers.tick();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(c.appServerStarts()).toBe(0);
    expect(c.events("codex.sessions.updated")).toHaveLength(0);
  });
});

describe("the shared transcript-analysis toggle", () => {
  it("Test 5: titles appear and the token scan starts when analysis goes on, and both go away when it goes off", async () => {
    const c = await compose({
      usage: "real",
      home: codexHomeWithThreads([
        { ...thread(THREAD, 2 * 3_600_000), title: "Refactor the parser" },
      ]),
    });
    const titles = async (): Promise<(string | null)[]> => {
      const body = CodexSessionsSnapshotSchema.parse((await c.get(CODEX_SESSIONS_PATH)).body);
      if (body.kind !== "available") throw new Error("unreachable");
      return body.sessions.map((s) => s.title);
    };
    expect(await titles()).toEqual([null]);
    const offSummary = CodexTokenSummarySchema.parse((await c.get(CODEX_TOKEN_ACTIVITY_PATH)).body);
    expect(
      Object.values(offSummary.ranges).every(
        (r) => r.kind === "unavailable" && r.reason === "analysis-off",
      ),
    ).toBe(true);

    const on = await c.post(CLAUDE_TRANSCRIPT_ANALYSIS_PATH, { enabled: true });
    expect(on.status).toBe(200);
    expect(await waitFor(() => c.events("codex.tokens.updated").length >= 1)).toBe(true);
    let seen: (string | null)[] = [];
    expect(
      await waitFor(() => {
        void titles().then((value) => {
          seen = value;
        });
        return seen[0] === "Refactor the parser";
      }),
    ).toBe(true);
    const onSummary = CodexTokenSummarySchema.parse((await c.get(CODEX_TOKEN_ACTIVITY_PATH)).body);
    expect(
      Object.values(onSummary.ranges).some(
        (r) => !(r.kind === "unavailable" && r.reason === "analysis-off"),
      ),
    ).toBe(true);

    const off = await c.post(CLAUDE_TRANSCRIPT_ANALYSIS_PATH, { enabled: false });
    expect(off.status).toBe(200);
    expect(
      await waitFor(() => {
        void titles().then((value) => {
          seen = value;
        });
        return seen[0] === null;
      }),
    ).toBe(true);
    const afterOff = CodexTokenSummarySchema.parse((await c.get(CODEX_TOKEN_ACTIVITY_PATH)).body);
    expect(
      Object.values(afterOff.ranges).every(
        (r) => r.kind === "unavailable" && r.reason === "analysis-off",
      ),
    ).toBe(true);
  });
});

describe("the combined 'Delete cached usage analytics'", () => {
  it("Test 6: empties the Claude and the Codex analytics together, keeps settings, resets the scan and republishes", async () => {
    const c = await compose({ usage: "real", home: codexHomeWithThreads([]) });
    const at = new Date().toISOString();
    await c.post(CLAUDE_TRANSCRIPT_ANALYSIS_PATH, { enabled: true });
    await waitFor(() => c.events("codex.tokens.updated").length >= 1);
    markDayCovered(c.store.db, "2020-01-01", at);
    markCodexDayCovered(c.store.db, "2020-01-01", at);
    saveRateLimitSnapshot(
      c.store.db,
      CodexUsageSnapshotSchema.parse({
        kind: "available",
        windows: [{ windowMinutes: 10_080, usedPercent: 41, resetsAt: null, limitLabel: null }],
        ordinaryUsageAllowed: true,
        rateLimitReached: false,
        rateLimitReachedType: null,
        source: "app-server",
        observedAt: at,
        freshness: "live",
      }),
      at,
    );
    setCollectorSetting(c.store.db, "codex_token_first_scan_done", "1", at);
    // With analysis on, the rebuild after a delete recounts recent days, so the markers are days
    // far outside any retention window: only the delete can remove them.
    const count = (table: string, where = ""): number =>
      (c.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n;
    const OLD = "WHERE day = '2020-01-01'";
    expect(count("coverage_days", OLD)).toBe(1);
    expect(count("codex_coverage_days", OLD)).toBe(1);
    const usageEvents = c.events("usage.updated").length;
    const tokenEvents = c.events("codex.tokens.updated").length;

    const reply = await c.post(CLAUDE_USAGE_DELETE_PATH, {});
    expect(reply.status).toBeLessThan(300);

    expect(count("coverage_days", OLD)).toBe(0);
    expect(count("codex_coverage_days", OLD)).toBe(0);
    expect(count("codex_rate_limit_snapshot")).toBe(0);
    expect(getCollectorSetting(c.store.db, "transcript_analysis_enabled")).toBe("true");
    expect(c.events("usage.updated").length).toBeGreaterThan(usageEvents);
    expect(c.events("codex.tokens.updated").length).toBeGreaterThan(tokenEvents);
    const last = CodexTokensUpdatedPayloadSchema.parse(
      c.events("codex.tokens.updated").at(-1)?.payload,
    );
    expect(last.firstScanPending).toBeDefined();
  });
});

describe("the overlay order and the shared inactivity window", () => {
  const SESSION = "11111111-2222-3333-4444-555555555555";

  it("Test 7: a wrapper-only limit pause survives a later hook Stop because the run overlay is registered first", async () => {
    const now = Date.now();
    let root = "";
    const c = await compose({
      home: codexHomeWithThreads(
        [
          {
            id: SESSION,
            agoMs: 15 * 60_000,
            lifecycle: [["task_started", 20 * 60_000]],
          },
        ],
        now,
      ),
      prepare: ({ store, dir }) => {
        root = realpathSync(mkdtempSync(join(dir, "proj-")));
        insertProject(store.db, { path: root, displayName: "pause-project" });
        const state = join(root, ".planning", "codex");
        const pendingRun = nextRunId();
        writeRunRecord(state, {
          runId: pendingRun,
          sessionId: SESSION,
          status: "limit",
          resetsAt: new Date(now + 3_600_000).toISOString(),
        });
        writePendingResume(state, {
          sessionId: SESSION,
          runId: pendingRun,
          resetsAt: new Date(now + 3_600_000).toISOString(),
          recordedAt: new Date(now - 10 * 60_000).toISOString(),
        });
      },
    });
    const stateOf = async (): Promise<string | undefined> => {
      const body = CodexSessionsSnapshotSchema.parse((await c.get(CODEX_SESSIONS_PATH)).body);
      if (body.kind !== "available") throw new Error("unreachable");
      return body.sessions.find((s) => s.threadId === SESSION)?.state;
    };
    expect(await stateOf()).toBe("limit-paused");

    const accepted = await c.post(CODEX_HOOK_EVENTS_PATH, {
      eventId: randomUUID(),
      observedAt: new Date().toISOString(),
      hook_event_name: "Stop",
      session_id: SESSION,
      turn_id: "turn-1",
    });
    expect(accepted.status).toBe(202);
    expect(await stateOf()).toBe("limit-paused");
  });

  it("Test 7: the source registers the run overlay before the hook overlay and resolves the inactivity window once", () => {
    const source = readFileSync(fileURLToPath(new URL("./services.ts", import.meta.url)), "utf8");
    const run = source.indexOf("createRunOverlay(");
    const hook = source.indexOf("createHookOverlay(");
    expect(run).toBeGreaterThan(-1);
    expect(hook).toBeGreaterThan(run);
    expect(source).toMatch(/run overlay[\s\S]*BEFORE[\s\S]*hook overlay/i);
    expect(source.split("resolveCodexInactivityMs(").length - 1).toBe(1);
    for (const consumer of [
      "createCodexSessionMirror(",
      "createRunOverlay(",
      "createHookOverlay(",
      "createFollowLogService(",
    ]) {
      const at = source.indexOf(consumer);
      expect(at, consumer).toBeGreaterThan(-1);
      expect(source.slice(at, at + 900), consumer).toContain("inactivityMs");
    }
  });
});

describe("follow-log queues to the bridge directory that holds the run's log", () => {
  it("Test 8: a run under the default state directory is queued there, never to the custom primary one", async () => {
    const fx = createBridgeFixture();
    try {
      fx.installLauncher();
      fx.installMarker();
      const sim = fx.simulator("current");
      sim.heartbeat();
      const custom = join(fx.home, "custom-state");
      const customDir = join(custom, "codex-bridge");
      for (const name of ["windows", "requests", "claimed"]) {
        mkdirSync(join(customDir, name), { recursive: true });
      }
      writeFileSync(
        join(customDir, "protocol.json"),
        JSON.stringify({ protocol: 2, capabilities: ["follow", "tui", "agent"], kit: "test-kit" }),
      );
      const userState = join(fx.stateDir, "projects", projectDirName(fx.projectDir));
      let runId = "";
      const c = await compose({
        homeDir: fx.home,
        env: { XDG_STATE_HOME: custom },
        prepare: ({ store }) => {
          insertProject(store.db, { path: fx.projectDir, displayName: "follow-project" });
          const record = writeRunRecord(userState, {
            kind: "task",
            mode: "headless",
            status: "running",
          });
          runId = record.runId;
          writeLiveLog(userState, record.runId, "task", { mtimeMs: Date.now() - 2000 });
        },
      });
      // The simulated window answers while the service waits for its claim.
      const ticker = setInterval(() => sim.tick(), 40);
      try {
        const reply = await c.post(CODEX_FOLLOW_LOG_PATH, { runId });
        expect(reply).toEqual({ status: 200, body: { ok: true } });
      } finally {
        clearInterval(ticker);
      }
      expect(fx.claimedFiles()).toHaveLength(1);
      expect(readdirSync(join(customDir, "requests"))).toEqual([]);
      expect(readdirSync(join(customDir, "claimed"))).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Task 3: boot, shutdown order and the missing or unrecognised Codex home

describe("boot and shutdown of the composed service (Task 3)", () => {
  it("a composition that cannot be built never fails the service: inert services, 503 routes, start and stop do nothing", async () => {
    // A runtime directory that is not a path makes the hook spool and status provider throw.
    const c = await compose({ deps: { runtimeDir: undefined as unknown as string } });
    expect(c.codex).toBeDefined();
    expect(() => c.codex?.start()).not.toThrow();
    expect((await c.get(CODEX_HEADROOM_PATH)).status).toBe(503);
    expect((await c.get(CODEX_SESSIONS_PATH)).status).toBe(503);
    expect(() => c.codex?.onAnalysisChanged({ enabled: true, cause: "delete" })).not.toThrow();
    await expect(c.codex?.stop()).resolves.toBeUndefined();
  });

  it("Test 3: answers the four read routes with the right shapes, then shuts down Codex first and the store last", async () => {
    const c = await compose({
      appServer: { read: { kind: "result", result: weeklyReply(41) } },
      home: codexHomeWithThreads([thread(THREAD, 2 * 3_600_000)]),
    });
    c.codex?.start();
    expect(HeadroomSignalSchema.parse((await c.get(CODEX_HEADROOM_PATH)).body).codex.verdict).toBe(
      "allow",
    );
    expect(CodexSessionsSnapshotSchema.parse((await c.get(CODEX_SESSIONS_PATH)).body).kind).toBe(
      "available",
    );
    CodexTokenSummarySchema.parse((await c.get(CODEX_TOKEN_ACTIVITY_PATH)).body);
    CodexIntegrationStatusSchema.parse((await c.get(CODEX_INTEGRATION_PATH)).body);
    const pids = (c.appServer === null ? [] : readFakeLog(c.appServer.logPath)).flatMap((entry) =>
      entry.t === "start" ? [entry.pid] : [],
    );

    const events: string[] = [];
    let serverDone: () => void = () => undefined;
    const shutdown = createShutdown({
      stopApprovals: async () => {
        events.push("approvals");
      },
      stopCodex: async () => {
        await c.codex?.stop();
        events.push("codex");
      },
      stopUsage: async () => {
        events.push("usage");
      },
      stopClaude: async () => {
        events.push("claude");
      },
      stopIntake: () => undefined,
      closeServer: (done) => {
        serverDone = done;
      },
      closeResources: () => {
        events.push("store-closed");
      },
      exit: (code) => events.push(`exit-${code}`),
      onError: () => events.push("error"),
      keepAlive: { start: () => 1, stop: () => undefined },
    });
    shutdown();
    serverDone();
    expect(await waitFor(() => events.includes("exit-0"))).toBe(true);
    expect(events).toEqual(["approvals", "codex", "usage", "claude", "store-closed", "exit-0"]);
    expect(c.timers.armed()).toBe(0);
    await expectGone(pids);
  });

  it("Test 4: with the Codex services not composed every Codex path is the constant 503 and the rest behaves as before", async () => {
    const c = await compose({ codex: false });
    expect((await c.get(CODEX_SESSIONS_PATH)).status).toBe(503);
    expect((await c.post(CODEX_HOOK_EVENTS_PATH, {})).status).toBe(503);
    expect((await c.get(HEALTH_PATH)).status).toBe(200);
  });

  it("Test 5: an unrecognised store shape starts fine, answers unavailable, and no credential or configuration file is touched", async () => {
    const home = createFakeCodexHome({
      withDecoys: true,
      database: {
        ddl: "changed",
        threads: [{ id: THREAD, updatedAtMs: Date.now() - 60_000 }],
      },
    });
    try {
      const recorder = recordingFs();
      const port = createCodexHomePort({ root: home.root, fs: recorder.fs });
      const c = await compose({ deps: { port } });
      const reply = await c.get(CODEX_SESSIONS_PATH);
      expect(reply.status).toBe(200);
      const body = CodexSessionsSnapshotSchema.parse(reply.body);
      expect(body.kind).toBe("unavailable");
      if (body.kind === "unavailable") expect(body.reason).toBe("format-changed");
      await c.get(CODEX_INTEGRATION_PATH);
      assertNoForbiddenAccess(recorder.calls, home);
      assertNoMarkerLeak([JSON.stringify(reply.body)], home);
    } finally {
      home.cleanup();
    }
  });

  it("Test 5: a CODEX_HOME that does not exist starts fine and answers unavailable", async () => {
    const missing = join(tmpdir(), `ccc-no-codex-home-${randomUUID()}`);
    const recorder = recordingFs();
    const port = createCodexHomePort({ root: missing, fs: recorder.fs });
    const c = await compose({ deps: { port } });
    const reply = await c.get(CODEX_SESSIONS_PATH);
    expect(reply.status).toBe(200);
    expect(CodexSessionsSnapshotSchema.parse(reply.body).kind).toBe("unavailable");
    expect(recorder.calls.every((call) => call.path.startsWith(missing))).toBe(true);
  });

  it("Test 5: under a test runner the real default Codex home is refused and the services run against an absent home", async () => {
    const c = await compose({
      deps: { port: undefined, home: homedir(), readBridgeStatus: () => NOT_INSTALLED_BRIDGE },
    });
    const reply = await c.get(CODEX_SESSIONS_PATH);
    expect(reply.status).toBe(200);
    expect(CodexSessionsSnapshotSchema.parse(reply.body).kind).toBe("unavailable");
    expect(
      CodexTokenSummarySchema.safeParse((await c.get(CODEX_TOKEN_ACTIVITY_PATH)).body).success,
    ).toBe(true);
  });
});

const NOT_INSTALLED_BRIDGE: BridgeStatus = {
  state: "not-installed",
  protocol: null,
  capabilities: null,
  launcherPresent: false,
  dir: "/Users/USERNAME/state/codex-bridge",
  dirSource: "primary",
  launchable: true,
  windows: [],
};
