import {
  type ClaudeHeadroomView,
  type CodexUsageSnapshot,
  CodexUsageUpdatedPayloadSchema,
  HeadroomSignalSchema,
} from "@ccc/domain";
import { describe, expect, it, vi } from "vitest";
import { createHeadroomService, type HeadroomServiceDeps } from "./headroom-service.js";

const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const RESETS_AT = new Date(T0 + 3 * 24 * 3600 * 1000).toISOString();
const CLAUDE: ClaudeHeadroomView = { kind: "unavailable", reason: "no-report-yet" };

function available(
  percent: number,
  observedAtMs: number,
  over: Partial<Extract<CodexUsageSnapshot, { kind: "available" }>> = {},
): CodexUsageSnapshot {
  return {
    kind: "available",
    windows: [
      { windowMinutes: 10_080, usedPercent: percent, resetsAt: RESETS_AT, limitLabel: null },
    ],
    ordinaryUsageAllowed: true,
    rateLimitReached: false,
    rateLimitReachedType: null,
    source: "app-server",
    observedAt: new Date(observedAtMs).toISOString(),
    freshness: "live",
    ...over,
  };
}

function failedRead(atMs: number): CodexUsageSnapshot {
  return {
    kind: "unavailable",
    reason: "read-failed",
    version: null,
    observedAt: new Date(atMs).toISOString(),
  };
}

interface Harness {
  readonly deps: HeadroomServiceDeps;
  readonly clock: { now: number };
  readonly reads: { count: number; next: () => CodexUsageSnapshot };
  readonly publish: ReturnType<typeof vi.fn>;
  readonly save: ReturnType<typeof vi.fn>;
  readonly ticks: Array<() => void>;
  readonly timer: { setCalls: number[]; cleared: unknown[] };
  readonly state: {
    subscribers: number;
    paused: { count: number; earliestResetAt: string | null };
  };
  service: ReturnType<typeof createHeadroomService>;
}

function harness(over: Partial<HeadroomServiceDeps> = {}, firstPercent = 41): Harness {
  const clock = { now: T0 };
  const reads = {
    count: 0,
    next: (): CodexUsageSnapshot => available(firstPercent, clock.now),
  };
  const publish = vi.fn();
  const save = vi.fn();
  const ticks: Array<() => void> = [];
  const timer = { setCalls: [] as number[], cleared: [] as unknown[] };
  const state = { subscribers: 1, paused: { count: 0, earliestResetAt: null as string | null } };
  const deps: HeadroomServiceDeps = {
    client: {
      read: async () => {
        reads.count += 1;
        return reads.next();
      },
      dispose: () => {},
    },
    saveSnapshot: save,
    loadSnapshot: () => null,
    fallback: () => null,
    pausedRuns: () => state.paused,
    claudeView: () => CLAUDE,
    subscribers: () => state.subscribers,
    publish,
    now: () => clock.now,
    timers: {
      setInterval: (fn, ms) => {
        ticks.push(fn);
        timer.setCalls.push(ms);
        return ticks.length;
      },
      clearInterval: (handle) => timer.cleared.push(handle),
    },
    ...over,
  };
  const h: Harness = {
    deps,
    clock,
    reads,
    publish,
    save,
    ticks,
    timer,
    state,
    service: createHeadroomService(deps),
  };
  return h;
}

const SECOND = 1000;

describe("createHeadroomService (tracer, CODEX-11, CODEX-12, D-22 to D-24)", () => {
  it("Test 1: a live 41 percent read becomes an allow signal that parses with the domain schema", async () => {
    const h = harness();
    const signal = await h.service.getHeadroom();
    expect(HeadroomSignalSchema.safeParse(signal).success).toBe(true);
    expect(signal.codex.verdict).toBe("allow");
    expect(signal.codex.reason).toBeNull();
    expect(signal.codex.source).toBe("app-server");
    expect(signal.codex.freshness).toBe("live");
    expect(signal.codex.pausedRuns.count).toBe(0);
    expect(signal.claude).toEqual(CLAUDE);
    expect(signal.generatedAt).toBe(new Date(T0).toISOString());
  });
});

