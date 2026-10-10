import { appendFileSync } from "node:fs";
import {
  CodexSessionsSnapshotSchema,
  CodexSessionsUpdatedPayloadSchema,
  CodexSessionViewSchema,
} from "@ccc/domain";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attribution, AttributionInput } from "../claude/attribution.js";
import {
  createFakeCodexHome,
  type FakeCodexHome,
  type FakeThread,
  recordingFs,
  rolloutContent,
  rolloutLifecycleLine,
  rolloutMetaLine,
} from "../test-support/fake-codex-home.js";
import { createCodexHomePort } from "./codex-home.js";
import { defaultHeadroomTimers, type HeadroomTimers } from "./headroom-service.js";
import {
  type CodexSessionMirror,
  type CodexSessionMirrorDeps,
  createCodexSessionMirror,
  resolveCodexInactivityMs,
  type SessionOverlay,
} from "./session-mirror.js";
import {
  type CodexStoreReader,
  createCodexStoreReader,
  type OpenDatabase,
  type ReadThreadsInput,
  type ThreadsRead,
} from "./store-reader.js";

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const MINUTE = 60_000;
const INTERVAL = 5000;
const CWD_A = "/Users/USERNAME/repo-a";
const CWD_B = "/Users/USERNAME/repo-b";

let home: FakeCodexHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

interface Spec {
  readonly id: string;
  readonly agoMs: number;
  /** Rollout lines; omitted means a lifecycle-free rollout with only a meta line. */
  readonly lines?: readonly string[];
  /** Replaces the whole rollout content (no meta line is added). */
  readonly content?: string;
  /** How much older than the thread's update the rollout file's mtime is (the canary input). */
  readonly mtimeExtraAgoMs?: number;
  readonly thread?: Partial<FakeThread>;
}

interface Extras {
  readonly ddl?: "current" | "changed";
  readonly openDatabase?: OpenDatabase;
}

const at = (agoMs: number): number => NOW - agoMs;

function started(agoMs: number, turn = "turn-1"): string {
  return rolloutLifecycleLine("task_started", at(agoMs), turn);
}
function completed(agoMs: number, turn = "turn-1"): string {
  return rolloutLifecycleLine("task_complete", at(agoMs), turn);
}
function aborted(agoMs: number, turn = "turn-1"): string {
  return rolloutLifecycleLine("turn_aborted", at(agoMs), turn);
}

interface Built {
  readonly mirror: CodexSessionMirror;
  readonly clock: { now: number };
  readonly attributeCalls: AttributionInput[];
  readonly publish: ReturnType<typeof vi.fn>;
  readonly fsCalls: ReadonlyArray<{ op: string; path: string }>;
  readonly home: FakeCodexHome;
  readonly deps: CodexSessionMirrorDeps;
}

function build(
  specs: readonly Spec[],
  over: Partial<CodexSessionMirrorDeps> = {},
  extras: Extras = {},
): Built {
  const threads: FakeThread[] = specs.map((spec) => ({
    id: spec.id,
    updatedAtMs: at(spec.agoMs),
    ...spec.thread,
  }));
  home = createFakeCodexHome({
    rollouts: specs.map((spec) => ({
      day: "2026-10-06",
      name: `rollout-${spec.id}.jsonl`,
      content:
        spec.content ??
        rolloutContent(
          rolloutMetaLine({ id: spec.id, atMs: at(spec.agoMs + MINUTE) }),
          ...(spec.lines ?? []),
        ),
      mtimeMs: at(spec.agoMs + (spec.mtimeExtraAgoMs ?? 0)),
    })),
    database: { ddl: extras.ddl ?? "current", threads },
  });
  const recorded = recordingFs();
  const port = createCodexHomePort({ root: home.root, fs: recorded.fs });
  const clock = { now: NOW };
  const reader = createCodexStoreReader({
    port,
    now: () => clock.now,
    ...(extras.openDatabase === undefined ? {} : { openDatabase: extras.openDatabase }),
  });
  const attributeCalls: AttributionInput[] = [];
  const publish = vi.fn();
  const deps: CodexSessionMirrorDeps = {
    port,
    reader,
    attribute: async (input): Promise<Attribution> => {
      attributeCalls.push(input);
      return {
        projectId: input.cwd === CWD_A ? "proj-a" : null,
        worktreeRoot: null,
        reason: input.cwd === CWD_A ? "project-root" : "no-match",
      };
    },
    projectName: (projectId) => (projectId === "proj-a" ? "Project A" : null),
    analysisOn: () => false,
    subscribers: () => 1,
    publish,
    now: () => clock.now,
    timers: defaultHeadroomTimers,
    pollIntervalMs: INTERVAL,
    ...over,
  };
  return {
    deps,
    mirror: createCodexSessionMirror(deps),
    clock,
    attributeCalls,
    publish,
    fsCalls: recorded.calls,
    home,
  };
}

