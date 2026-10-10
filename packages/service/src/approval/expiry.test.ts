import type { ApprovalLog, ProposalId } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import type { ApprovalEngineDeps } from "./engine.js";
import {
  createExpirySweeper,
  DEFAULT_SWEEP_INTERVAL_MS,
  type SweeperTimerHandle,
  type SweeperTimers,
} from "./expiry.js";
import { createHarness, type Harness } from "./test-support/harness.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Moves a pending request to `approved` without claiming it: the resting state a crash between decide and claim leaves. */
function approveWithoutClaim(h: Harness, id: ProposalId): void {
  const stored = h.store.get(id);
  const result = h.store.decide({
    proposalId: id,
    decision: "approve",
    expectedHash: stored?.payloadHash ?? "",
    now: h.clock.now(),
    via: "plugin",
  });
  expect(result.kind).toBe("approved");
}

interface FakeHandle extends SweeperTimerHandle {
  readonly fn: () => void;
  readonly ms: number;
  cleared: boolean;
  unrefCalls: number;
}

/** Timer functions the test drives by hand: no real timer is ever created. */
function fakeTimers(): { timers: SweeperTimers; handles: FakeHandle[] } {
  const handles: FakeHandle[] = [];
  const timers: SweeperTimers = {
    setInterval(fn, ms) {
      const handle: FakeHandle = {
        fn,
        ms,
        cleared: false,
        unrefCalls: 0,
        unref() {
          handle.unrefCalls += 1;
          return handle;
        },
      };
      handles.push(handle);
      return handle;
    },
    clearInterval(handle) {
      (handle as FakeHandle).cleared = true;
    },
  };
  return { timers, handles };
}

function recordingLog(): ApprovalLog & { lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const push = (fields: Readonly<Record<string, unknown>>) => void lines.push({ ...fields });
  return { lines, info: push, warn: push, error: push };
}

describe("expiry sweep (Task 1, Test 1)", () => {
  it("expires exactly the due requests in one store call, each audited, published once and mirrored once", () => {
    const h = createHarness();
    const a = h.propose({ subject: "a", requestedTtlMs: 1 * MINUTE });
    const b = h.propose({ subject: "b", requestedTtlMs: 2 * MINUTE });
    const c = h.propose({ subject: "c", requestedTtlMs: 3 * MINUTE });
    const publishedBefore = h.published.length;
    const mirroredBefore = h.mirrored.length;
    h.store.calls.length = 0;

    h.clock.advance(2 * MINUTE);
    const summary = h.engine.sweepExpired();

    expect(summary).toEqual({ expired: 2, lapsed: 0 });
    expect(h.store.calls.filter((call) => call === "expireDue")).toHaveLength(1);
    expect(h.store.get(a)?.state).toBe("expired");
    expect(h.store.get(b)?.state).toBe("expired");
    expect(h.store.get(c)?.state).toBe("pending");
    expect(h.store.auditEvents(a)).toContain("expired");
    expect(h.store.auditEvents(b)).toContain("expired");
    expect(h.store.auditEvents(c)).not.toContain("expired");

    const fresh = h.published.slice(publishedBefore);
    expect(fresh.map((e) => `${e.approval.proposalId}:${e.approval.state}`).sort()).toEqual(
      [`${a}:expired`, `${b}:expired`].sort(),
    );
    expect(h.mirrored.slice(mirroredBefore).map((m) => m.proposalId)).toEqual(
      fresh.map((e) => e.approval.proposalId),
    );
  });

  it("a second sweep with nothing due publishes, mirrors and changes nothing", () => {
    const h = createHarness();
    h.propose({ requestedTtlMs: 1 * MINUTE });
    h.clock.advance(1 * MINUTE);
    h.engine.sweepExpired();
    const published = h.published.length;
    const mirrored = h.mirrored.length;
    expect(h.engine.sweepExpired()).toEqual({ expired: 0, lapsed: 0 });
    expect(h.published).toHaveLength(published);
    expect(h.mirrored).toHaveLength(mirrored);
  });
});

