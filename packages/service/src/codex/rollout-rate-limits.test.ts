import { CodexUsageSnapshotSchema } from "@ccc/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertNoForbiddenAccess,
  createFakeCodexHome,
  type FakeCodexHome,
  type FakeRollout,
  recordingFs,
  rolloutContent,
  rolloutMetaLine,
} from "../test-support/fake-codex-home.js";
import { createCodexHomePort } from "./codex-home.js";
import {
  createRolloutRateLimitsReader,
  ROLLOUT_RATE_LIMITS_CACHE_MS,
  type RolloutRateLimitsDeps,
} from "./rollout-rate-limits.js";

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A token_count line carrying a rate_limits object (plus decoy account facts that must be dropped). */
function limitsLine(atMs: number, weekly: number, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: new Date(atMs).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: null,
      rate_limits: {
        limit_id: "codex",
        limit_name: "DECOY-LIMIT-NAME",
        primary: { used_percent: 4, window_minutes: 300, resets_at: 1_791_000_000 },
        secondary: { used_percent: weekly, window_minutes: 10_080, resets_at: 1_791_500_000 },
        credits: { has_credits: true, balance: "DECOY-CREDITS-BALANCE" },
        plan_type: "DECOY-PLAN-TYPE",
        account_id: "DECOY-ACCOUNT-ID",
        rate_limit_reached_type: null,
        ...over,
      },
    },
  });
}

function rollout(day: string, stamp: string, mtimeMs: number, ...lines: string[]): FakeRollout {
  return {
    day,
    name: `rollout-${day}T${stamp}-synthetic.jsonl`,
    content: rolloutContent(rolloutMetaLine({ id: `t-${day}-${stamp}`, atMs: mtimeMs }), ...lines),
    mtimeMs,
  };
}

const homes: FakeCodexHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

function setup(rollouts: FakeRollout[], extra: Partial<RolloutRateLimitsDeps> = {}) {
  const home = createFakeCodexHome({ rollouts, withDecoys: true });
  homes.push(home);
  const recorder = recordingFs();
  const port = createCodexHomePort({ root: home.root, fs: recorder.fs });
  const warn = vi.fn();
  const clock = { now: NOW };
  const reader = createRolloutRateLimitsReader({
    port,
    now: () => clock.now,
    logger: { warn },
    ...extra,
  });
  return { home, recorder, port, warn, clock, reader };
}