function available(mirror: CodexSessionMirror) {
  const snapshot = mirror.snapshot();
  if (snapshot === null || snapshot.kind !== "available") throw new Error("expected available");
  return snapshot;
}

const VIEW_KEYS = Object.keys(CodexSessionViewSchema.shape).sort();

describe("Test 1 (tracer): threads and rollouts become attributed sessions with honest states", () => {
  it("produces running, stale, completed and cancelled sessions with the right attribution", async () => {
    const built = build([
      {
        id: "thread-run",
        agoMs: 2 * MINUTE,
        lines: [started(3 * MINUTE)],
        thread: { cwd: CWD_A, model: "gpt-synthetic", reasoningEffort: "high" },
      },
      {
        id: "thread-stale",
        agoMs: 40 * MINUTE,
        lines: [started(41 * MINUTE)],
        thread: { cwd: CWD_B, model: "bad<model>", reasoningEffort: "low" },
      },
      {
        id: "thread-done",
        agoMs: 60 * MINUTE,
        lines: [started(70 * MINUTE), completed(60 * MINUTE)],
        thread: { cwd: CWD_B },
      },
      {
        id: "thread-abort",
        agoMs: 90 * MINUTE,
        lines: [started(95 * MINUTE), aborted(90 * MINUTE)],
        thread: { cwd: CWD_B, source: "exec" },
      },
    ]);
    expect(built.mirror.snapshot()).toBeNull();
    await built.mirror.pollNow();
    const snapshot = available(built.mirror);
    expect(CodexSessionsSnapshotSchema.safeParse(snapshot).success).toBe(true);

    const byId = new Map(snapshot.sessions.map((session) => [session.threadId, session]));
    expect(byId.get("thread-run")).toMatchObject({
      state: "running",
      projectId: "proj-a",
      projectName: "Project A",
      origin: "interactive",
      model: "gpt-synthetic",
      effort: "high",
      title: null,
      hasTranscript: true,
      resumesAfter: null,
      liveLogRunId: null,
    });
    expect(byId.get("thread-stale")).toMatchObject({
      state: "stale",
      projectId: null,
      projectName: null,
      model: null,
      effort: "low",
    });
    expect(byId.get("thread-done")?.state).toBe("completed");
    expect(byId.get("thread-abort")).toMatchObject({ state: "cancelled", origin: "headless" });
    expect(byId.get("thread-run")?.startedAt).toBe(new Date(at(2 * MINUTE + 1000)).toISOString());
    expect(byId.get("thread-run")?.lastActivityAt).toBe(new Date(at(2 * MINUTE)).toISOString());

    // Attribution never carries a Claude session id.
    expect(built.attributeCalls.length).toBeGreaterThan(0);
    for (const call of built.attributeCalls) expect(call.claudeSessionId).toBeNull();
  });

  it("gives every session exactly the domain key set and no path, rollout name or account field", async () => {
    const built = build([
      { id: "thread-a", agoMs: MINUTE, lines: [started(2 * MINUTE)], thread: { cwd: CWD_A } },
      {
        id: "thread-b",
        agoMs: 50 * MINUTE,
        lines: [completed(50 * MINUTE)],
        thread: { cwd: CWD_B },
      },
    ]);
    await built.mirror.pollNow();
    const snapshot = available(built.mirror);
    expect(snapshot.sessions.length).toBe(2);
    for (const session of snapshot.sessions) expect(Object.keys(session).sort()).toEqual(VIEW_KEYS);
    const text = JSON.stringify(snapshot);
    for (const fragment of [
      "/Users/",
      CWD_A,
      CWD_B,
      "rollout-",
      ".jsonl",
      built.home.root,
      "creator",
    ]) {
      expect(text).not.toContain(fragment);
    }
  });

  it("keeps cwd and rollout path private: only resolveThread reaches the rollout path", async () => {
    const built = build([{ id: "thread-a", agoMs: MINUTE, lines: [started(2 * MINUTE)] }]);
    await built.mirror.pollNow();
    const resolved = built.mirror.resolveThread("thread-a");
    expect(resolved?.rolloutPath).toBe(
      built.home.rolloutPath("2026-10-06", "rollout-thread-a.jsonl"),
    );
    expect(built.mirror.resolveThread("unknown-thread")).toBeNull();
  });
});

