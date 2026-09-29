import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evidence } from "@ccc/collectors";
import { newRunId, type RunId, type SessionRun } from "@ccc/domain";
import {
  applyMigrations,
  getSessionRun,
  type OperationalStore,
  openStore,
  upsertSessionRun,
} from "@ccc/operational-store";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../events/event-bus.js";
import {
  createLivenessSweeper,
  DEFAULT_LIVENESS_CONFIG,
  type LivenessConfig,
  type LivenessSweeper,
} from "./liveness.js";
import {
  type ClaudePipeline,
  createClaudePipeline,
  type SessionFactsProvider,
} from "./pipeline.js";
import type { ProcessFacts } from "./process-facts.js";

const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const LSTART = "Mon Sep 29 09:59:58 2026";
const OTHER_LSTART = "Mon Sep 29 09:59:59 2026";
const PID = 111;
const SESSION = "sess-liveness-1";

const NULL_FACTS: SessionFactsProvider = {
  factsFor: async () => ({
    pidStartedAt: null,
    launchSource: null,
    projectId: null,
    worktreeRoot: null,
    transcriptPath: null,
  }),
};

/** A fake process table: which pids answer kill(0), and each pid's lstart. */
function fakeProcessTable() {
  const alive = new Set<number>();
  const starts = new Map<number, string>();
  const facts: Pick<ProcessFacts, "isAlive" | "readStartTimes"> = {
    isAlive: (pid) => alive.has(pid),
    readStartTimes: async (pids) => {
      const out = new Map<number, string>();
      for (const pid of pids) {
        const start = starts.get(pid);
        if (alive.has(pid) && start !== undefined) out.set(pid, start);
      }
      return out;
    },
  };
  return {
    facts,
    spawn(pid: number, lstart: string) {
      alive.add(pid);
      starts.set(pid, lstart);
    },
    kill(pid: number) {
      alive.delete(pid);
      starts.delete(pid);
    },
  };
}

let dir: string;
let store: OperationalStore;
let nowMs: number;
let applied: Evidence[];
let pipeline: ClaudePipeline;
let table: ReturnType<typeof fakeProcessTable>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-liveness-"));
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
  nowMs = T0;
  applied = [];
  table = fakeProcessTable();
  pipeline = createClaudePipeline({
    db: store.db,
    bus: createEventBus(),
    logger: pino({ level: "silent" }),
    now: () => new Date(nowMs),
    mintRunId: newRunId,
    facts: NULL_FACTS,
    schedule: () => () => {},
  });
});