describe("createRolloutRateLimitsReader (plan 05.1-33, OQ-3, CODEX-08)", () => {
  it("Test 1 (tracer): the newest figure across files wins, labelled rollout-fallback at its own time", () => {
    const { reader } = setup([
      rollout("2026-10-10", "09-00-00", NOW - 3 * HOUR, limitsLine(NOW - 3 * HOUR, 30)),
      rollout("2026-10-10", "11-00-00", NOW - 2 * MIN, limitsLine(NOW - 2 * MIN, 41)),
      rollout("2026-10-09", "08-00-00", NOW - 20 * HOUR, limitsLine(NOW - 20 * HOUR, 12)),
    ]);
    const snapshot = reader.read();
    expect(snapshot).toMatchObject({
      kind: "available",
      source: "rollout-fallback",
      observedAt: new Date(NOW - 2 * MIN).toISOString(),
      ordinaryUsageAllowed: null,
    });
    if (snapshot?.kind !== "available") throw new Error("expected available");
    expect(snapshot.windows.find((w) => w.windowMinutes === 10_080)?.usedPercent).toBe(41);
    expect(CodexUsageSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("Test 2: a resumed older-named file whose last record is newest beats a newer-named file", () => {
    const { reader } = setup([
      rollout("2026-10-08", "09-00-00", NOW - MIN, limitsLine(NOW - MIN, 63)),
      rollout("2026-10-10", "09-00-00", NOW - 30 * MIN, limitsLine(NOW - 30 * MIN, 50)),
    ]);
    const snapshot = reader.read();
    expect(snapshot?.kind === "available" && snapshot.observedAt).toBe(
      new Date(NOW - MIN).toISOString(),
    );
  });

  it("Test 3: figures older than the 31-day window are ignored, with or without a recent file", () => {
    const old = NOW - 35 * DAY;
    const { reader } = setup([
      rollout("2026-09-20", "09-00-00", NOW - 20 * DAY, limitsLine(old, 88)),
      rollout("2026-08-01", "09-00-00", old, limitsLine(old, 77)),
    ]);
    expect(reader.read()).toBeNull();
  });

  it("Test 4: a corrupt rate_limits record is ignored and the next valid figure is used", () => {
    const corrupt = JSON.stringify({
      timestamp: new Date(NOW - MIN).toISOString(),
      type: "event_msg",
      payload: { type: "token_count", rate_limits: { primary: { used_percent: "lots" } } },
    });
    const { reader } = setup([
      rollout("2026-10-10", "11-00-00", NOW - MIN, corrupt),
      rollout("2026-10-10", "10-00-00", NOW - 30 * MIN, limitsLine(NOW - 30 * MIN, 22)),
    ]);
    const snapshot = reader.read();
    expect(snapshot?.kind === "available" && snapshot.observedAt).toBe(
      new Date(NOW - 30 * MIN).toISOString(),
    );
  });

  it("Test 5: plan type, credits, account id and limit name never reach the snapshot", () => {
    const { reader } = setup([
      rollout("2026-10-10", "11-00-00", NOW - MIN, limitsLine(NOW - MIN, 41)),
    ]);
    const snapshot = reader.read();
    expect(snapshot?.kind).toBe("available");
    const text = JSON.stringify(snapshot);
    for (const decoy of [
      "DECOY-LIMIT-NAME",
      "DECOY-CREDITS-BALANCE",
      "DECOY-PLAN-TYPE",
      "DECOY-ACCOUNT-ID",
    ]) {
      expect(text).not.toContain(decoy);
    }
  });

  it("Test 6: only allowlisted rollout files are touched; credential, config and archived files never are", () => {
    const { home, recorder, reader } = setup([
      rollout("2026-10-10", "11-00-00", NOW - MIN, limitsLine(NOW - MIN, 41)),
    ]);
    expect(reader.read()?.kind).toBe("available");
    assertNoForbiddenAccess(recorder.calls, home);
    expect(recorder.calls.some((call) => call.op === "readBytes")).toBe(true);
    expect(
      recorder.calls
        .filter((call) => call.op === "readBytes")
        .every((call) => /\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/.test(call.path)),
    ).toBe(true);
  });

  it("Test 7: no number when there is no rollout, no rate limits, or an empty home", () => {
    expect(setup([]).reader.read()).toBeNull();
    const plain = rolloutContent(rolloutMetaLine({ id: "t-plain", atMs: NOW - MIN }));
    const { reader } = setup([
      { day: "2026-10-10", name: "rollout-2026-10-10T11-00-00-plain.jsonl", content: plain },
    ]);
    expect(reader.read()).toBeNull();
  });

  it("Test 8: a port failure is null with a reason-code log line only", () => {
    const warn = vi.fn();
    const reader = createRolloutRateLimitsReader({
      port: {
        listRolloutFiles: () => {
          throw new Error("/Users/USERNAME/secret-path exploded");
        },
        statRollout: () => null,
        readRolloutRange: () => {
          throw new Error("never reached");
        },
      },
      now: () => NOW,
      logger: { warn },
    });
    expect(reader.read()).toBeNull();
    expect(warn).toHaveBeenCalledWith({ reason: "rollout-list-failed" }, expect.any(String));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-path");
  });

  it("Test 9: an unreadable file is skipped and the next candidate still answers", () => {
    const { home, reader, warn } = setup([
      rollout("2026-10-10", "11-00-00", NOW - MIN, limitsLine(NOW - MIN, 41)),
      rollout("2026-10-10", "10-00-00", NOW - 40 * MIN, limitsLine(NOW - 40 * MIN, 20)),
    ]);
    const newest = home.rolloutPath("2026-10-10", "rollout-2026-10-10T11-00-00-synthetic.jsonl");
    const broken = createRolloutRateLimitsReader({
      port: {
        ...createCodexHomePort({ root: home.root }),
        readRolloutRange(ref, offset, maxBytes) {
          if (ref.path === newest) throw new Error("boom");
          return createCodexHomePort({ root: home.root }).readRolloutRange(ref, offset, maxBytes);
        },
      },
      now: () => NOW,
      logger: { warn },
    });
    const snapshot = broken.read();
    expect(snapshot?.kind === "available" && snapshot.observedAt).toBe(
      new Date(NOW - 40 * MIN).toISOString(),
    );
    expect(reader.read()?.kind).toBe("available");
  });

  it("Test 10: only the last 256 KiB of a large rollout is read, the partial first line dropped", () => {
    const filler = `${JSON.stringify({ type: "synthetic_unknown_kind", timestamp: new Date(NOW - HOUR).toISOString() })}\n`;
    const body = filler.repeat(Math.ceil((1024 * 1024) / filler.length));
    const head = limitsLine(NOW - 5 * MIN, 99);
    const tail = limitsLine(NOW - MIN, 41);
    const { reader, recorder } = setup([
      {
        day: "2026-10-10",
        name: "rollout-2026-10-10T11-00-00-large.jsonl",
        content: `${head}\n${body}${tail}\n`,
        mtimeMs: NOW - MIN,
      },
    ]);
    const snapshot = reader.read();
    if (snapshot?.kind !== "available") throw new Error("expected available");
    expect(snapshot.windows.find((w) => w.windowMinutes === 10_080)?.usedPercent).toBe(41);
    expect(snapshot.observedAt).toBe(new Date(NOW - MIN).toISOString());
    expect(recorder.calls.filter((call) => call.op === "readBytes")).toHaveLength(1);
  });

  it("Test 11: the answer is cached for a few seconds, then the files are listed again", () => {
    const listed = vi.fn();
    const { port, clock } = setup([
      rollout("2026-10-10", "11-00-00", NOW - MIN, limitsLine(NOW - MIN, 41)),
    ]);
    const reader = createRolloutRateLimitsReader({
      port: {
        listRolloutFiles: (range) => {
          listed();
          return port.listRolloutFiles(range);
        },
        statRollout: (ref) => port.statRollout(ref),
        readRolloutRange: (ref, offset, max) => port.readRolloutRange(ref, offset, max),
      },
      now: () => clock.now,
    });
    expect(ROLLOUT_RATE_LIMITS_CACHE_MS).toBeGreaterThan(0);
    reader.read();
    reader.read();
    expect(listed).toHaveBeenCalledTimes(1);
    clock.now += ROLLOUT_RATE_LIMITS_CACHE_MS + 1;
    reader.read();
    expect(listed).toHaveBeenCalledTimes(2);
  });

  it("Test 12: a figure older than the stale max age is still returned, so the headroom service ages it", () => {
    const { reader } = setup([
      rollout("2026-10-10", "09-00-00", NOW - 3 * HOUR, limitsLine(NOW - 3 * HOUR, 41)),
    ]);
    const snapshot = reader.read();
    expect(snapshot).toMatchObject({ kind: "available", freshness: "stale" });
  });
});
