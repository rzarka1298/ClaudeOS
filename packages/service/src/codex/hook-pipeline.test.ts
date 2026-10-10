import { describe, expect, it } from "vitest";
import {
  HOOK_DECOYS,
  HOOK_MINUTE,
  HOOK_NOW,
  hookRecord,
  iso,
} from "../test-support/codex-hook-kit.js";
import {
  type CodexHookPipelineDeps,
  createCodexHookPipeline,
  HOOK_EVENT_IDS_CAP,
  HOOK_THREADS_CAP,
  type HookMirrorControl,
} from "./hook-pipeline.js";

interface Harness {
  readonly clock: { now: number };
  readonly known: Set<string>;
  readonly calls: { invalidate: number; poll: number };
  readonly subscribers: { count: number };
  readonly logged: Array<{ fields: Record<string, unknown>; message: string }>;
  readonly statusChanges: { count: number };
  readonly releasePoll: () => void;
  readonly pipeline: ReturnType<typeof createCodexHookPipeline>;
}

function harness(over: Partial<CodexHookPipelineDeps> = {}): Harness {
  const clock = { now: HOOK_NOW };
  const known = new Set<string>(["thread-a"]);
  const calls = { invalidate: 0, poll: 0 };
  const subscribers = { count: 1 };
  const logged: Harness["logged"] = [];
  const statusChanges = { count: 0 };
  let release: () => void = () => undefined;
  const control: HookMirrorControl = {
    knows: (threadId) => known.has(threadId),
    invalidate: () => {
      calls.invalidate += 1;
    },
    pollNow: () => {
      calls.poll += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  };
  const pipeline = createCodexHookPipeline({
    now: () => clock.now,
    mirrorControl: control,
    subscribers: () => subscribers.count,
    onStatusChange: () => {
      statusChanges.count += 1;
    },
    logger: {
      warn: (fields, message) => {
        logged.push({ fields: { ...fields }, message });
      },
    },
    ...over,
  });
  return {
    clock,
    known,
    calls,
    subscribers,
    logged,
    statusChanges,
    releasePoll: () => release(),
    pipeline,
  };
}

describe("Test 5: idempotency and bounds", () => {
  it("applies an event id once, answers duplicate the second time and requests one invalidate", async () => {
    const h = harness();
    const record = hookRecord();
    expect(await h.pipeline.ingest(record, "socket")).toBe("applied");
    expect(await h.pipeline.ingest(record, "spool")).toBe("duplicate");
    expect(h.calls.invalidate).toBe(1);
    expect(h.pipeline.stats()).toMatchObject({ applied: 1, duplicate: 1, invalid: 0 });
  });

  it("forgets the oldest event ids beyond 2,048 and evicts the oldest thread beyond 512", async () => {
    expect(HOOK_EVENT_IDS_CAP).toBe(2048);
    expect(HOOK_THREADS_CAP).toBe(512);
    const h = harness();
    const first = hookRecord({ session_id: "thread-0" });
    await h.pipeline.ingest(first, "socket");
    for (let n = 1; n <= HOOK_EVENT_IDS_CAP; n += 1) {
      await h.pipeline.ingest(hookRecord({ session_id: `thread-${n}` }), "socket");
    }
    // The first id fell out of the 2,048 newest, so it is applied (not duplicate) again.
    expect(await h.pipeline.ingest(first, "socket")).not.toBe("duplicate");
    // The first thread was evicted from the 512 newest, then re-added by the replay above.
    expect(h.pipeline.stats().evicted).toBeGreaterThan(0);
    expect(h.pipeline.latestFor("thread-1")).toBeUndefined();
    expect(h.pipeline.latestFor(`thread-${HOOK_EVENT_IDS_CAP}`)).toBeDefined();
  });
});

describe("Test 6: unknown threads and poll coalescing", () => {
  it("retains a record for an unlisted thread and requests no poll without subscribers", async () => {
    const h = harness();
    h.subscribers.count = 0;
    await h.pipeline.ingest(hookRecord({ session_id: "thread-new" }), "socket");
    expect(h.pipeline.latestFor("thread-new")?.event).toBe("Stop");
    expect(h.calls).toEqual({ invalidate: 0, poll: 0 });
  });

  it("requests exactly one poll for a burst of ten records while one is in flight", async () => {
    const h = harness();
    for (let n = 0; n < 10; n += 1) {
      await h.pipeline.ingest(
        hookRecord({ session_id: `thread-new-${n}`, observedAt: iso(HOOK_NOW) }),
        "socket",
      );
    }
    expect(h.calls.poll).toBe(1);
    expect(h.calls.invalidate).toBe(0);
    h.releasePoll();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await h.pipeline.ingest(hookRecord({ session_id: "thread-new-late" }), "socket");
    expect(h.calls.poll).toBe(2);
  });

  it("invalidates instead of polling when the thread is already listed", async () => {
    const h = harness();
    await h.pipeline.ingest(hookRecord(), "socket");
    expect(h.calls).toEqual({ invalidate: 1, poll: 0 });
  });
});

describe("Test 7: strictness and the retained shape", () => {
  const SMUGGLED: ReadonlyArray<Record<string, unknown>> = [
    { prompt: HOOK_DECOYS.prompt },
    { last_assistant_message: HOOK_DECOYS.message },
    { transcript_path: HOOK_DECOYS.transcript },
    { message: HOOK_DECOYS.message },
    { toolInput: HOOK_DECOYS.prompt },
  ];

  it.each(SMUGGLED)(
    "treats a record with an extra key %j as shape-invalid and keeps nothing",
    async (extra) => {
      const h = harness();
      expect(await h.pipeline.ingest(hookRecord(extra), "socket")).toBe("shape-invalid");
      expect(h.pipeline.latestFor("thread-a")).toBeUndefined();
      expect(h.pipeline.stats().invalid).toBe(1);
      expect(h.calls).toEqual({ invalidate: 0, poll: 0 });
      expect(h.statusChanges.count).toBe(0);
      expect(JSON.stringify(h.logged)).not.toContain("DECOY");
      expect(h.logged).toEqual([
        { fields: { reason: "shape-invalid" }, message: expect.any(String) },
      ]);
    },
  );

  it("retains exactly the five small fields, never the cwd, model, source or reason", async () => {
    const h = harness();
    await h.pipeline.ingest(
      hookRecord({
        hook_event_name: "SessionStart",
        cwd: HOOK_DECOYS.cwd,
        model: HOOK_DECOYS.model,
        source: "startup",
      }),
      "socket",
    );
    const retained = h.pipeline.latestFor("thread-a");
    expect(Object.keys(retained ?? {}).sort()).toEqual([
      "activityAt",
      "event",
      "receivedAt",
      "threadId",
      "turnId",
    ]);
    expect(JSON.stringify(retained)).not.toContain("DECOY");
  });

  it("rejects an invalid timestamp and a non-object envelope", async () => {
    const h = harness();
    expect(await h.pipeline.ingest(hookRecord({ observedAt: "not-a-date" }), "socket")).toBe(
      "shape-invalid",
    );
    for (const input of [null, "x", 7, [], undefined]) {
      expect(await h.pipeline.ingest(input, "socket")).toBe("envelope-invalid");
    }
    expect(h.pipeline.latestFor("thread-a")).toBeUndefined();
  });

  it("accepts a stale valid record without replacing the fact, but remembers its id", async () => {
    const h = harness();
    await h.pipeline.ingest(hookRecord({ hook_event_name: "UserPromptSubmit" }), "socket");
    const older = hookRecord({
      hook_event_name: "Stop",
      observedAt: iso(HOOK_NOW - HOOK_MINUTE),
    });
    const invalidations = h.calls.invalidate;
    expect(await h.pipeline.ingest(older, "spool")).toBe("applied");
    expect(h.pipeline.latestFor("thread-a")?.event).toBe("UserPromptSubmit");
    expect(h.calls.invalidate).toBe(invalidations);
    expect(await h.pipeline.ingest(older, "spool")).toBe("duplicate");
    expect(h.pipeline.stats().ignoredOlder).toBe(1);
  });

  it("keeps a Stop through a later SessionEnd and lets an unfinished turn end unknown", async () => {
    const h = harness();
    await h.pipeline.ingest(
      hookRecord({ hook_event_name: "Stop", observedAt: iso(HOOK_NOW - 5) }),
      "socket",
    );
    await h.pipeline.ingest(hookRecord({ hook_event_name: "SessionEnd" }), "socket");
    expect(h.pipeline.latestFor("thread-a")).toMatchObject({ event: "Stop", activityAt: HOOK_NOW });
    await h.pipeline.ingest(
      hookRecord({
        session_id: "thread-b",
        hook_event_name: "UserPromptSubmit",
        observedAt: iso(HOOK_NOW - 5),
      }),
      "socket",
    );
    await h.pipeline.ingest(
      hookRecord({ session_id: "thread-b", hook_event_name: "SessionEnd" }),
      "socket",
    );
    expect(h.pipeline.latestFor("thread-b")?.event).toBe("SessionEnd");
  });

  it("logs reason codes only and survives a throwing mirror control", async () => {
    const h = harness({
      mirrorControl: {
        knows: () => true,
        invalidate: () => {
          throw new Error(`boom ${HOOK_DECOYS.cwd}`);
        },
        pollNow: async () => undefined,
      },
    });
    expect(await h.pipeline.ingest(hookRecord({ cwd: HOOK_DECOYS.cwd }), "socket")).toBe("applied");
    expect(JSON.stringify(h.logged)).not.toContain("DECOY");
    expect(h.logged.every((entry) => Object.keys(entry.fields).join() === "reason")).toBe(true);
  });
});