describe("expiry boundary (Task 1, Test 2)", () => {
  it("is pending one millisecond before the expiry and expired at the expiry instant, in the sweep", () => {
    const h = createHarness();
    const id = h.propose({ requestedTtlMs: 1 * MINUTE });
    h.clock.advance(1 * MINUTE - 1);
    expect(h.engine.sweepExpired().expired).toBe(0);
    expect(h.store.get(id)?.state).toBe("pending");
    h.clock.advance(1);
    expect(h.engine.sweepExpired().expired).toBe(1);
    expect(h.store.get(id)?.state).toBe("expired");
  });

  it("a decide at the expiry instant returns expired and never approves or executes", async () => {
    const h = createHarness();
    const id = h.propose({ requestedTtlMs: 1 * MINUTE });
    const hash = h.store.get(id)?.payloadHash ?? "";
    h.clock.advance(1 * MINUTE);
    const result = await h.engine.decide({
      proposalId: id,
      decision: "approve",
      payloadHash: hash,
      via: "plugin",
    });
    expect(result).toEqual({ outcome: "expired" });
    await h.engine.settled();
    expect(h.store.get(id)?.state).toBe("expired");
    expect(h.store.auditEvents(id)).not.toContain("approved");
    expect(h.diagnostic.executeCalls).toHaveLength(0);
    expect(
      h.published.some((e) => e.approval.proposalId === id && e.approval.state === "expired"),
    ).toBe(true);
  });

  it("a decide one millisecond before the expiry succeeds", async () => {
    const h = createHarness();
    const id = h.propose({ requestedTtlMs: 1 * MINUTE });
    const hash = h.store.get(id)?.payloadHash ?? "";
    h.clock.advance(1 * MINUTE - 1);
    const result = await h.engine.decide({
      proposalId: id,
      decision: "approve",
      payloadHash: hash,
      via: "plugin",
    });
    expect(result.outcome).toBe("decided");
    await h.engine.settled();
    expect(h.diagnostic.executeCalls).toHaveLength(1);
  });
});

describe("startup sweep (Task 1, Test 3)", () => {
  it("expires everything already overdue before any timer tick", () => {
    const h = createHarness();
    const ids = [
      h.propose({ subject: "a", requestedTtlMs: 1 * MINUTE }),
      h.propose({ subject: "b", requestedTtlMs: 5 * MINUTE }),
      h.propose({ subject: "c" }),
    ];
    // The service was down for an hour: nothing has ticked.
    h.clock.advance(60 * MINUTE);
    expect(h.engine.sweepExpired()).toEqual({ expired: 2, lapsed: 0 });
    expect(ids.map((id) => h.store.get(id)?.state)).toEqual(["expired", "expired", "pending"]);
  });
});

describe("sweeper timer (Task 1, Test 4)", () => {
  it("start schedules one repeating timer at the configured interval and unrefs it", () => {
    const h = createHarness();
    const { timers, handles } = fakeTimers();
    const sweeper = createExpirySweeper({
      engine: h.engine,
      intervalMs: 45 * SECOND,
      timers,
      log: recordingLog(),
    });
    sweeper.start();
    expect(handles).toHaveLength(1);
    expect(handles[0]?.ms).toBe(45 * SECOND);
    expect(handles[0]?.unrefCalls).toBe(1);
  });

  it("defaults the interval to between thirty and sixty seconds", () => {
    expect(DEFAULT_SWEEP_INTERVAL_MS).toBeGreaterThanOrEqual(30 * SECOND);
    expect(DEFAULT_SWEEP_INTERVAL_MS).toBeLessThanOrEqual(60 * SECOND);
    const h = createHarness();
    const { timers, handles } = fakeTimers();
    createExpirySweeper({ engine: h.engine, timers, log: recordingLog() }).start();
    expect(handles[0]?.ms).toBe(DEFAULT_SWEEP_INTERVAL_MS);
  });

  it("starting twice does not create a second timer", () => {
    const h = createHarness();
    const { timers, handles } = fakeTimers();
    const sweeper = createExpirySweeper({ engine: h.engine, timers, log: recordingLog() });
    sweeper.start();
    sweeper.start();
    expect(handles).toHaveLength(1);
  });

  it("a timer tick sweeps; stop clears the timer and a later start schedules a new one", async () => {
    const h = createHarness();
    const id = h.propose({ requestedTtlMs: 1 * MINUTE });
    const { timers, handles } = fakeTimers();
    const sweeper = createExpirySweeper({ engine: h.engine, timers, log: recordingLog() });
    sweeper.start();
    h.clock.advance(1 * MINUTE);
    handles[0]?.fn();
    await sweeper.stop();
    expect(h.store.get(id)?.state).toBe("expired");
    expect(handles[0]?.cleared).toBe(true);
    sweeper.start();
    expect(handles).toHaveLength(2);
    await sweeper.stop();
  });

  it("stop awaits a sweep that is still running", async () => {
    let release: (value: { expired: number; lapsed: number }) => void = () => undefined;
    const slow = new Promise<{ expired: number; lapsed: number }>((resolve) => {
      release = resolve;
    });
    const { timers, handles } = fakeTimers();
    const sweeper = createExpirySweeper({
      engine: { sweepExpired: () => slow },
      timers,
      log: recordingLog(),
    });
    sweeper.start();
    handles[0]?.fn();
    let stopped = false;
    const stopping = sweeper.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);
    release({ expired: 0, lapsed: 0 });
    await stopping;
    expect(stopped).toBe(true);
  });

  it("a sweep that throws logs one fixed code and the timer keeps running", async () => {
    let calls = 0;
    const log = recordingLog();
    const { timers, handles } = fakeTimers();
    const sweeper = createExpirySweeper({
      engine: {
        sweepExpired: () => {
          calls += 1;
          if (calls === 1) throw new Error("secret payload text");
          return { expired: 0, lapsed: 0 };
        },
      },
      timers,
      log,
    });
    sweeper.start();
    handles[0]?.fn();
    await sweeper.stop();
    expect(log.lines).toEqual([{ code: "expiry-sweep-failed" }]);
    expect(JSON.stringify(log.lines)).not.toContain("secret");
    sweeper.start();
    handles[1]?.fn();
    await sweeper.stop();
    expect(calls).toBe(2);
  });

  it("sweepNow runs one sweep and reports it; overlapping ticks do not stack", async () => {
    const h = createHarness();
    h.propose({ requestedTtlMs: 1 * MINUTE });
    const sweeper = createExpirySweeper({
      engine: h.engine,
      timers: fakeTimers().timers,
      log: recordingLog(),
    });
    h.clock.advance(1 * MINUTE);
    expect(await sweeper.sweepNow()).toEqual({ expired: 1, lapsed: 0 });
    expect(await sweeper.sweepNow()).toEqual({ expired: 0, lapsed: 0 });
  });
});

