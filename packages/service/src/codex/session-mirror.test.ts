import { CodexSessionsSnapshotSchema, CodexSessionViewSchema } from "@ccc/domain";
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
import { defaultHeadroomTimers } from "./headroom-service.js";
import {
  type CodexSessionMirror,
  type CodexSessionMirrorDeps,
  createCodexSessionMirror,
} from "./session-mirror.js";
import { createCodexStoreReader } from "./store-reader.js";

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
  readonly thread?: Partial<FakeThread>;
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
}

function build(specs: readonly Spec[], over: Partial<CodexSessionMirrorDeps> = {}): Built {
  const threads: FakeThread[] = specs.map((spec) => ({
    id: spec.id,
    updatedAtMs: at(spec.agoMs),
    ...spec.thread,
  }));
  home = createFakeCodexHome({
    rollouts: specs.map((spec) => ({
      day: "2026-10-06",
      name: `rollout-${spec.id}.jsonl`,
      content: rolloutContent(
        rolloutMetaLine({ id: spec.id, atMs: at(spec.agoMs + MINUTE) }),
        ...(spec.lines ?? []),
      ),
      mtimeMs: at(spec.agoMs),
    })),
    database: { ddl: "current", threads },
  });
  const recorded = recordingFs();
  const port = createCodexHomePort({ root: home.root, fs: recorded.fs });
  const clock = { now: NOW };
  const reader = createCodexStoreReader({ port, now: () => clock.now });
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
  it("is live right after a poll, cached within three intervals and stale after", async () => {
    const built = build([{ id: "thread-a", agoMs: MINUTE, lines: [completed(MINUTE)] }]);
    expect(built.mirror.snapshot()).toBeNull();
    await built.mirror.pollNow();
    expect(available(built.mirror).freshness).toBe("live");
    built.clock.now = NOW + INTERVAL;
    expect(available(built.mirror).freshness).toBe("live");
    built.clock.now = NOW + 2 * INTERVAL;
    expect(available(built.mirror).freshness).toBe("cached");
    built.clock.now = NOW + 3 * INTERVAL;
    expect(available(built.mirror).freshness).toBe("cached");
    built.clock.now = NOW + 3 * INTERVAL + 1;
    expect(available(built.mirror).freshness).toBe("stale");
    expect(available(built.mirror).observedAt).toBe(new Date(NOW).toISOString());
  });
});
