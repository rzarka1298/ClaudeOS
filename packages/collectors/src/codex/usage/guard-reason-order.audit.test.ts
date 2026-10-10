import { describe, expect, it } from "vitest";
import { buildCodexHeadroom, evaluateGuard } from "./guard.js";
import { normalizeRateLimitsReply, normalizeRolloutRateLimits } from "./rate-limits.js";

// Wave 3 audit (plan 05.1-07 truth 5): the headroom reason follows the UI-SPEC order for EVERY
// combination of conditions, not just the pairs the plan tests happen to name:
//   reserve line / reached type, then usage not allowed, then a paused run, then rollout-fallback
//   only, then unavailable or stale. Only the all-clear combination may allow.

const OBSERVED_AT_MS = Date.UTC(2026, 9, 10, 12, 0, 0);
const RESETS_AT_S = 1_790_000_000;
const LIVE_NOW = OBSERVED_AT_MS + 30_000;
const STALE_NOW = OBSERVED_AT_MS + 5 * 60_000;
const TOO_OLD_NOW = OBSERVED_AT_MS + 11 * 60_000;

interface Combo {
  reserve: boolean;
  notAllowed: boolean;
  paused: boolean;
  stale: boolean;
}

function live(c: Pick<Combo, "reserve" | "notAllowed">) {
  return normalizeRateLimitsReply(
    {
      rateLimits: {
        primary: {
          usedPercent: c.reserve ? 85 : 30,
          windowDurationMins: 10_080,
          resetsAt: RESETS_AT_S,
        },
        secondary: null,
        rateLimitReachedType: null,
      },
      ordinaryUsageAllowed: !c.notAllowed,
    },
    { observedAtMs: OBSERVED_AT_MS },
  );
}

function expectedReason(c: Combo): string | null {
  if (c.reserve) return "reserve-line";
  if (c.notAllowed) return "usage-not-allowed";
  if (c.paused) return "paused-run";
  if (c.stale) return "usage-unavailable";
  return null;
}

const COMBOS: Combo[] = [];
for (const reserve of [false, true])
  for (const notAllowed of [false, true])
    for (const paused of [false, true])
      for (const stale of [false, true]) COMBOS.push({ reserve, notAllowed, paused, stale });

describe("headroom reason order over every condition combination (CODEX-12, D-22, OQ-3)", () => {
  it.each(COMBOS)("live app-server read: %j", (c) => {
    const snapshot = live(c);
    const nowMs = c.stale ? STALE_NOW : LIVE_NOW;
    const verdict = evaluateGuard({ snapshot, nowMs, pausedRunCount: c.paused ? 2 : 0 });
    const headroom = buildCodexHeadroom({
      snapshot,
      nowMs,
      pausedRuns: { count: c.paused ? 2 : 0, earliestResetAt: null },
    });
    const reason = expectedReason(c);
    expect(verdict.reason).toBe(reason);
    expect(headroom.reason).toBe(reason);
    // Only the all-clear combination allows; everything else refuses.
    expect(verdict.allowed).toBe(reason === null);
    expect(headroom.verdict).toBe(reason === null ? "allow" : "refuse");
  });

  it.each([
    [false, false, "no-live-read"],
    [false, true, "paused-run"],
    [true, false, "reserve-line"],
    [true, true, "reserve-line"],
  ] as const)(
    "rollout fallback (reserve %s, paused %s) says %s and never allows",
    (reserve, paused, reason) => {
      const snapshot = normalizeRolloutRateLimits(
        {
          primary: {
            used_percent: reserve ? 90 : 5,
            window_minutes: 10_080,
            resets_at: RESETS_AT_S,
          },
        },
        { observedAtMs: OBSERVED_AT_MS },
      );
      const verdict = evaluateGuard({ snapshot, nowMs: LIVE_NOW, pausedRunCount: paused ? 1 : 0 });
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe(reason);
    },
  );

  it("a read older than ten minutes keeps no number and no reserve claim, whatever it said", () => {
    const snapshot = live({ reserve: true, notAllowed: true });
    const verdict = evaluateGuard({ snapshot, nowMs: TOO_OLD_NOW, pausedRunCount: 0 });
    expect(verdict).toMatchObject({
      allowed: false,
      exitCode: 12,
      status: "unavailable",
      reason: "usage-unavailable",
      usedPercent: null,
      freshness: "unavailable",
    });
    const headroom = buildCodexHeadroom({ snapshot, nowMs: TOO_OLD_NOW });
    expect(headroom.worstWindow).toBeNull();
    expect(headroom.verdict).toBe("refuse");
  });
});