afterEach(async () => {
  await pipeline.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedRun(patch: Partial<SessionRun> = {}): SessionRun {
  const run: SessionRun = {
    runId: newRunId(),
    revision: 1,
    claudeSessionId: SESSION,
    pid: PID,
    pidStartedAt: LSTART,
    state: "running",
    activity: "working",
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
    startedAt: new Date(T0 - 60_000).toISOString(),
    lastActivityAt: new Date(T0 - 1_000).toISOString(),
    endedAt: null,
    terminateRequestedAt: null,
    endObservedAt: null,
    ...patch,
  };
  upsertSessionRun(store.db, run);
  return run;
}

function sweeperWith(config: Partial<LivenessConfig> = {}): LivenessSweeper {
  const spied: Pick<ClaudePipeline, "apply"> = {
    apply: (evidence) => {
      applied.push(evidence);
      return pipeline.apply(evidence);
    },
  };
  return createLivenessSweeper({
    db: store.db,
    pipeline: spied,
    processFacts: table.facts,
    logger: pino({ level: "silent" }),
    now: () => new Date(nowMs),
    config: { ...DEFAULT_LIVENESS_CONFIG, ...config },
  });
}

function stateOf(runId: RunId): string | undefined {
  return getSessionRun(store.db, runId)?.state;
}

function appliedKinds(runId: RunId): string[] {
  return applied
    .filter((evidence) => "runId" in evidence && evidence.runId === runId)
    .map((evidence) => evidence.kind);
}

describe("process liveness sweep (Task 1, SESS-06, D-19)", () => {
  it("applies pid-gone once, only after the grace, and the Run reads stale (Test 1)", async () => {
    table.spawn(PID, LSTART);
    const run = seedRun();
    const sweeper = sweeperWith();
    table.kill(PID);

    await sweeper.sweepNow();
    expect(stateOf(run.runId)).toBe("running");

    nowMs = T0 + DEFAULT_LIVENESS_CONFIG.graceMs - 1;
    await sweeper.sweepNow();
    expect(stateOf(run.runId)).toBe("running");
    expect(appliedKinds(run.runId)).toEqual([]);

    nowMs = T0 + DEFAULT_LIVENESS_CONFIG.graceMs;
    await sweeper.sweepNow();
    expect(stateOf(run.runId)).toBe("stale");
    expect(appliedKinds(run.runId)).toEqual(["pid-gone"]);

    nowMs += 3 * DEFAULT_LIVENESS_CONFIG.sweepMs;
    await sweeper.sweepNow();
    await sweeper.sweepNow();
    expect(appliedKinds(run.runId)).toEqual(["pid-gone"]);
    const final = getSessionRun(store.db, run.runId);
    expect(final?.state).toBe("stale");
    expect(final?.endedAt).toBeNull();
  });

  it("a vanished process is never completed or failed by inference (SESS-06)", async () => {
    const run = seedRun();
    const sweeper = sweeperWith();
    for (let i = 0; i <= 10; i += 1) {
      nowMs = T0 + i * DEFAULT_LIVENESS_CONFIG.sweepMs;
      await sweeper.sweepNow();
    }
    const state = stateOf(run.runId);
    expect(state).toBe("stale");
    expect(["completed", "failed"]).not.toContain(state);
  });

  it("a gone pid with a pending terminate and an observed end reads cancelled (Test 2)", async () => {
    const run = seedRun({
      terminateRequestedAt: new Date(T0 - 2_000).toISOString(),
      endObservedAt: new Date(T0 - 1_000).toISOString(),
    });
    const sweeper = sweeperWith();
    await sweeper.sweepNow();
    nowMs = T0 + DEFAULT_LIVENESS_CONFIG.graceMs;
    await sweeper.sweepNow();
    expect(stateOf(run.runId)).toBe("cancelled");
  });

  it("a SessionEnd arriving during the grace completes the Run and the later sweep applies nothing (Test 2)", async () => {
    table.spawn(PID, LSTART);
    const run = seedRun();
    const sweeper = sweeperWith();
    table.kill(PID);
    await sweeper.sweepNow();

    nowMs = T0 + 2_000;
    expect(
      await pipeline.ingest(
        {
          eventId: randomUUID(),
          observedAt: new Date(nowMs).toISOString(),
          hook_event_name: "SessionEnd",
          session_id: SESSION,
          reason: "prompt_input_exit",
          env: { CLAUDE_PID: String(PID) },
        },
        "socket",
      ),
    ).toBe("applied");
    expect(stateOf(run.runId)).toBe("completed");

    nowMs = T0 + DEFAULT_LIVENESS_CONFIG.graceMs + DEFAULT_LIVENESS_CONFIG.sweepMs;
    await sweeper.sweepNow();
    expect(appliedKinds(run.runId)).toEqual([]);
    expect(stateOf(run.runId)).toBe("completed");
  });

  it("a live pid whose lstart matches leaves a running Run alone (Test 3)", async () => {
    table.spawn(PID, LSTART);
    const run = seedRun();
    const sweeper = sweeperWith();
    for (let i = 0; i <= 4; i += 1) {
      nowMs = T0 + i * DEFAULT_LIVENESS_CONFIG.sweepMs;
      await sweeper.sweepNow();
    }
    expect(appliedKinds(run.runId)).toEqual([]);
    expect(stateOf(run.runId)).toBe("running");
  });

  it("a live pid whose lstart differs is treated as gone: PID reuse (Test 3, T-05-47)", async () => {
    table.spawn(PID, OTHER_LSTART);
    const run = seedRun();
    const sweeper = sweeperWith();
    await sweeper.sweepNow();
    expect(stateOf(run.runId)).toBe("running");
    nowMs = T0 + DEFAULT_LIVENESS_CONFIG.graceMs;
    await sweeper.sweepNow();
    expect(appliedKinds(run.runId)).toEqual(["pid-gone"]);
    expect(stateOf(run.runId)).toBe("stale");
  });

  it("start() sweeps on its timer and stop() ends it (key link: services stop chain)", async () => {
    const run = seedRun();
    const sweeper = sweeperWith({ sweepMs: 20, graceMs: 30 });
    nowMs = T0;
    sweeper.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    nowMs = T0 + 1_000;
    await new Promise((resolve) => setTimeout(resolve, 80));
    await sweeper.stop();
    expect(stateOf(run.runId)).toBe("stale");
    const count = applied.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(applied.length).toBe(count);
  });
});