describe("Test 2: the sub-agent trap and the lifecycle-free thread", () => {
  it("resolves a sub-agent rollout that begins with the parent's turn by its last event", async () => {
    const built = build([
      {
        id: "thread-sub",
        agoMs: 3 * MINUTE,
        lines: [
          started(30 * MINUTE, "turn-parent"),
          started(10 * MINUTE, "turn-own"),
          completed(3 * MINUTE, "turn-own"),
        ],
      },
    ]);
    await built.mirror.pollNow();
    expect(available(built.mirror).sessions[0]?.state).toBe("completed");
  });

  it("does not list a lifecycle-free thread while fresh, and lists it stale when old", async () => {
    const built = build([
      { id: "thread-fresh", agoMs: MINUTE },
      { id: "thread-old", agoMs: 3 * 60 * MINUTE },
    ]);
    await built.mirror.pollNow();
    const snapshot = available(built.mirror);
    expect(snapshot.sessions.map((session) => [session.threadId, session.state])).toEqual([
      ["thread-old", "stale"],
    ]);
    expect(snapshot.hiddenCount).toBe(1);
  });
});

describe("Test 4: ordering, the cap and the seven day window", () => {
  it("orders by state then newest activity first", async () => {
    const built = build([
      { id: "c-old", agoMs: 80 * MINUTE, lines: [completed(80 * MINUTE)] },
      { id: "c-new", agoMs: 60 * MINUTE, lines: [completed(60 * MINUTE)] },
      { id: "x-new", agoMs: 70 * MINUTE, lines: [started(71 * MINUTE), aborted(70 * MINUTE)] },
      { id: "s-new", agoMs: 45 * MINUTE, lines: [started(46 * MINUTE)] },
      { id: "r-old", agoMs: 4 * MINUTE, lines: [started(5 * MINUTE)] },
      { id: "r-new", agoMs: 1 * MINUTE, lines: [started(2 * MINUTE)] },
    ]);
    await built.mirror.pollNow();
    expect(available(built.mirror).sessions.map((session) => session.threadId)).toEqual([
      "r-new",
      "r-old",
      "s-new",
      "c-new",
      "c-old",
      "x-new",
    ]);
  });

  it("caps at 200 sessions and counts the overflow in hiddenCount", async () => {
    const specs: Spec[] = Array.from({ length: 205 }, (_, index) => ({
      id: `thread-${String(index).padStart(3, "0")}`,
      agoMs: (index + 1) * MINUTE,
      lines: [completed((index + 1) * MINUTE)],
    }));
    const built = build(specs, {
      limits: { maxThreads: 300, maxRolloutReadsPerPoll: 500, maxBytesPerPoll: 50 * 1024 * 1024 },
    });
    await built.mirror.pollNow();
    const snapshot = available(built.mirror);
    expect(snapshot.sessions).toHaveLength(200);
    expect(snapshot.hiddenCount).toBe(5);
    expect(CodexSessionsSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("does not read threads older than seven days", async () => {
    const built = build([
      { id: "thread-recent", agoMs: 5 * MINUTE, lines: [completed(5 * MINUTE)] },
      {
        id: "thread-ancient",
        agoMs: 8 * 24 * 60 * MINUTE,
        lines: [completed(8 * 24 * 60 * MINUTE)],
      },
    ]);
    await built.mirror.pollNow();
    expect(available(built.mirror).sessions.map((session) => session.threadId)).toEqual([
      "thread-recent",
    ]);
    expect(built.fsCalls.some((call) => call.path.includes("thread-ancient"))).toBe(false);
  });
});

describe("Test 5: snapshot freshness follows the age of the last successful poll", () => {
  it("is live right after a poll, cached up to three intervals and stale after", async () => {
    const built = build([{ id: "thread-a", agoMs: MINUTE, lines: [completed(MINUTE)] }]);
    expect(built.mirror.snapshot()).toBeNull();
    await built.mirror.pollNow();
    expect(available(built.mirror).freshness).toBe("live");
    built.clock.now = NOW + INTERVAL;
    expect(available(built.mirror).freshness).toBe("live");
    built.clock.now = NOW + 2 * INTERVAL;
    expect(available(built.mirror).freshness).toBe("live");
    built.clock.now = NOW + 2 * INTERVAL + 1;
    expect(available(built.mirror).freshness).toBe("cached");
    built.clock.now = NOW + 3 * INTERVAL;
    expect(available(built.mirror).freshness).toBe("cached");
    built.clock.now = NOW + 3 * INTERVAL + 1;
    expect(available(built.mirror).freshness).toBe("stale");
    expect(available(built.mirror).observedAt).toBe(new Date(NOW).toISOString());
  });
});

// ---------------------------------------------------------------------------
// Task 2: scheduling, gating, publication, the analysis flag, unavailable
// states and the overlay seam.

interface FakeTimers {
  readonly timers: HeadroomTimers;
  readonly handlers: Array<() => void>;
  readonly intervals: number[];
  readonly cleared: unknown[];
  fire(): void;
}

function fakeTimers(): FakeTimers {
  const handlers: Array<() => void> = [];
  const intervals: number[] = [];
  const cleared: unknown[] = [];
  return {
    handlers,
    intervals,
    cleared,
    timers: {
      setInterval(fn, ms) {
        handlers.push(fn);
        intervals.push(ms);
        return handlers.length;
      },
      clearInterval(handle) {
        cleared.push(handle);
        handlers.length = 0;
      },
    },
    fire() {
      for (const fn of [...handlers]) fn();
    },
  };
}

interface Control {
  override: ThreadsRead | null;
  throwWith: Error | null;
  keep: number | null;
  calls: number;
  readonly inputs: ReadThreadsInput[];
}

/** A reader whose answers a test can switch, wrapped around the real one. */
function controlled(real: CodexStoreReader): { reader: CodexStoreReader; control: Control } {
  const control: Control = { override: null, throwWith: null, keep: null, calls: 0, inputs: [] };
  const reader: CodexStoreReader = {
    readThreads(input) {
      control.calls += 1;
      control.inputs.push(input);
      if (control.throwWith !== null) throw control.throwWith;
      if (control.override !== null) return control.override;
      const result = real.readThreads(input);
      if (control.keep !== null && result.kind === "ok") {
        return { ...result, threads: result.threads.slice(0, control.keep) };
      }
      return result;
    },
  };
  return { reader, control };
}

function recordingLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      warn(fields: { readonly reason: string }, message: string) {
        lines.push(JSON.stringify([fields, message]));
      },
    },
  };
}

