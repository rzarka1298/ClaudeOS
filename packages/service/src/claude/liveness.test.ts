import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evidence } from "@ccc/collectors";
import {
  newRunId,
  type RunId,
  type SessionRun,
  SessionUpsertedPayloadSchema,
  type SessionView,
} from "@ccc/domain";
import {
  applyMigrations,
  getSessionOverride,
  getSessionRun,
  type OperationalStore,
  openStore,
  upsertSessionRun,
} from "@ccc/operational-store";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus, type EventBus } from "../events/event-bus.js";
import { recoverInterruptedRuns } from "../lifecycle/recover-runs.js";
import { createAttribution } from "./attribution.js";
import { runGit } from "./git-readonly.js";
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
import { createProcessFacts, nodeExecFile, type ProcessFacts } from "./process-facts.js";
import { createStoreProjectLookup } from "./project-lookup.js";
import { startClaudeServices } from "./services.js";

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
let bus: EventBus;
let table: ReturnType<typeof fakeProcessTable>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-liveness-"));
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
  nowMs = T0;
  applied = [];
  table = fakeProcessTable();
  bus = createEventBus();
  pipeline = createClaudePipeline({
    db: store.db,
    bus,
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
  const spied: Pick<ClaudePipeline, "apply" | "reattribute"> = {
    apply: (evidence) => {
      applied.push(evidence);
      return pipeline.apply(evidence);
    },
    reattribute: (runId, attribution) => pipeline.reattribute(runId, attribution),
  };
  return createLivenessSweeper({
    db: store.db,
    pipeline: spied,
    processFacts: table.facts,
    logger: pino({ level: "silent" }),
    now: () => new Date(nowMs),
    config: { ...DEFAULT_LIVENESS_CONFIG, ...config },
    attribute: createAttribution({
      lookup: createStoreProjectLookup(store.db),
      getOverride: (claudeSessionId) => getSessionOverride(store.db, claudeSessionId),
      realpath,
      runGit,
      logger: pino({ level: "silent" }),
    }),
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

  it("compares start times as instants: a legacy local-time lstart matches the same instant read in UTC (wave 4)", async () => {
    const legacy = "Mon Sep 29 09:59:58 2026"; // rendered in the system zone before TZ=UTC
    const sameInstant = new Date(2026, 8, 29, 9, 59, 58).toISOString();
    table.spawn(PID, sameInstant);
    const run = seedRun({ pidStartedAt: legacy, state: "stale" });
    const sweeper = sweeperWith();
    await sweeper.sweepNow();
    expect(appliedKinds(run.runId)).toEqual(["pid-alive"]);
    expect(stateOf(run.runId)).toBe("running");
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

function publishedFor(runId: RunId): SessionView[] {
  const replay = bus.buffer.since(0);
  const events = replay.mode === "replay" ? replay.events : [];
  return events
    .filter((event) => event.type === "session.upserted")
    .map((event) => SessionUpsertedPayloadSchema.parse(event.payload).session)
    .filter((session) => session.runId === runId);
}

describe("restart revival (Task 3 Test 2, D-22, PR-12)", () => {
  const saved = {
    runtime: process.env.CCC_RUNTIME_DIR,
    config: process.env.CLAUDE_CONFIG_DIR,
    spool: process.env.CCC_SPOOL_PATH,
  };
  const children: ChildProcess[] = [];

  beforeEach(() => {
    process.env.CCC_RUNTIME_DIR = dir;
    process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
    delete process.env.CCC_SPOOL_PATH;
  });

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    for (const [key, value] of [
      ["CCC_RUNTIME_DIR", saved.runtime],
      ["CLAUDE_CONFIG_DIR", saved.config],
      ["CCC_SPOOL_PATH", saved.spool],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** A throwaway idle child standing in for a Claude process; only this test signals it. */
  async function spawnChild(): Promise<ChildProcess> {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(child);
    await new Promise<void>((resolveSpawn, reject) => {
      child.once("spawn", () => resolveSpawn());
      child.once("error", reject);
    });
    return child;
  }

  it("revives only the identity-verified live pid before startClaudeServices resolves", async () => {
    const logger = pino({ level: "silent" });
    const facts = createProcessFacts({
      execFile: nodeExecFile,
      kill: (pid, signal) => {
        process.kill(pid, signal);
      },
      logger,
    });
    const live = await spawnChild();
    const doomed = await spawnChild();
    const livePid = live.pid as number;
    const doomedPid = doomed.pid as number;
    const starts = await facts.readStartTimes([livePid, doomedPid]);
    const exited = new Promise<void>((resolveExit) => doomed.once("exit", () => resolveExit()));
    doomed.kill("SIGKILL");
    await exited;

    const recent = new Date(Date.now() - 60_000).toISOString();
    const alive = seedRun({
      claudeSessionId: "sess-live",
      pid: livePid,
      pidStartedAt: starts.get(livePid) ?? null,
      startedAt: recent,
      lastActivityAt: recent,
    });
    const dead = seedRun({
      claudeSessionId: "sess-dead",
      pid: doomedPid,
      pidStartedAt: starts.get(doomedPid) ?? null,
      startedAt: recent,
      lastActivityAt: recent,
    });
    expect(alive.pidStartedAt).not.toBeNull();

    recoverInterruptedRuns(store.db, logger);
    expect(stateOf(alive.runId)).toBe("stale");
    expect(stateOf(dead.runId)).toBe("stale");

    const services = await startClaudeServices({
      store,
      bus: createEventBus(),
      logger,
      env: { CCC_LIVENESS_SWEEP_MS: "60000" },
    });
    try {
      expect(stateOf(alive.runId)).toBe("running");
      expect(stateOf(dead.runId)).toBe("stale");
      for (const run of [alive, dead]) {
        expect(["completed", "failed", "cancelled"]).not.toContain(stateOf(run.runId));
      }
    } finally {
      await services.stop();
    }
  });
});

describe("start and PID-less inactivity timeouts (Task 3 Test 3, D-19)", () => {
  it("a queued or starting Run past the start timeout with no SessionStart reads stale", async () => {
    const old = new Date(T0 - DEFAULT_LIVENESS_CONFIG.startTimeoutMs).toISOString();
    const queued = seedRun({
      pid: null,
      pidStartedAt: null,
      state: "queued",
      startedAt: old,
      lastActivityAt: null,
    });
    const starting = seedRun({
      pid: null,
      pidStartedAt: null,
      state: "starting",
      startedAt: old,
      lastActivityAt: null,
    });
    const young = seedRun({
      pid: null,
      pidStartedAt: null,
      state: "queued",
      startedAt: new Date(T0 - 1_000).toISOString(),
      lastActivityAt: null,
    });
    await sweeperWith().sweepNow();
    expect(appliedKinds(queued.runId)).toEqual(["start-timeout"]);
    expect(appliedKinds(starting.runId)).toEqual(["start-timeout"]);
    expect(stateOf(queued.runId)).toBe("stale");
    expect(stateOf(starting.runId)).toBe("stale");
    expect(appliedKinds(young.runId)).toEqual([]);
    expect(stateOf(young.runId)).toBe("queued");
  });

  it("a PID-less running Run idle past the inactivity threshold reads stale", async () => {
    const idle = seedRun({
      claudeSessionId: "sess-idle",
      pid: null,
      pidStartedAt: null,
      lastActivityAt: new Date(T0 - DEFAULT_LIVENESS_CONFIG.pidlessInactivityMs - 1).toISOString(),
    });
    const busy = seedRun({
      claudeSessionId: "sess-busy",
      pid: null,
      pidStartedAt: null,
      lastActivityAt: new Date(T0 - 60_000).toISOString(),
    });
    await sweeperWith().sweepNow();
    expect(appliedKinds(idle.runId)).toEqual(["inactivity-timeout"]);
    expect(stateOf(idle.runId)).toBe("stale");
    expect(appliedKinds(busy.runId)).toEqual([]);
    expect(stateOf(busy.runId)).toBe("running");
  });
});

describe("re-attribution when the registered project set changes (Task 3 Test 4, D-23)", () => {
  it("re-attributes unclassified live and 7-day-recent Runs once, and leaves older ones alone", async () => {
    const root = join(realpathSync(dir), "proj");
    mkdirSync(join(root, "src"), { recursive: true });
    const cwd = join(root, "src");
    const live = seedRun({ claudeSessionId: "sess-a", pid: null, pidStartedAt: null, cwd });
    const recentEnd = seedRun({
      claudeSessionId: "sess-b",
      pid: null,
      pidStartedAt: null,
      cwd,
      state: "completed",
      activity: null,
      endedAt: new Date(T0 - 24 * 60 * 60 * 1000).toISOString(),
    });
    const oldEnd = seedRun({
      claudeSessionId: "sess-c",
      pid: null,
      pidStartedAt: null,
      cwd,
      state: "completed",
      activity: null,
      startedAt: new Date(T0 - 9 * 24 * 60 * 60 * 1000).toISOString(),
      endedAt: new Date(T0 - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const sweeper = sweeperWith();
    await sweeper.sweepNow();
    expect(getSessionRun(store.db, live.runId)?.projectId).toBeNull();

    // Test seeding only: product code never writes `projects` (D-57).
    store.db
      .prepare(
        "INSERT INTO projects (project_id, path, workspace_id, display_name, registered_at) VALUES (?, ?, NULL, ?, ?)",
      )
      .run("proj", root, "Proj", "2026-09-29T00:00:00.000Z");
    nowMs += DEFAULT_LIVENESS_CONFIG.sweepMs;
    await sweeper.sweepNow();

    const after = getSessionRun(store.db, live.runId);
    expect(after?.projectId).toBe("proj");
    expect(after?.revision).toBe(live.revision + 1);
    expect(after?.state).toBe("running");
    expect(publishedFor(live.runId)).toHaveLength(1);
    expect(publishedFor(live.runId)[0]?.projectId).toBe("proj");
    expect(getSessionRun(store.db, recentEnd.runId)?.projectId).toBe("proj");
    expect(getSessionRun(store.db, recentEnd.runId)?.state).toBe("completed");
    expect(getSessionRun(store.db, oldEnd.runId)?.projectId).toBeNull();
    expect(getSessionRun(store.db, oldEnd.runId)?.revision).toBe(oldEnd.revision);

    // An unchanged project set re-attributes nothing more.
    nowMs += DEFAULT_LIVENESS_CONFIG.sweepMs;
    await sweeper.sweepNow();
    expect(publishedFor(live.runId)).toHaveLength(1);
  });
});