describe("headroom verdicts (D-22)", () => {
  it("Test 2a: 83 percent refuses at the reserve line", async () => {
    const h = harness({}, 83);
    const signal = await h.service.getHeadroom();
    expect(signal.codex).toMatchObject({ verdict: "refuse", reason: "reserve-line" });
    expect(signal.codex.worstWindow?.usedPercent).toBe(83);
  });

  it("Test 2b: allowed false refuses as usage-not-allowed", async () => {
    const h = harness();
    h.reads.next = () => available(10, h.clock.now, { ordinaryUsageAllowed: false });
    const signal = await h.service.getHeadroom();
    expect(signal.codex).toMatchObject({ verdict: "refuse", reason: "usage-not-allowed" });
  });

  it("Test 2c: an unavailable read refuses as usage-unavailable with no number", async () => {
    const h = harness();
    h.reads.next = () => failedRead(h.clock.now);
    const signal = await h.service.getHeadroom();
    expect(signal.codex).toMatchObject({
      verdict: "refuse",
      reason: "usage-unavailable",
      worstWindow: null,
      freshness: "unavailable",
    });
    expect(JSON.stringify(signal)).not.toMatch(/usedPercent/);
  });

  it("Test 2d: a paused run refuses as paused-run and carries the reset", async () => {
    const h = harness();
    h.state.paused = { count: 1, earliestResetAt: RESETS_AT };
    const signal = await h.service.getHeadroom();
    expect(signal.codex).toMatchObject({ verdict: "refuse", reason: "paused-run" });
    expect(signal.codex.pausedRuns).toEqual({ count: 1, earliestResetAt: RESETS_AT });
  });

  it("Test 2e: with only the rollout fallback the bar shows it but the gate still refuses", async () => {
    const fallback = available(30, T0 - 5 * SECOND, { source: "rollout-fallback" });
    const h = harness({ fallback: () => fallback });
    h.reads.next = () => failedRead(h.clock.now);
    const usage = await h.service.getUsage();
    expect(usage).toMatchObject({ kind: "available", source: "rollout-fallback" });
    const signal = await h.service.getHeadroom();
    expect(signal.codex).toMatchObject({
      verdict: "refuse",
      reason: "no-live-read",
      source: "rollout-fallback",
    });
  });
});

describe("freshness over time (D-24, A11)", () => {
  it("Test 3: 119 s live, 121 s stale and refusing, 601 s unavailable too-old", async () => {
    const h = harness();
    await h.service.getUsage();
    h.clock.now = T0 + 119 * SECOND;
    expect(h.service.peekHeadroom()?.codex).toMatchObject({ verdict: "allow", freshness: "live" });
    h.clock.now = T0 + 121 * SECOND;
    const stale = h.service.peekHeadroom();
    expect(stale?.codex).toMatchObject({
      verdict: "refuse",
      reason: "usage-unavailable",
      freshness: "stale",
    });
    expect(stale?.codex.worstWindow?.usedPercent).toBe(41);
    expect(h.service.peekUsage()).toMatchObject({ kind: "available", freshness: "stale" });
    h.clock.now = T0 + 601 * SECOND;
    expect(h.service.peekUsage()).toMatchObject({ kind: "unavailable", reason: "too-old" });
    expect(h.service.peekHeadroom()?.codex).toMatchObject({
      verdict: "refuse",
      freshness: "unavailable",
      worstWindow: null,
    });
  });
});

describe("read-through and peeks (D-24)", () => {
  it("Test 4a: a missing snapshot reads once for concurrent callers; a failing refresh keeps the old one as stale", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.service.getUsage(), h.service.getUsage()]);
    expect(a).toEqual(b);
    expect(h.reads.count).toBe(1);
    h.clock.now = T0 + 121 * SECOND;
    h.reads.next = () => failedRead(h.clock.now);
    const after = await h.service.getUsage();
    expect(h.reads.count).toBe(2);
    expect(after).toMatchObject({ kind: "available", freshness: "stale" });
    if (after.kind === "available") expect(after.windows[0]?.usedPercent).toBe(41);
  });

  it("Test 4b: peeks answer from the cache and refreshIfStale starts one fire-and-forget read that publishes", async () => {
    const h = harness();
    expect(h.service.peekUsage()).toBeNull();
    expect(h.service.peekHeadroom()).toBeNull();
    h.service.refreshIfStale();
    h.service.refreshIfStale();
    expect(h.reads.count).toBe(1);
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
    expect(h.service.peekUsage()).toMatchObject({ kind: "available" });
    h.service.refreshIfStale();
    expect(h.reads.count).toBe(1);
  });
});