function hasControlChar(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

const RUNNING_SPECS: readonly Spec[] = [
  { id: "thread-run", agoMs: 2 * MINUTE, lines: [started(3 * MINUTE)], thread: { cwd: CWD_A } },
  {
    id: "thread-done",
    agoMs: 60 * MINUTE,
    lines: [completed(60 * MINUTE)],
    thread: { cwd: CWD_B },
  },
];

describe("Test 1 (task 2): the poll timer is gated on subscribers", () => {
  it("never reads with zero subscribers, reads once there are some, and stop clears the timer", async () => {
    const t = fakeTimers();
    const subs = { n: 0 };
    const built = build(RUNNING_SPECS);
    const { reader, control } = controlled(built.deps.reader);
    const mirror = createCodexSessionMirror({
      ...built.deps,
      reader,
      timers: t.timers,
      subscribers: () => subs.n,
    });
    mirror.start();
    mirror.start();
    expect(t.handlers).toHaveLength(1);
    expect(t.intervals).toEqual([INTERVAL]);
    t.fire();
    await Promise.resolve();
    expect(control.calls).toBe(0);
    subs.n = 1;
    t.fire();
    await mirror.pollNow();
    expect(control.calls).toBe(1);
    expect(mirror.snapshot()?.kind).toBe("available");
    mirror.stop();
    expect(t.cleared).toHaveLength(1);
    t.fire();
    expect(control.calls).toBe(1);
  });

  it("refreshIfStale starts at most one poll, returns at once and snapshot never awaits", async () => {
    const built = build(RUNNING_SPECS);
    const { reader, control } = controlled(built.deps.reader);
    const mirror = createCodexSessionMirror({ ...built.deps, reader });
    expect(mirror.refreshIfStale()).toBeUndefined();
    mirror.refreshIfStale();
    expect(control.calls).toBe(1);
    expect(mirror.snapshot()).toBeNull();
    await mirror.pollNow();
    expect(control.calls).toBe(1);
    expect(mirror.snapshot()?.kind).toBe("available");
    mirror.refreshIfStale();
    expect(control.calls).toBe(1);
    built.clock.now = NOW + 3 * INTERVAL + 1;
    mirror.refreshIfStale();
    expect(control.calls).toBe(2);
    await mirror.pollNow();
  });
});

describe("Test 2 (task 2): publication happens only when the serialised snapshot changed", () => {
  it("publishes once for an identical poll and again after a real change, with a valid payload", async () => {
    const built = build(RUNNING_SPECS);
    await built.mirror.pollNow();
    expect(built.publish).toHaveBeenCalledTimes(1);
    const [type, payload] = built.publish.mock.calls[0] ?? [];
    expect(type).toBe("codex.sessions.updated");
    expect(CodexSessionsUpdatedPayloadSchema.safeParse(payload).success).toBe(true);
    built.clock.now = NOW + INTERVAL;
    await built.mirror.pollNow();
    expect(built.publish).toHaveBeenCalledTimes(1);
    appendFileSync(
      built.home.rolloutPath("2026-10-06", "rollout-thread-run.jsonl"),
      `${completed(1 * MINUTE)}\n`,
    );
    built.clock.now = NOW + 2 * INTERVAL;
    await built.mirror.pollNow();
    expect(built.publish).toHaveBeenCalledTimes(2);
    const last = built.publish.mock.calls[1]?.[1] as { sessions: Array<{ state: string }> };
    expect(last.sessions.map((session) => session.state)).toEqual(["completed", "completed"]);
  });
});

describe("Test 3 (task 2): titles exist only with transcript analysis on", () => {
  const TITLED: readonly Spec[] = [
    {
      id: "thread-t1",
      agoMs: MINUTE,
      lines: [completed(MINUTE)],
      thread: { title: `Fix\u0007 the\u001b[31m bug ${"x".repeat(300)}`, name: "SYNTHETIC-NAME" },
    },
    {
      id: "thread-t2",
      agoMs: 2 * MINUTE,
      lines: [completed(2 * MINUTE)],
      thread: { name: "SYNTHETIC-NAME-ONLY" },
    },
  ];

  function spy() {
    const sqls: string[] = [];
    const open: OpenDatabase = (path, options) => {
      const db = new Database(path, options);
      return {
        pragma: (source) => db.pragma(source),
        prepare: (sql) => {
          sqls.push(sql);
          return db.prepare(sql) as unknown as ReturnType<ReturnType<OpenDatabase>["prepare"]>;
        },
        close: () => db.close(),
      };
    };
    return { sqls, open };
  }

  it("selects and shows no title with the flag off", async () => {
    const { sqls, open } = spy();
    const built = build(TITLED, {}, { openDatabase: open });
    await built.mirror.pollNow();
    const select = sqls.filter((sql) => sql.includes("FROM threads"));
    expect(select.length).toBeGreaterThan(0);
    for (const sql of select) expect(sql).not.toMatch(/\b(title|name)\b/);
    const snapshot = available(built.mirror);
    expect(snapshot.analysisOn).toBe(false);
    for (const session of snapshot.sessions) expect(session.title).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain("SYNTHETIC-NAME");
  });

  it("shows a bounded, control-free title with the flag on and follows the flag without a restart", async () => {
    const flag = { on: true };
    const { open } = spy();
    const built = build(TITLED, { analysisOn: () => flag.on }, { openDatabase: open });
    await built.mirror.pollNow();
    const snapshot = available(built.mirror);
    expect(snapshot.analysisOn).toBe(true);
    const long = snapshot.sessions.find((session) => session.threadId === "thread-t1")?.title;
    expect(long).toBeTruthy();
    expect(long?.length).toBeLessThanOrEqual(200);
    expect(hasControlChar(long ?? "")).toBe(false);
    expect(long?.startsWith("Fix")).toBe(true);
    expect(snapshot.sessions.find((session) => session.threadId === "thread-t2")?.title).toBe(
      "SYNTHETIC-NAME-ONLY",
    );
    expect(CodexSessionsSnapshotSchema.safeParse(snapshot).success).toBe(true);
    flag.on = false;
    // Off takes effect for the cached snapshot at once, before any new poll.
    const immediately = available(built.mirror);
    expect(immediately.analysisOn).toBe(false);
    for (const session of immediately.sessions) expect(session.title).toBeNull();
    built.clock.now = NOW + INTERVAL;
    await built.mirror.pollNow();
    const off = available(built.mirror);
    expect(off.analysisOn).toBe(false);
    for (const session of off.sessions) expect(session.title).toBeNull();
  });
});

describe("Test 4 (task 2): a drifted store reads unavailable and recovers", () => {
  it("a failed shape gate is unavailable format-changed and is published", async () => {
    const built = build(RUNNING_SPECS, {}, { ddl: "changed" });
    await built.mirror.pollNow();
    expect(built.mirror.snapshot()).toEqual({
      kind: "unavailable",
      reason: "format-changed",
      version: null,
    });
    expect(built.publish).toHaveBeenCalledTimes(1);
    expect(
      CodexSessionsUpdatedPayloadSchema.safeParse(built.publish.mock.calls[0]?.[1]).success,
    ).toBe(true);
  });

  it("a failed rollout-freshness canary names the newest Codex version and a healthy poll recovers", async () => {
    const stale = 15 * MINUTE;
    const built = build(
      [
        { id: "t-1", agoMs: MINUTE, mtimeExtraAgoMs: stale, thread: { cliVersion: "0.158.0" } },
        { id: "t-2", agoMs: 2 * MINUTE, mtimeExtraAgoMs: stale, thread: { cliVersion: "0.159.2" } },
        { id: "t-3", agoMs: 3 * MINUTE, mtimeExtraAgoMs: stale, thread: { cliVersion: "0.159.2" } },
        { id: "t-4", agoMs: 4 * MINUTE, mtimeExtraAgoMs: stale, thread: { cliVersion: "0.157.0" } },
      ].map((spec) => ({ ...spec, lines: [completed(spec.agoMs)] })),
    );
    await built.mirror.pollNow();
    expect(built.mirror.snapshot()).toEqual({
      kind: "unavailable",
      reason: "format-changed",
      version: "0.159.2",
    });
    expect(built.publish).toHaveBeenCalledTimes(1);
  });

  it("a failed per-version recognition is unavailable naming that version, and recovers when rollouts are recognised", async () => {
    const drifted: Spec[] = Array.from({ length: 6 }, (_, index) => ({
      id: `t-drift-${index}`,
      agoMs: (index + 1) * MINUTE,
      content: `${JSON.stringify({ type: "synthetic_unknown_kind", n: index })}\n`,
      thread: { cliVersion: "0.160.0" },
    }));
    const built = build(
      [
        ...drifted,
        {
          id: "t-ok",
          agoMs: 10 * MINUTE,
          lines: [completed(10 * MINUTE)],
          thread: { cliVersion: "0.159.2" },
        },
      ],
      {},
    );
    await built.mirror.pollNow();
    expect(built.mirror.snapshot()).toEqual({
      kind: "unavailable",
      reason: "format-changed",
      version: "0.160.0",
    });
    for (const spec of drifted) {
      appendFileSync(
        built.home.rolloutPath("2026-10-06", `rollout-${spec.id}.jsonl`),
        `${rolloutMetaLine({ id: spec.id, atMs: NOW })}\n${completed(MINUTE)}\n`,
      );
    }
    built.clock.now = NOW + INTERVAL;
    await built.mirror.pollNow();
    expect(built.mirror.snapshot()?.kind).toBe("available");
    expect(built.publish).toHaveBeenCalledTimes(2);
  });
});

describe("Test 5 (task 2): busy, failed, absent and not-installed reads", () => {
  it("busy and read-failed reads keep the previous snapshot and let it age", async () => {
    for (const reason of ["busy", "read-failed"] as const) {
      const built = build(RUNNING_SPECS);
      const { reader, control } = controlled(built.deps.reader);
      const mirror = createCodexSessionMirror({ ...built.deps, reader });
      await mirror.pollNow();
      const before = available(mirror);
      control.override = { kind: "unavailable", reason, newestCliVersion: null };
      built.clock.now = NOW + INTERVAL;
      await mirror.pollNow();
      const during = available(mirror);
      expect(during.sessions).toEqual(before.sessions);
      expect(during.observedAt).toBe(before.observedAt);
      expect(during.freshness).toBe("live");
      built.clock.now = NOW + 3 * INTERVAL + 1;
      await mirror.pollNow();
      expect(available(mirror).freshness).toBe("stale");
      expect(built.publish).toHaveBeenCalledTimes(1);
      home?.cleanup();
      home = undefined;
    }
  });

  it("a busy read with no previous snapshot leaves no snapshot", async () => {
    const built = build(RUNNING_SPECS);
    const { reader, control } = controlled(built.deps.reader);
    control.override = { kind: "unavailable", reason: "busy", newestCliVersion: null };
    const mirror = createCodexSessionMirror({ ...built.deps, reader });
    await mirror.pollNow();
    expect(mirror.snapshot()).toBeNull();
    expect(built.publish).not.toHaveBeenCalled();
  });

  it("no store is unavailable no-data and is published", async () => {
    const built = build(RUNNING_SPECS);
    const { reader, control } = controlled(built.deps.reader);
    control.override = { kind: "unavailable", reason: "no-store", newestCliVersion: null };
    const mirror = createCodexSessionMirror({ ...built.deps, reader });
    await mirror.pollNow();
    expect(mirror.snapshot()).toEqual({ kind: "unavailable", reason: "no-data", version: null });
    expect(built.publish).toHaveBeenCalledTimes(1);
    expect(mirror.cacheSize()).toBe(0);
  });

  it("an uninstalled Codex is unavailable not-installed regardless of the store and reads nothing", async () => {
    const installed = { on: false };
    const built = build(RUNNING_SPECS);
    const { reader, control } = controlled(built.deps.reader);
    const mirror = createCodexSessionMirror({
      ...built.deps,
      reader,
      installed: () => installed.on,
    });
    await mirror.pollNow();
    expect(control.calls).toBe(0);
    expect(mirror.snapshot()).toEqual({
      kind: "unavailable",
      reason: "not-installed",
      version: null,
    });
    installed.on = true;
    built.clock.now = NOW + INTERVAL;
    await mirror.pollNow();
    expect(mirror.snapshot()?.kind).toBe("available");
  });
});

describe("Test 6 (task 2): overlays and invalidate", () => {
  it("applies overlays in order, ignores failing or invalid ones, and re-publishes on invalidate without a read", async () => {
    const built = build(RUNNING_SPECS);
    const { reader, control } = controlled(built.deps.reader);
    const mirror = createCodexSessionMirror({ ...built.deps, reader });
    await mirror.pollNow();
    expect(built.publish).toHaveBeenCalledTimes(1);
    const callsBefore = control.calls;

    const paused: SessionOverlay = (view) =>
      view.threadId === "thread-done" ? { ...view, state: "limit-paused" } : view;
    const one: SessionOverlay = (view) => ({ ...view, projectName: "One" });
    const two: SessionOverlay = (view) => ({ ...view, projectName: `${view.projectName}+Two` });
    const throwing: SessionOverlay = () => {
      throw new Error("overlay failed /Users/USERNAME/secret");
    };
    const widening: SessionOverlay = (view) => ({ ...view, cwd: "/Users/USERNAME/x" }) as never;
    const renaming: SessionOverlay = (view) => ({ ...view, threadId: "someone-else" });
    const titling: SessionOverlay = (view) => ({ ...view, title: "OVERLAY-TITLE" });
    const removeOne = mirror.addOverlay(one);
    mirror.addOverlay(throwing);
    mirror.addOverlay(widening);
    mirror.addOverlay(renaming);
    mirror.addOverlay(two);
    mirror.addOverlay(paused);
    mirror.addOverlay(titling);
    mirror.invalidate();

    expect(control.calls).toBe(callsBefore);
    expect(built.publish).toHaveBeenCalledTimes(2);
    const snapshot = available(mirror);
    expect(snapshot.sessions.map((session) => [session.threadId, session.state])).toEqual([
      ["thread-run", "running"],
      ["thread-done", "limit-paused"],
    ]);
    expect(snapshot.sessions.every((session) => session.projectName === "One+Two")).toBe(true);
    // The analysis flag is off, so an overlay can not smuggle a title in.
    expect(snapshot.sessions.every((session) => session.title === null)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("/Users/");
    expect(CodexSessionsSnapshotSchema.safeParse(snapshot).success).toBe(true);

    removeOne();
    mirror.invalidate();
    expect(available(mirror).sessions.map((session) => session.projectName)).toEqual([
      "Project A+Two",
      "null+Two",
    ]);
    expect(control.calls).toBe(callsBefore);
  });

  it("an overlay that throws never breaks a poll", async () => {
    const built = build(RUNNING_SPECS);
    built.mirror.addOverlay(() => {
      throw new Error("boom");
    });
    await built.mirror.pollNow();
    expect(available(built.mirror).sessions).toHaveLength(2);
  });
});

describe("Test 7 (task 2): the private cache is bounded", () => {
  it("evicts entries for threads that are no longer returned", async () => {
    const specs: Spec[] = Array.from({ length: 12 }, (_, index) => ({
      id: `thread-${String(index).padStart(2, "0")}`,
      agoMs: (index + 1) * MINUTE,
      lines: [completed((index + 1) * MINUTE)],
    }));
    const built = build(specs, { limits: { maxThreads: 10 } });
    const { reader, control } = controlled(built.deps.reader);
    const mirror = createCodexSessionMirror({ ...built.deps, reader });
    await mirror.pollNow();
    expect(mirror.cacheSize()).toBe(10);
    expect(mirror.resolveThread("thread-09")).not.toBeNull();
    control.keep = 4;
    built.clock.now = NOW + INTERVAL;
    await mirror.pollNow();
    expect(mirror.cacheSize()).toBe(4);
    expect(mirror.resolveThread("thread-09")).toBeNull();
    expect(mirror.resolveThread("thread-00")).not.toBeNull();
  });
});

describe("Test 8 (task 2): logs carry reason codes only", () => {
  it("a throwing read is contained and no log line has a path, cwd, rollout name or title", async () => {
    const rec = recordingLogger();
    const built = build(
      [
        {
          id: "thread-log",
          agoMs: MINUTE,
          lines: [completed(MINUTE)],
          thread: { cwd: CWD_A, title: "SYNTHETIC-TITLE-LOG" },
        },
      ],
      { logger: rec.logger, analysisOn: () => true },
    );
    const { reader, control } = controlled(built.deps.reader);
    const mirror = createCodexSessionMirror({ ...built.deps, reader, logger: rec.logger });
    mirror.addOverlay(() => {
      throw new Error(`overlay ${CWD_A}`);
    });
    await mirror.pollNow();
    control.throwWith = new Error(`read failed for ${CWD_A}/rollout-thread-log.jsonl`);
    built.clock.now = NOW + INTERVAL;
    await expect(mirror.pollNow()).resolves.toBeUndefined();
    expect(rec.lines.length).toBeGreaterThan(0);
    const text = rec.lines.join("\n");
    for (const fragment of [
      "/Users/",
      CWD_A,
      "rollout-",
      ".jsonl",
      "SYNTHETIC-TITLE-LOG",
      built.home.root,
    ]) {
      expect(text).not.toContain(fragment);
    }
    expect(text).toContain("reason");
  });
});

describe("Test 9 (task 2): per-poll work is bounded and carried over", () => {
  it("lists the newest rollouts first and the rest on later polls", async () => {
    const specs: Spec[] = Array.from({ length: 8 }, (_, index) => ({
      id: `thread-${index}`,
      agoMs: (index + 1) * MINUTE,
      lines: [completed((index + 1) * MINUTE)],
    }));
    const built = build(specs, { limits: { maxRolloutReadsPerPoll: 3 } });
    await built.mirror.pollNow();
    let snapshot = available(built.mirror);
    expect(snapshot.sessions.map((session) => session.threadId)).toEqual([
      "thread-0",
      "thread-1",
      "thread-2",
    ]);
    expect(snapshot.partiality.partial).toBe(true);
    expect(snapshot.hiddenCount).toBe(5);
    built.clock.now = NOW + INTERVAL;
    await built.mirror.pollNow();
    expect(available(built.mirror).sessions).toHaveLength(6);
    built.clock.now = NOW + 2 * INTERVAL;
    await built.mirror.pollNow();
    snapshot = available(built.mirror);
    expect(snapshot.sessions).toHaveLength(8);
    expect(snapshot.partiality.partial).toBe(false);
    expect(snapshot.hiddenCount).toBe(0);
  });
});

describe("resolveCodexInactivityMs", () => {
  it("defaults to thirty minutes and honours a valid override only", () => {
    expect(resolveCodexInactivityMs({})).toBe(30 * MINUTE);
    expect(resolveCodexInactivityMs({ CCC_CODEX_INACTIVITY_MS: "120000" })).toBe(120_000);
    for (const bad of ["", "abc", "-5", "0", "1.5", "9999999999999"]) {
      expect(resolveCodexInactivityMs({ CCC_CODEX_INACTIVITY_MS: bad })).toBe(30 * MINUTE);
    }
  });
});

// ---------------------------------------------------------------------------
// Plan 05.1-26: the additive overlay context and the tick hook (own block).

describe("plan 05.1-26: the overlay context and tick hooks", () => {
  it("passes the thread id, the limit-hit fact and the last lifecycle time to every overlay", async () => {
    const limitLine = JSON.stringify({
      type: "event_msg",
      timestamp: new Date(at(2 * MINUTE)).toISOString(),
      payload: { type: "error", message: "You hit a usage limit" },
    });
    const built = build([
      {
        id: "thread-limit",
        agoMs: 2 * MINUTE,
        lines: [started(3 * MINUTE), limitLine],
        thread: { cwd: CWD_A },
      },
      { id: "thread-plain", agoMs: 60 * MINUTE, lines: [completed(60 * MINUTE)] },
    ]);
    const seen: Array<{
      threadId: string;
      limitHitAfter: boolean;
      lastLifecycleAt: string | null;
    }> = [];
    built.mirror.addOverlay((view, context) => {
      seen.push({ ...context });
      expect(context.threadId).toBe(view.threadId);
      return view;
    });
    await built.mirror.pollNow();
    const byId = new Map(seen.map((entry) => [entry.threadId, entry]));
    expect(byId.get("thread-limit")).toEqual({
      threadId: "thread-limit",
      limitHitAfter: true,
      lastLifecycleAt: new Date(at(3 * MINUTE)).toISOString(),
    });
    expect(byId.get("thread-plain")).toEqual({
      threadId: "thread-plain",
      limitHitAfter: false,
      lastLifecycleAt: new Date(at(60 * MINUTE)).toISOString(),
    });
  });

  it("runs tick hooks on a subscriber-gated tick only, survives a throwing or rejecting hook, and removes a hook", async () => {
    const t = fakeTimers();
    const subs = { n: 0 };
    const built = build(RUNNING_SPECS);
    const mirror = createCodexSessionMirror({
      ...built.deps,
      timers: t.timers,
      subscribers: () => subs.n,
    });
    const order: string[] = [];
    const removeFirst = mirror.addTickHook(() => {
      order.push("first");
    });
    mirror.addTickHook(() => {
      order.push("throws");
      throw new Error("hook failed /Users/USERNAME/secret");
    });
    mirror.addTickHook(async () => {
      order.push("rejects");
      throw new Error("async hook failed");
    });
    mirror.addTickHook(() => {
      order.push("last");
    });
    mirror.start();

    t.fire();
    await Promise.resolve();
    expect(order).toEqual([]);

    subs.n = 1;
    t.fire();
    await mirror.pollNow();
    expect(order).toEqual(["first", "throws", "rejects", "last"]);
    expect(mirror.snapshot()?.kind).toBe("available");

    removeFirst();
    order.length = 0;
    t.fire();
    await mirror.pollNow();
    expect(order).toEqual(["throws", "rejects", "last"]);
    mirror.stop();
  });
});
