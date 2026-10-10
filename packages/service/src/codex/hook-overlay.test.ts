import {
  CODEX_SESSION_STATES,
  type CodexHookEvent,
  type CodexSessionState,
  type CodexSessionView,
} from "@ccc/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHookMirror,
  HOOK_MINUTE,
  HOOK_NOW,
  type HookMirrorKit,
  hookRecord,
  iso,
} from "../test-support/codex-hook-kit.js";
import { applyHookFact, createHookOverlay, hookTransition } from "./hook-overlay.js";
import {
  type CodexHookPipeline,
  createCodexHookPipeline,
  type HookFact,
  mirrorControlFor,
} from "./hook-pipeline.js";

const INACTIVITY = 30 * HOOK_MINUTE;
const min = (n: number): number => HOOK_NOW + n * HOOK_MINUTE;

let kit: HookMirrorKit | undefined;
afterEach(() => {
  kit?.home.cleanup();
  kit = undefined;
});

interface Rig extends HookMirrorKit {
  readonly pipeline: CodexHookPipeline;
  readonly invalidations: { count: number };
}

function rig(threads: Parameters<typeof buildHookMirror>[0]): Rig {
  const built = buildHookMirror(threads);
  kit = built;
  const control = mirrorControlFor(built.mirror);
  const invalidations = { count: 0 };
  const pipeline = createCodexHookPipeline({
    now: () => built.clock.now,
    mirrorControl: {
      knows: control.knows,
      invalidate: () => {
        invalidations.count += 1;
        control.invalidate();
      },
      pollNow: control.pollNow,
    },
    subscribers: () => built.subscribers.count,
  });
  built.mirror.addOverlay(
    createHookOverlay({ pipeline, now: () => built.clock.now, inactivityMs: INACTIVITY }),
  );
  return { ...built, pipeline, invalidations };
}

function session(r: Rig, id = "thread-a") {
  const snapshot = r.mirror.snapshot();
  if (snapshot === null || snapshot.kind !== "available") throw new Error("expected available");
  return snapshot.sessions.find((entry) => entry.threadId === id);
}

const RUNNING_THREAD = {
  id: "thread-a",
  agoMs: 10 * HOOK_MINUTE,
  lifecycle: [["task_started", 10 * HOOK_MINUTE]],
} as const;
const COMPLETED_THREAD = {
  id: "thread-a",
  agoMs: 60 * HOOK_MINUTE,
  lifecycle: [
    ["task_started", 70 * HOOK_MINUTE],
    ["task_complete", 60 * HOOK_MINUTE],
  ],
} as const;

describe("Test 1 (tracer): a Stop record flips a known session to completed through the overlay", () => {
  it("completes a session the rollout still reads as running, and never retains a smuggled prompt", async () => {
    const r = rig([RUNNING_THREAD]);
    await r.mirror.pollNow();
    expect(session(r)?.state).toBe("running");

    expect(await r.pipeline.ingest(hookRecord({ hook_event_name: "Stop" }), "socket")).toBe(
      "applied",
    );
    expect(session(r)?.state).toBe("completed");
    expect(r.invalidations.count).toBe(1);

    const smuggled = hookRecord({ prompt: "DECOY-PROMPT-TEXT-NOT-REAL" });
    expect(await r.pipeline.ingest(smuggled, "socket")).toBe("shape-invalid");
    expect(JSON.stringify(session(r))).not.toContain("DECOY-PROMPT-TEXT-NOT-REAL");
  });
});

describe("Test 2: event transitions through the mirror", () => {
  it("makes a completed session running on UserPromptSubmit and SessionStart", async () => {
    for (const event of ["UserPromptSubmit", "SessionStart"] as const) {
      const r = rig([COMPLETED_THREAD]);
      await r.mirror.pollNow();
      expect(session(r)?.state).toBe("completed");
      await r.pipeline.ingest(hookRecord({ hook_event_name: event }), "socket");
      expect(session(r)?.state).toBe("running");
      r.home.cleanup();
      kit = undefined;
    }
  });

  it("makes a running session cancelled on Interrupt", async () => {
    const r = rig([RUNNING_THREAD]);
    await r.mirror.pollNow();
    await r.pipeline.ingest(hookRecord({ hook_event_name: "Interrupt" }), "socket");
    expect(session(r)?.state).toBe("cancelled");
  });

  it("makes an unfinished turn unknown on SessionEnd, and keeps completed after a Stop", async () => {
    const unfinished = rig([RUNNING_THREAD]);
    await unfinished.mirror.pollNow();
    await unfinished.pipeline.ingest(hookRecord({ hook_event_name: "SessionEnd" }), "socket");
    expect(session(unfinished)?.state).toBe("stale");
    unfinished.home.cleanup();
    kit = undefined;

    const finished = rig([RUNNING_THREAD]);
    await finished.mirror.pollNow();
    await finished.pipeline.ingest(
      hookRecord({ hook_event_name: "Stop", observedAt: iso(min(-1)) }),
      "socket",
    );
    await finished.pipeline.ingest(hookRecord({ hook_event_name: "SessionEnd" }), "socket");
    expect(session(finished)?.state).toBe("completed");
    finished.home.cleanup();
    kit = undefined;

    const base = rig([COMPLETED_THREAD]);
    await base.mirror.pollNow();
    await base.pipeline.ingest(hookRecord({ hook_event_name: "SessionEnd" }), "socket");
    expect(session(base)?.state).toBe("completed");
  });
});