describe("failed refresh does not suppress read-through (finding: stale cache)", () => {
  it("a failed read retries after the short failure throttle, not after the 2 minute live window", async () => {
    const h = harness();
    await h.service.getUsage();
    h.clock.now = T0 + 121 * SECOND;
    h.reads.next = () => failedRead(h.clock.now);
    await h.service.getUsage();
    expect(h.reads.count).toBe(2);
    // Within the failure throttle: app-server is not hammered.
    h.clock.now += 5 * SECOND;
    await h.service.getUsage();
    expect(h.reads.count).toBe(2);
    // Past it, with the cache still stale: read again, and recover.
    h.clock.now += 11 * SECOND;
    h.reads.next = () => available(52, h.clock.now);
    const after = await h.service.getUsage();
    expect(h.reads.count).toBe(3);
    expect(after).toMatchObject({ kind: "available", freshness: "live" });
    if (after.kind === "available") expect(after.windows[0]?.usedPercent).toBe(52);
  });
});

describe("refresh timer gated by subscribers (D-24)", () => {
  it("Test 5: no read on a tick without subscribers; one read per tick with one; stop clears", async () => {
    const h = harness();
    h.state.subscribers = 0;
    h.service.start();
    expect(h.timer.setCalls).toEqual([60_000]);
    h.ticks[0]?.();
    await Promise.resolve();
    expect(h.reads.count).toBe(0);
    h.state.subscribers = 1;
    h.ticks[0]?.();
    await vi.waitFor(() => expect(h.reads.count).toBe(1));
    h.service.stop();
    expect(h.timer.cleared).toEqual([1]);
  });
});

describe("persistence (D-24)", () => {
  it("Test 6: a live read is saved, a failure is not, and a saved snapshot loads as stale", async () => {
    const h = harness();
    await h.service.getUsage();
    expect(h.save).toHaveBeenCalledTimes(1);
    const failing = harness();
    failing.reads.next = () => failedRead(failing.clock.now);
    await failing.service.getUsage();
    expect(failing.save).not.toHaveBeenCalled();

    const saved = available(30, T0 - 30 * SECOND);
    const loaded = harness({ loadSnapshot: () => saved });
    loaded.service.start();
    expect(loaded.service.peekUsage()).toMatchObject({ kind: "available", freshness: "stale" });
    expect(loaded.service.peekHeadroom()?.codex).toMatchObject({
      verdict: "refuse",
      freshness: "stale",
    });
    await loaded.service.getUsage();
    expect(loaded.service.peekHeadroom()?.codex).toMatchObject({
      verdict: "allow",
      freshness: "live",
    });
  });
});

describe("publishing (D-24, D-25)", () => {
  it("Test 7: publishes codex.usage.updated on change only, and the payload parses", async () => {
    const h = harness();
    const fixed = available(41, T0);
    h.reads.next = () => fixed;
    h.service.start();
    await h.service.getUsage();
    expect(h.publish).toHaveBeenCalledTimes(1);
    const [type, payload] = h.publish.mock.calls[0] ?? [];
    expect(type).toBe("codex.usage.updated");
    expect(CodexUsageUpdatedPayloadSchema.safeParse(payload).success).toBe(true);
    // An identical read at the same instant changes nothing a viewer sees.
    h.ticks[0]?.();
    await vi.waitFor(() => expect(h.reads.count).toBe(2));
    await Promise.resolve();
    expect(h.publish).toHaveBeenCalledTimes(1);
    // A different percent does.
    h.reads.next = () => available(55, h.clock.now);
    h.ticks[0]?.();
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(2));
  });
});
