import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newRunId,
  type RunId,
  type ServiceEvent,
  SessionUpsertedPayloadSchema,
  type SessionView,
} from "@ccc/domain";
import {
  applyMigrations,
  getSessionRun,
  type OperationalStore,
  openStore,
} from "@ccc/operational-store";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus, type EventBus } from "../events/event-bus.js";
import { classifyLaunchSource } from "./launch-source.js";
import {
  type ClaudePipeline,
  type ClaudePipelineDeps,
  COALESCE_WINDOW_MS,
  createClaudePipeline,
  type SessionFactsProvider,
} from "./pipeline.js";
import { createSessionFactsProvider, type ProcessFacts } from "./process-facts.js";

const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const LSTART = "Mon Sep 28 09:59:58 2026";
const PID = 4242;

const NULL_FACTS: SessionFactsProvider = {
  factsFor: async () => ({
    pidStartedAt: null,
    launchSource: null,
    projectId: null,
    worktreeRoot: null,
    transcriptPath: null,
  }),
};

/** A fake clock plus a scheduler on the same virtual time. */
function fakeTime() {
  let nowMs = T0;
  let tasks: { at: number; fn: () => void; cancelled: boolean }[] = [];
  return {
    now: () => new Date(nowMs),
    at: () => nowMs,
    schedule(fn: () => void, ms: number): () => void {
      const task = { at: nowMs + ms, fn, cancelled: false };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    advanceTo(ms: number): void {
      nowMs = ms;
      const due = tasks.filter((task) => task.at <= ms && !task.cancelled);
      tasks = tasks.filter((task) => !due.includes(task));
      for (const task of due) task.fn();
    },
  };
}

/** Lets queued pipeline work (a timer-fired flush) run to completion. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

let dir: string;
let store: OperationalStore;
let bus: EventBus;
let time: ReturnType<typeof fakeTime>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-pipe-"));
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
  bus = createEventBus();
  time = fakeTime();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function pipelineWith(overrides: Partial<ClaudePipelineDeps> = {}): ClaudePipeline {
  return createClaudePipeline({
    db: store.db,
    bus,
    logger: pino({ level: "silent" }),
    now: time.now,
    mintRunId: newRunId,
    facts: NULL_FACTS,
    schedule: time.schedule,
    ...overrides,
  });
}

function record(
  event: string,
  extra: Record<string, unknown> = {},
  sessionId = "sess-pipe-1",
): Record<string, unknown> {
  return {
    eventId: randomUUID(),
    observedAt: new Date(time.at()).toISOString(),
    hook_event_name: event,
    session_id: sessionId,
    env: { CLAUDE_PID: String(PID) },
    ...extra,
  };
}

function events(): ServiceEvent[] {
  const replay = bus.buffer.since(0);
  return replay.mode === "replay" ? replay.events : [];
}

function upserted(): SessionView[] {
  return events()
    .filter((event) => event.type === "session.upserted")
    .map((event) => SessionUpsertedPayloadSchema.parse(event.payload).session);
}

async function startRun(pipeline: ClaudePipeline): Promise<RunId> {
  expect(await pipeline.ingest(record("SessionStart", { source: "startup" }), "socket")).toBe(
    "applied",
  );
  const runId = upserted().at(-1)?.runId;
  if (runId === undefined) throw new Error("no run");
  return runId as RunId;
}

describe("dashboard resume attachment", () => {
  it.each([
    { state: "starting", hint: "missing" },
    { state: "stale", hint: "missing" },
    { state: "starting", hint: "parent" },
    { state: "stale", hint: "parent" },
  ])(
    "attaches a resume hook with a $hint run hint to its $state pending Run",
    async ({ state, hint }) => {
      const pipeline = pipelineWith({
        facts: {
          factsFor: async () => ({
            pidStartedAt: LSTART,
            launchSource: null,
            projectId: null,
            worktreeRoot: null,
            transcriptPath: null,
          }),
        },
      });
      const parentId = await startRun(pipeline);
      time.advanceTo(T0 + 1000);
      await pipeline.ingest(record("SessionEnd", { reason: "prompt_input_exit" }), "socket");
      time.advanceTo(T0 + 2000);
      const resumeId = newRunId();
      await pipeline.apply({
        kind: "launch-registered",
        runId: resumeId,
        claudeSessionId: "sess-pipe-1",
        linkKind: "resume",
        linkedFromRunId: parentId,
        cwd: dir,
        worktreeRoot: null,
        permissionMode: null,
        at: time.now().toISOString(),
      });
      await pipeline.apply({
        kind: "launch-started",
        runId: resumeId,
        at: time.now().toISOString(),
      });
      if (state === "stale") {
        await pipeline.apply({
          kind: "start-timeout",
          runId: resumeId,
          observedAt: time.now().toISOString(),
        });
      }
      time.advanceTo(T0 + 3000);
      await pipeline.ingest(
        record("SessionStart", {
          source: "resume",
          env: {
            CLAUDE_PID: String(PID + 1),
            ...(hint === "parent" ? { CCC_RUN_ID: parentId } : {}),
          },
        }),
        "socket",
      );

      expect(getSessionRun(store.db, resumeId)).toMatchObject({
        state: "running",
        pid: PID + 1,
        pidStartedAt: LSTART,
        claudeSessionId: "sess-pipe-1",
        linkKind: "resume",
        linkedFromRunId: parentId,
      });
      time.advanceTo(T0 + 4000);
      await pipeline.ingest(
        record("SessionStart", {
          source: "resume",
          env: { CLAUDE_PID: String(PID + 1), CCC_RUN_ID: resumeId },
        }),
        "socket",
      );
      await pipeline.ingest(
        record("UserPromptSubmit", {
          env: { CLAUDE_PID: String(PID + 1) },
        }),
        "socket",
      );
      expect(getSessionRun(store.db, resumeId)).toMatchObject({
        state: "running",
        activity: "working",
      });
      expect(getSessionRun(store.db, parentId)?.state).toBe("completed");
      expect(pipeline.listSessionViews()).toHaveLength(2);
      await pipeline.stop();
    },
  );
});

describe("shape degradation (Test 1, SESS-18, D-12)", () => {
  it("never applies a known event whose shape changed, and flags it until a later valid one", async () => {
    const pipeline = pipelineWith();
    const broken = record("SessionStart");
    expect(await pipeline.ingest(broken, "socket")).toBe("shape-invalid");
    expect(pipeline.listSessionViews()).toEqual([]);
    expect(events()).toEqual([]);
    expect(pipeline.health().shapeChanged).toBe("SessionStart");

    expect(await pipeline.ingest(record("Stop"), "socket")).toBe("applied");
    expect(pipeline.health().shapeChanged).toBe("SessionStart");

    expect(await pipeline.ingest(record("SessionStart", { source: "startup" }), "socket")).toBe(
      "applied",
    );
    expect(pipeline.health().shapeChanged).toBeNull();
  });

  it("counts an unknown event and changes nothing else", async () => {
    const pipeline = pipelineWith();
    expect(await pipeline.ingest(record("SomeFutureEvent"), "spool")).toBe("unknown-event");
    expect(pipeline.health()).toMatchObject({ unknownEventCount: 1, shapeChanged: null });
    expect(events()).toEqual([]);
    expect(pipeline.listSessionViews()).toEqual([]);
  });

  it("reports an invalid envelope without applying anything", async () => {
    const pipeline = pipelineWith();
    expect(await pipeline.ingest({ hook_event_name: "Stop" }, "spool")).toBe("envelope-invalid");
    expect(events()).toEqual([]);
  });
});

describe("idempotency on eventId (Test 2, D-08)", () => {
  it("applies a record once whether it arrives twice over the socket and once from the spool", async () => {
    const pipeline = pipelineWith();
    const runId = await startRun(pipeline);
    const permission = record("PermissionRequest");
    expect(await pipeline.ingest(permission, "socket")).toBe("applied");
    expect(await pipeline.ingest(permission, "socket")).toBe("duplicate");
    expect(await pipeline.ingest(permission, "spool")).toBe("duplicate");
    expect(getSessionRun(store.db, runId)).toMatchObject({
      revision: 2,
      state: "waiting-for-approval",
    });
    expect(upserted()).toHaveLength(2);
  });
});

describe("tool-event coalescing (Test 3, PR-05)", () => {
  it("holds 50 activity-only events inside the window, then writes and publishes once", async () => {
    const pipeline = pipelineWith();
    const runId = await startRun(pipeline);
    expect(await pipeline.ingest(record("UserPromptSubmit"), "socket")).toBe("applied");
    const before = getSessionRun(store.db, runId);
    const published = upserted().length;
    expect(before).toMatchObject({ activity: "working", revision: 2 });

    let lastAt = "";
    for (let i = 1; i <= 50; i += 1) {
      time.advanceTo(T0 + i * 80);
      const tool = record("PostToolUse", { tool_name: "Read" });
      lastAt = tool.observedAt as string;
      expect(await pipeline.ingest(tool, "socket")).toBe("applied");
    }
    expect(upserted()).toHaveLength(published);
    expect(getSessionRun(store.db, runId)).toEqual(before);

    time.advanceTo(T0 + COALESCE_WINDOW_MS);
    await drain();
    expect(upserted()).toHaveLength(published + 1);
    const after = getSessionRun(store.db, runId);
    expect(after).toMatchObject({ revision: 3, lastActivityAt: lastAt, activity: "working" });
    expect(upserted().at(-1)?.lastActivityAt).toBe(lastAt);
  });

  it("publishes a state change at once, carrying the pending activity, and drops the pending flush", async () => {
    const pipeline = pipelineWith();
    const runId = await startRun(pipeline);
    await pipeline.ingest(record("UserPromptSubmit"), "socket");
    const published = upserted().length;
    for (let i = 1; i <= 20; i += 1) {
      time.advanceTo(T0 + i * 80);
      await pipeline.ingest(record("PostToolUse", { tool_name: "Read" }), "socket");
    }
    expect(upserted()).toHaveLength(published);

    time.advanceTo(T0 + 2000);
    const permission = record("PermissionRequest");
    await pipeline.ingest(permission, "socket");
    expect(upserted()).toHaveLength(published + 1);
    expect(upserted().at(-1)).toMatchObject({
      state: "waiting-for-approval",
      revision: 3,
      lastActivityAt: permission.observedAt,
    });

    time.advanceTo(T0 + COALESCE_WINDOW_MS * 2);
    await drain();
    expect(upserted()).toHaveLength(published + 1);
    expect(getSessionRun(store.db, runId)?.revision).toBe(3);
  });

  it("writes an activity-only event at once when the Run has not been written for a full window", async () => {
    const pipeline = pipelineWith();
    await startRun(pipeline);
    await pipeline.ingest(record("UserPromptSubmit"), "socket");
    const published = upserted().length;
    time.advanceTo(T0 + COALESCE_WINDOW_MS + 1);
    await pipeline.ingest(record("PostToolUse", { tool_name: "Read" }), "socket");
    expect(upserted()).toHaveLength(published + 1);
  });

  it("flushes pending activity on stop()", async () => {
    const pipeline = pipelineWith();
    const runId = await startRun(pipeline);
    await pipeline.ingest(record("UserPromptSubmit"), "socket");
    time.advanceTo(T0 + 500);
    const tool = record("PostToolUse", { tool_name: "Read" });
    await pipeline.ingest(tool, "socket");
    await pipeline.stop();
    expect(getSessionRun(store.db, runId)?.lastActivityAt).toBe(tool.observedAt);
  });

  it("keeps held activity and re-arms the flush when the coalesced write fails, with no unhandled rejection", async () => {
    const pipeline = pipelineWith();
    const runId = await startRun(pipeline);
    await pipeline.ingest(record("UserPromptSubmit"), "socket");
    time.advanceTo(T0 + 500);
    const tool = record("PostToolUse", { tool_name: "Read" });
    await pipeline.ingest(tool, "socket");
    const published = upserted().length;

    store.db.exec(
      "CREATE TEMP TRIGGER fail_run_write BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    time.advanceTo(T0 + COALESCE_WINDOW_MS);
    await drain();
    expect(upserted()).toHaveLength(published);
    expect(getSessionRun(store.db, runId)?.lastActivityAt).not.toBe(tool.observedAt);

    store.db.exec("DROP TRIGGER fail_run_write");
    time.advanceTo(T0 + COALESCE_WINDOW_MS * 2);
    await drain();
    expect(upserted()).toHaveLength(published + 1);
    expect(getSessionRun(store.db, runId)?.lastActivityAt).toBe(tool.observedAt);
  });
});

describe("shutdown ordering (wave 3 review)", () => {
  it("stop() resolves only after in-flight ingests have been applied", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pipeline = pipelineWith({
      facts: {
        factsFor: async (rec) => {
          if (rec.hook_event_name === "SessionStart") await gate;
          return NULL_FACTS.factsFor(rec);
        },
      },
    });
    const ingest = pipeline.ingest(record("SessionStart", { source: "startup" }), "socket");
    let stopped = false;
    const stopping = pipeline.stop().then(() => {
      stopped = true;
    });
    await drain();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(await ingest).toBe("applied");
    expect(upserted()).toHaveLength(1);
    expect(pipeline.listSessionViews()).toHaveLength(1);
  });

  it("writes an activity-only change at once after stop() instead of holding it", async () => {
    const pipeline = pipelineWith();
    const runId = await startRun(pipeline);
    await pipeline.ingest(record("UserPromptSubmit"), "socket");
    await pipeline.stop();
    time.advanceTo(T0 + 500);
    const tool = record("PostToolUse", { tool_name: "Read" });
    expect(await pipeline.ingest(tool, "socket")).toBe("applied");
    expect(getSessionRun(store.db, runId)?.lastActivityAt).toBe(tool.observedAt);
  });
});

describe("facts at SessionStart (Test 5, D-19, PR-28)", () => {
  function factsPipeline(projectsRoot: string): {
    pipeline: ClaudePipeline;
    lstartCalls: number[][];
  } {
    const lstartCalls: number[][] = [];
    const processFacts: ProcessFacts = {
      isAlive: () => true,
      readStartTimes: async (pids) => {
        lstartCalls.push([...pids]);
        return new Map(pids.map((pid) => [pid, LSTART]));
      },
      readTty: async () => null,
      readAncestry: async () => [],
    };
    const facts = createSessionFactsProvider({
      processFacts,
      claudeProjectsRoot: projectsRoot,
      logger: pino({ level: "silent" }),
    });
    return { pipeline: pipelineWith({ facts }), lstartCalls };
  }

  it("stores the pid's lstart and a transcript path contained under <claude-config>/projects", async () => {
    const projectsRoot = join(dir, "claude", "projects");
    mkdirSync(join(projectsRoot, "demo"), { recursive: true });
    const { pipeline, lstartCalls } = factsPipeline(projectsRoot);
    await pipeline.ingest(
      record("SessionStart", {
        source: "startup",
        transcript_path: join(projectsRoot, "demo", "t.jsonl"),
      }),
      "socket",
    );
    const view = upserted().at(-1);
    const run = getSessionRun(store.db, view?.runId as RunId);
    expect(run?.pidStartedAt).toBe(LSTART);
    expect(run?.transcriptPath).toMatch(/\/claude\/projects\/demo\/t\.jsonl$/);
    expect(view?.hasTranscript).toBe(true);
    expect(lstartCalls).toEqual([[PID]]);
  });

  it("stores null for a transcript path outside the root or escaping it through a symlink", async () => {
    const projectsRoot = join(dir, "claude", "projects");
    mkdirSync(projectsRoot, { recursive: true });
    mkdirSync(join(dir, "outside"), { recursive: true });
    symlinkSync(join(dir, "outside"), join(projectsRoot, "evil"));
    const { pipeline } = factsPipeline(projectsRoot);
    const candidates = [join(dir, "outside", "t.jsonl"), join(projectsRoot, "evil", "t.jsonl")];
    for (const [i, transcriptPath] of candidates.entries()) {
      await pipeline.ingest(
        record(
          "SessionStart",
          { source: "startup", transcript_path: transcriptPath },
          `sess-out-${i}`,
        ),
        "socket",
      );
      const view = upserted().at(-1);
      expect(view?.claudeSessionId).toBe(`sess-out-${i}`);
      expect(getSessionRun(store.db, view?.runId as RunId)?.transcriptPath).toBeNull();
      expect(view?.hasTranscript).toBe(false);
    }
  });

  it("marks a dashboard launch only when the hook forwarded CCC_LAUNCH_SOURCE=dashboard", async () => {
    const projectsRoot = join(dir, "claude", "projects");
    mkdirSync(projectsRoot, { recursive: true });
    const { pipeline } = factsPipeline(projectsRoot);
    await pipeline.ingest(
      record(
        "SessionStart",
        { source: "startup", env: { CLAUDE_PID: "77", CCC_LAUNCH_SOURCE: "dashboard" } },
        "sess-dash",
      ),
      "socket",
    );
    expect(upserted().at(-1)?.launchSource).toBe("dashboard");
    await pipeline.ingest(
      record(
        "SessionStart",
        { source: "startup", env: { CLAUDE_PID: "78", CCC_LAUNCH_SOURCE: "other" } },
        "sess-term",
      ),
      "socket",
    );
    expect(upserted().at(-1)?.launchSource).toBeNull();
  });
});

describe("slow SessionStart facts run off the ingest queue (wave 4)", () => {
  it("applies the Run's state first, never waits on launch-source or attribution spawns, then writes them at revision + 1", async () => {
    store.db
      .prepare(
        "INSERT INTO projects (project_id, path, workspace_id, display_name, registered_at) VALUES (?, ?, NULL, ?, ?)",
      )
      .run("proj-slow", join(dir, "code"), "Slow", new Date(T0).toISOString());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processFacts: ProcessFacts = {
      isAlive: () => true,
      readStartTimes: async (pids) => new Map(pids.map((pid) => [pid, LSTART])),
      readTty: async () => "ttys001",
      readAncestry: async (pid) => {
        await gate;
        return [{ pid, ppid: 1, comm: "/bin/zsh" }];
      },
    };
    const facts = createSessionFactsProvider({
      processFacts,
      claudeProjectsRoot: join(dir, "claude", "projects"),
      logger: pino({ level: "silent" }),
      attribute: async () => {
        await gate;
        return { projectId: "proj-slow", worktreeRoot: join(dir, "code") };
      },
      classifyLaunchSource: (input) => classifyLaunchSource(input, processFacts),
    });
    const pipeline = pipelineWith({ facts });

    const start = record("SessionStart", { source: "startup", cwd: join(dir, "code") });
    expect(await pipeline.ingest(start, "socket")).toBe("applied");
    // The next record is not held behind the gated spawns either.
    expect(await pipeline.ingest(record("UserPromptSubmit"), "socket")).toBe("applied");
    const before = upserted().at(-1);
    expect(before?.state).toBe("running");
    expect(before?.launchSource).toBeNull(); // Not reported yet: never a guess
    expect(before?.projectId).toBeNull();
    const runId = before?.runId as RunId;
    const revisionBefore = getSessionRun(store.db, runId)?.revision ?? 0;

    release();
    await vi.waitFor(() => {
      const run = getSessionRun(store.db, runId);
      expect(run?.launchSource).toBe("terminal");
      expect(run?.projectId).toBe("proj-slow");
    });
    const after = getSessionRun(store.db, runId);
    expect(after?.state).toBe("running");
    expect(after?.revision).toBe(revisionBefore + 1);
    expect(upserted().at(-1)).toMatchObject({ launchSource: "terminal", projectId: "proj-slow" });
    await pipeline.stop();
  });

  it("stop() waits for a follow-up still resolving, so nothing writes after the store may close", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pipeline = pipelineWith({
      facts: {
        factsFor: NULL_FACTS.factsFor,
        deferredFactsFor: async () => {
          await gate;
          return { launchSource: "external", projectId: null, worktreeRoot: null };
        },
      },
    });
    await pipeline.ingest(record("SessionStart", { source: "startup" }), "socket");
    let stopped = false;
    const stopping = pipeline.stop().then(() => {
      stopped = true;
    });
    await drain();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(upserted().at(-1)?.launchSource).toBe("external");
  });
});

describe("ordering and settling", () => {
  it("applies one session's events in arrival order even when facts resolve slowly", async () => {
    const slow: SessionFactsProvider = {
      factsFor: (hook) =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve(NULL_FACTS.factsFor(hook) as never),
            hook.hook_event_name === "SessionStart" ? 30 : 0,
          ),
        ),
    };
    const pipeline = pipelineWith({ facts: slow });
    const first = pipeline.ingest(record("SessionStart", { source: "startup" }), "socket");
    const second = pipeline.ingest(record("SessionEnd", { reason: "other" }), "socket");
    await Promise.all([first, second]);
    const views = pipeline.listSessionViews();
    expect(views).toHaveLength(1);
    expect(views[0]?.state).toBe("completed");
  });

  it("tells run-settled listeners after Stop and SessionEnd, and not after other events", async () => {
    const pipeline = pipelineWith();
    const settled: string[] = [];
    const unsubscribe = pipeline.onRunSettled((run) => settled.push(run.state));
    await startRun(pipeline);
    await pipeline.ingest(record("UserPromptSubmit"), "socket");
    await pipeline.ingest(record("Stop"), "socket");
    await pipeline.ingest(record("SessionEnd", { reason: "other" }), "socket");
    expect(settled).toEqual(["running", "completed"]);
    unsubscribe();
  });
});

describe("Codex 3: deferred attribution from a superseded record is discarded", () => {
  it("a follow-up for cwd A that resolves after cwd B's leaves B's project and worktree", async () => {
    const gates = new Map<string, () => void>();
    const waitFor = (cwd: string) =>
      new Promise<void>((resolve) => {
        gates.set(cwd, resolve);
      });
    const cwdA = join(dir, "alpha");
    const cwdB = join(dir, "beta");
    for (const [projectId, root] of [
      ["proj-a", cwdA],
      ["proj-b", cwdB],
    ] as const) {
      store.db
        .prepare(
          "INSERT INTO projects (project_id, path, workspace_id, display_name, registered_at) VALUES (?, ?, NULL, ?, ?)",
        )
        .run(projectId, root, projectId, new Date(T0).toISOString());
    }
    const pipeline = pipelineWith({
      facts: {
        factsFor: NULL_FACTS.factsFor,
        deferredFactsFor: (hook) => {
          const cwd = hook.cwd;
          if (cwd === undefined) return null;
          const opened = waitFor(cwd);
          return opened.then(() => ({
            launchSource: null,
            projectId: cwd === cwdA ? "proj-a" : "proj-b",
            worktreeRoot: cwd,
          }));
        },
      },
    });
    await pipeline.ingest(record("SessionStart", { source: "startup", cwd: cwdA }), "socket");
    await pipeline.ingest(record("UserPromptSubmit", { cwd: cwdB }), "socket");
    const runId = upserted().at(-1)?.runId as RunId;
    expect(getSessionRun(store.db, runId)?.cwd).toBe(cwdB);

    gates.get(cwdB)?.();
    await vi.waitFor(() => {
      expect(getSessionRun(store.db, runId)?.projectId).toBe("proj-b");
    });
    gates.get(cwdA)?.();
    await pipeline.stop();

    expect(getSessionRun(store.db, runId)).toMatchObject({
      cwd: cwdB,
      projectId: "proj-b",
      worktreeRoot: cwdB,
    });
  });
});

describe("status-line metadata ordering (Codex 05-codex-2)", () => {
  const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

  it("a snapshot older than one already merged cannot roll the metadata back", async () => {
    const pipeline = pipelineWith();
    const runId = await startRun(pipeline);
    time.advanceTo(T0 + 60_000);
    expect(
      await pipeline.applyStatusMetadata({
        claudeSessionId: "sess-pipe-1",
        observedAt: at(30_000),
        model: "new-model",
      }),
    ).toBe(true);
    expect(
      await pipeline.applyStatusMetadata({
        claudeSessionId: "sess-pipe-1",
        observedAt: at(10_000),
        model: "old-model",
      }),
    ).toBe(false);
    expect(getSessionRun(store.db, runId)?.model).toBe("new-model");
  });

  it("a snapshot that predates the Run's start cannot overwrite its metadata", async () => {
    const pipeline = pipelineWith();
    const runId = await startRun(pipeline);
    expect(
      await pipeline.applyStatusMetadata({
        claudeSessionId: "sess-pipe-1",
        observedAt: at(-60_000),
        model: "stale-model",
      }),
    ).toBe(false);
    expect(getSessionRun(store.db, runId)?.model).not.toBe("stale-model");
  });

  it("a future-dated snapshot cannot freeze later metadata updates", async () => {
    const pipeline = pipelineWith();
    const runId = await startRun(pipeline);
    time.advanceTo(T0 + 60_000);
    await pipeline.applyStatusMetadata({
      claudeSessionId: "sess-pipe-1",
      observedAt: at(10 * 365 * 24 * 3_600_000),
      model: "skewed-model",
    });
    time.advanceTo(T0 + 120_000);
    expect(
      await pipeline.applyStatusMetadata({
        claudeSessionId: "sess-pipe-1",
        observedAt: at(100_000),
        model: "real-model",
      }),
    ).toBe(true);
    expect(getSessionRun(store.db, runId)?.model).toBe("real-model");
  });
});