describe("Test 3: ordering by clamped event time, never by receipt time", () => {
  it("ignores a late older Stop after a newer UserPromptSubmit and requests no refresh for it", async () => {
    const r = rig([COMPLETED_THREAD]);
    r.clock.now = min(4);
    await r.mirror.pollNow();
    r.clock.now = min(3);
    await r.pipeline.ingest(
      hookRecord({ hook_event_name: "UserPromptSubmit", observedAt: iso(min(2)) }),
      "socket",
    );
    expect(session(r)?.state).toBe("running");
    expect(session(r)?.lastActivityAt).toBe(iso(min(2)));
    const invalidated = r.invalidations.count;

    r.clock.now = min(4);
    expect(
      await r.pipeline.ingest(
        hookRecord({ hook_event_name: "Stop", observedAt: iso(min(1)) }),
        "spool",
      ),
    ).toBe("applied");
    expect(session(r)?.state).toBe("running");
    expect(session(r)?.lastActivityAt).toBe(iso(min(2)));
    expect(r.invalidations.count).toBe(invalidated);
    // Receipt time stays diagnostic.
    expect(r.pipeline.lastEventAt()).toBe(min(4));
    expect(r.pipeline.latestFor("thread-a")?.receivedAt).toBe(min(3));
  });

  it("reaches the same final state when the older event arrives first", async () => {
    const r = rig([COMPLETED_THREAD]);
    r.clock.now = min(4);
    await r.mirror.pollNow();
    r.clock.now = min(3);
    await r.pipeline.ingest(
      hookRecord({ hook_event_name: "Stop", observedAt: iso(min(1)) }),
      "socket",
    );
    r.clock.now = min(4);
    await r.pipeline.ingest(
      hookRecord({ hook_event_name: "UserPromptSubmit", observedAt: iso(min(2)) }),
      "socket",
    );
    expect(session(r)?.state).toBe("running");
    expect(session(r)?.lastActivityAt).toBe(iso(min(2)));
  });

  it("ignores an event older than the session's last activity and never creates a session", async () => {
    const r = rig([RUNNING_THREAD]);
    await r.mirror.pollNow();
    const before = session(r);
    await r.pipeline.ingest(
      hookRecord({ hook_event_name: "Stop", observedAt: iso(HOOK_NOW - 20 * HOOK_MINUTE) }),
      "socket",
    );
    expect(session(r)).toEqual(before);
    await r.pipeline.ingest(hookRecord({ session_id: "thread-never-listed" }), "socket");
    expect(session(r, "thread-never-listed")).toBeUndefined();
  });

  it("clamps a future stamp to receipt so a real later event can replace it, and keeps the retained fact on a tie", async () => {
    const r = rig([RUNNING_THREAD]);
    r.clock.now = min(4);
    await r.pipeline.ingest(
      hookRecord({ hook_event_name: "Stop", observedAt: iso(min(30)) }),
      "socket",
    );
    expect(r.pipeline.latestFor("thread-a")?.activityAt).toBe(min(4));
    r.clock.now = min(5);
    await r.pipeline.ingest(
      hookRecord({ hook_event_name: "UserPromptSubmit", observedAt: iso(min(5)) }),
      "socket",
    );
    expect(r.pipeline.latestFor("thread-a")?.event).toBe("UserPromptSubmit");
    // Equal activityAt keeps the existing fact.
    await r.pipeline.ingest(
      hookRecord({ hook_event_name: "Interrupt", observedAt: iso(min(5)) }),
      "socket",
    );
    expect(r.pipeline.latestFor("thread-a")?.event).toBe("UserPromptSubmit");
  });
});

function view(over: Partial<CodexSessionView> = {}): CodexSessionView {
  return {
    threadId: "thread-a",
    projectId: null,
    projectName: null,
    origin: "interactive",
    state: "stale",
    model: null,
    effort: null,
    startedAt: iso(min(-60)),
    lastActivityAt: iso(min(-10)),
    resumesAfter: null,
    title: null,
    hasTranscript: true,
    liveLogRunId: null,
    ...over,
  };
}

function fact(event: CodexHookEvent, over: Partial<HookFact> = {}): HookFact {
  return {
    activityAt: HOOK_NOW,
    event,
    receivedAt: HOOK_NOW,
    threadId: "thread-a",
    turnId: "turn-1",
    ...over,
  };
}

const CONTEXT = { nowMs: HOOK_NOW, inactivityMs: INACTIVITY, limitHitAfter: false };

