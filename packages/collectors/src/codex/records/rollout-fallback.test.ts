import { CodexUsageSnapshotSchema } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  at,
  rateLimitsWithDecoys,
  rolloutText,
  sessionMetaLine,
  taskCompleteLine,
  tokenCountLine,
} from "../../test-support/codex-rollouts.js";
import { ageFreshness } from "../usage/guard.js";
import { parseRolloutChunk, type RolloutFact } from "./rollout.js";
import {
  newestRolloutRateLimits,
  ROLLOUT_FALLBACK_WINDOW_MS,
  rolloutFallbackSnapshot,
} from "./rollout-fallback.js";

const DAY = 24 * 60 * 60 * 1000;
const T = Date.parse(at(0));
const NOW = T + 5 * 60 * 1000;

function limitsAt(seconds: number, weekly: number, over: Record<string, unknown> = {}): string {
  return tokenCountLine({
    timestamp: at(seconds),
    rateLimits: rateLimitsWithDecoys({
      primary: { used_percent: 3, window_minutes: 300, resets_at: 1_791_000_000 },
      secondary: { used_percent: weekly, window_minutes: 10_080, resets_at: 1_791_500_000 },
      ...over,
    }),
  });
}

function facts(...lines: string[]): readonly RolloutFact[] {
  return parseRolloutChunk(rolloutText(lines)).facts;
}

describe("newestRolloutRateLimits (plan 05.1-33, OQ-3)", () => {
  it("Test 1 (tracer): the newest rate-limits fact by its own timestamp wins, not file order", () => {
    const newest = newestRolloutRateLimits(
      facts(sessionMetaLine(), limitsAt(120, 40), limitsAt(30, 10), limitsAt(60, 20)),
      { nowMs: NOW },
    );
    expect(newest?.time).toBe(at(120));
    expect(newest?.observedAtMs).toBe(Date.parse(at(120)));
    expect(newest?.limits.secondary?.usedPercent).toBe(40);
  });

  it("Test 2: a tie on time keeps the later fact in file order", () => {
    const newest = newestRolloutRateLimits(facts(limitsAt(10, 11), limitsAt(10, 12)), {
      nowMs: NOW,
    });
    expect(newest?.limits.secondary?.usedPercent).toBe(12);
  });

  it("Test 3: facts older than the 31-day window or stamped in the future are ignored", () => {
    const old = limitsAt(-(ROLLOUT_FALLBACK_WINDOW_MS / 1000) - 60, 55);
    const future = limitsAt(24 * 3600, 77);
    expect(ROLLOUT_FALLBACK_WINDOW_MS).toBe(31 * DAY);
    expect(newestRolloutRateLimits(facts(old, future), { nowMs: NOW })).toBeNull();
    const kept = newestRolloutRateLimits(facts(old, future, limitsAt(30, 9)), { nowMs: NOW });
    expect(kept?.limits.secondary?.usedPercent).toBe(9);
  });

  it("Test 4: a corrupt rate_limits payload and a missing timestamp yield no fact", () => {
    const corrupt = tokenCountLine({
      timestamp: at(50),
      rateLimits: { primary: { used_percent: "lots" }, secondary: null },
    });
    const noTime = JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", rate_limits: rateLimitsWithDecoys() },
    });
    expect(newestRolloutRateLimits(facts(corrupt, noTime), { nowMs: NOW })).toBeNull();
  });

  it("Test 5: a rollout with no rate limits at all yields null", () => {
    expect(
      newestRolloutRateLimits(facts(sessionMetaLine(), taskCompleteLine("turn-1")), {
        nowMs: NOW,
      }),
    ).toBeNull();
    expect(newestRolloutRateLimits([], { nowMs: NOW })).toBeNull();
  });
});

describe("rolloutFallbackSnapshot (plan 05.1-33, CODEX-08, CODEX-09)", () => {
  it("Test 6: builds a rollout-fallback snapshot observed at the record's own time", () => {
    const newest = newestRolloutRateLimits(facts(limitsAt(30, 41)), { nowMs: NOW });
    const snapshot = rolloutFallbackSnapshot(newest, NOW);
    expect(snapshot).toMatchObject({
      kind: "available",
      source: "rollout-fallback",
      observedAt: at(30),
      ordinaryUsageAllowed: null,
    });
    expect(CodexUsageSnapshotSchema.safeParse(snapshot).success).toBe(true);
    if (snapshot?.kind !== "available") throw new Error("expected available");
    expect(snapshot.windows.map((w) => [w.windowMinutes, w.usedPercent])).toEqual([
      [300, 3],
      [10_080, 41],
    ]);
    const age = ageFreshness(Date.parse(snapshot.observedAt), NOW);
    expect(snapshot.freshness).toBe(age === "live" ? "live" : "stale");
  });

  it("Test 7: plan type, credits, limit name and every unknown field are dropped", () => {
    const newest = newestRolloutRateLimits(
      facts(limitsAt(30, 41, { limit_name: "DECOY-LIMIT-NAME", extra_account: "DECOY-ACCOUNT" })),
      { nowMs: NOW },
    );
    const snapshot = rolloutFallbackSnapshot(newest, NOW);
    expect(snapshot?.kind).toBe("available");
    const text = JSON.stringify(snapshot);
    for (const decoy of [
      "DECOY-PLAN-TYPE",
      "DECOY-CREDITS-BALANCE",
      "DECOY-INDIVIDUAL-LIMIT",
      "DECOY-LIMIT-NAME",
      "DECOY-ACCOUNT",
      "credits",
      "plan",
    ]) {
      expect(text).not.toContain(decoy);
    }
  });

  it("Test 8: a reached type is kept as a reached flag and null input is null, never zero", () => {
    const newest = newestRolloutRateLimits(
      facts(limitsAt(30, 100, { rate_limit_reached_type: "usage_limit_reached" })),
      { nowMs: NOW },
    );
    expect(rolloutFallbackSnapshot(newest, NOW)).toMatchObject({
      kind: "available",
      rateLimitReached: true,
    });
    expect(rolloutFallbackSnapshot(null, NOW)).toBeNull();
  });
});