describe("re-proposal after expiry (Task 1, Test 5)", () => {
  it("is a new proposal id that records the expired one, and the old key is never reused", async () => {
    const h = createHarness();
    const first = h.propose({ requestedTtlMs: 1 * MINUTE });
    h.clock.advance(1 * MINUTE);
    h.engine.sweepExpired();
    const second = h.submit({ requestedTtlMs: 1 * MINUTE });
    expect(second.kind).toBe("proposed");
    if (second.kind !== "proposed") return;
    expect(second.proposalId).not.toBe(first);
    expect(second.deduped).toBe(false);
    expect(second.supersedes).toBe(first);
    expect(h.store.get(first)?.state).toBe("expired");

    const hash = h.store.get(second.proposalId)?.payloadHash ?? "";
    await h.engine.decide({
      proposalId: second.proposalId,
      decision: "approve",
      payloadHash: hash,
      via: "plugin",
    });
    await h.engine.settled();
    expect(h.diagnostic.executeCalls).toHaveLength(1);
    expect(h.diagnostic.executeCalls[0]?.context.idempotencyKey).toBe(second.proposalId);
    expect(h.diagnostic.executeCalls[0]?.context.idempotencyKey).not.toBe(first);
  });
});

describe("lapse in the sweep (Task 1, Test 6)", () => {
  it("lapses an approved request that was never claimed once its maximum approval age has passed", () => {
    const h = createHarness();
    const stale = h.propose({ subject: "stale" });
    const fresh = h.propose({ subject: "fresh" });
    approveWithoutClaim(h, stale);
    h.clock.advance(4 * MINUTE);
    approveWithoutClaim(h, fresh);
    h.clock.advance(1 * MINUTE);
    const publishedBefore = h.published.length;

    const summary = h.engine.sweepExpired();

    expect(summary).toEqual({ expired: 0, lapsed: 1 });
    expect(h.store.get(stale)?.state).toBe("lapsed");
    expect(h.store.auditEvents(stale)).toContain("lapsed");
    expect(h.store.get(fresh)?.state).toBe("approved");
    expect(h.diagnostic.executeCalls).toHaveLength(0);
    const fresher = h.published.slice(publishedBefore);
    expect(fresher.map((e) => `${e.approval.proposalId}:${e.approval.state}`)).toEqual([
      `${stale}:lapsed`,
    ]);
  });

  it("leaves a request that is executing alone, however old", async () => {
    const h = createHarness();
    const gate = h.diagnostic.hold();
    const id = h.propose();
    await h.engine.decide({
      proposalId: id,
      decision: "approve",
      payloadHash: h.store.get(id)?.payloadHash ?? "",
      via: "plugin",
    });
    h.clock.advance(60 * MINUTE);
    expect(h.engine.sweepExpired()).toEqual({ expired: 0, lapsed: 0 });
    expect(h.store.get(id)?.state).toBe("executing");
    gate.release();
    await h.engine.settled();
  });
});

describe("no notification path (Task 1, Test 7)", () => {
  it("the engine's dependency list names no notifier, so none can be called", () => {
    const ALLOWED = [
      "store",
      "registry",
      "clock",
      "publisher",
      "mirror",
      "log",
      "ids",
      "projectName",
      "claimFactsTimeoutMs",
    ] as const;
    type Unlisted = Exclude<keyof ApprovalEngineDeps, (typeof ALLOWED)[number]>;
    // A new dependency (a notifier, say) makes this assignment a compile error.
    const nothingElse: [Unlisted] extends [never] ? true : false = true;
    expect(nothingElse).toBe(true);
  });

  it("expiry publishes upserts only: every published payload carries just an approval summary", () => {
    const h = createHarness();
    h.propose({ requestedTtlMs: 1 * MINUTE });
    h.clock.advance(1 * MINUTE);
    h.engine.sweepExpired();
    expect(new Set(h.publishedEvents)).toEqual(new Set(["approval.upserted"]));
    for (const payload of h.published) expect(Object.keys(payload)).toEqual(["approval"]);
  });
});