describe("Test 4: the rule table and precedence (table-driven)", () => {
  const TABLE: ReadonlyArray<readonly [CodexHookEvent, CodexSessionState, CodexSessionState]> = [
    ["SessionStart", "running", "running"],
    ["SessionStart", "stale", "running"],
    ["SessionStart", "completed", "running"],
    ["SessionStart", "cancelled", "running"],
    ["UserPromptSubmit", "running", "running"],
    ["UserPromptSubmit", "stale", "running"],
    ["UserPromptSubmit", "completed", "running"],
    ["UserPromptSubmit", "cancelled", "running"],
    ["Stop", "running", "completed"],
    ["Stop", "stale", "completed"],
    ["Stop", "completed", "completed"],
    ["Stop", "cancelled", "cancelled"],
    ["Interrupt", "running", "cancelled"],
    ["Interrupt", "stale", "cancelled"],
    ["Interrupt", "completed", "completed"],
    ["Interrupt", "cancelled", "cancelled"],
    ["SessionEnd", "running", "stale"],
    ["SessionEnd", "stale", "stale"],
    ["SessionEnd", "completed", "completed"],
    ["SessionEnd", "cancelled", "cancelled"],
  ];

  it.each(TABLE)("%s on %s gives %s", (event, from, to) => {
    expect(hookTransition(event, from)).toBe(to);
    expect(applyHookFact(view({ state: from }), fact(event), CONTEXT).state).toBe(to);
  });

  it("never changes a limit-paused or failed session, for any event", () => {
    for (const state of ["limit-paused", "failed"] as const) {
      for (const event of [
        "SessionStart",
        "UserPromptSubmit",
        "Stop",
        "Interrupt",
        "SessionEnd",
      ] as const) {
        const input = view({ state });
        expect(hookTransition(event, state)).toBe(state);
        expect(applyHookFact(input, fact(event), CONTEXT)).toEqual(input);
      }
    }
  });

  it("treats a limit hit after the last turn as explicit evidence that wins", () => {
    const input = view({ state: "running" });
    expect(applyHookFact(input, fact("Stop"), { ...CONTEXT, limitHitAfter: true })).toEqual(input);
  });

  it("covers every session state in the table or the locked set", () => {
    const covered = new Set<string>([...TABLE.map(([, from]) => from), "limit-paused", "failed"]);
    expect([...covered].sort()).toEqual([...CODEX_SESSION_STATES].sort());
  });

  it("ignores a fact older than the session's last activity or start, applies an equal one", () => {
    const input = view({ state: "running", lastActivityAt: iso(min(-1)) });
    expect(applyHookFact(input, fact("Stop", { activityAt: min(-2) }), CONTEXT)).toEqual(input);
    const equal = applyHookFact(input, fact("Stop", { activityAt: min(-1) }), CONTEXT);
    expect(equal.state).toBe("completed");
    expect(equal.lastActivityAt).toBe(iso(min(-1)));
    const young = view({ state: "stale", startedAt: iso(min(-1)), lastActivityAt: iso(min(-5)) });
    expect(applyHookFact(young, fact("Stop", { activityAt: min(-3) }), CONTEXT)).toEqual(young);
  });

  it("advances lastActivityAt to the fact and never moves it backwards", () => {
    const advanced = applyHookFact(view({ state: "running" }), fact("Stop"), CONTEXT);
    expect(advanced.lastActivityAt).toBe(iso(HOOK_NOW));
  });

  it("lets a running claim expire after the inactivity window but not a Stop", () => {
    const old = HOOK_NOW - INACTIVITY - HOOK_MINUTE;
    const quiet = view({ state: "completed", lastActivityAt: iso(old - HOOK_MINUTE) });
    expect(applyHookFact(quiet, fact("UserPromptSubmit", { activityAt: old }), CONTEXT)).toEqual(
      quiet,
    );
    const stale = view({ state: "stale", lastActivityAt: iso(old - HOOK_MINUTE) });
    expect(applyHookFact(stale, fact("Stop", { activityAt: old }), CONTEXT).state).toBe(
      "completed",
    );
  });

  it("returns the view untouched for a fact about another thread, and leaves the keys unchanged", () => {
    const input = view({ state: "running" });
    expect(applyHookFact(input, fact("Stop", { threadId: "other" }), CONTEXT)).toEqual(input);
    const out = applyHookFact(input, fact("Stop"), CONTEXT);
    expect(Object.keys(out).sort()).toEqual(Object.keys(input).sort());
  });

  it("createHookOverlay asks the pipeline for the view's thread only", () => {
    const latestFor = vi.fn(() => undefined);
    const overlay = createHookOverlay({
      pipeline: { latestFor },
      now: () => HOOK_NOW,
      inactivityMs: INACTIVITY,
    });
    const input = view();
    expect(overlay(input, { limitHitAfter: false })).toEqual(input);
    expect(latestFor).toHaveBeenCalledWith("thread-a");
  });
});
