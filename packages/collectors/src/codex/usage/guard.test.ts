import { CodexHeadroomSchema } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { ageFreshness, buildCodexHeadroom, evaluateGuard, GUARD_EXIT } from "./guard.js";
import { normalizeRateLimitsReply, normalizeRolloutRateLimits } from "./rate-limits.js";

const RESETS_AT_S = 1_790_000_000;
const OBSERVED_AT_MS = Date.UTC(2026, 9, 10, 12, 0, 0);
const NOW_MS = OBSERVED_AT_MS + 30_000;

function snapshotAt(usedPercent: number) {
  return normalizeRateLimitsReply(
    {
      rateLimits: {
        primary: { usedPercent, windowDurationMins: 10_080, resetsAt: RESETS_AT_S },
        secondary: null,
        rateLimitReachedType: null,
      },
      ordinaryUsageAllowed: true,
    },
    { observedAtMs: OBSERVED_AT_MS },
  );
}

describe("evaluateGuard (tracer, CODEX-12, D-22)", () => {
  it("pins the wrapper's exit-code vocabulary", () => {
    expect(GUARD_EXIT).toEqual({
      OK: 0,
      RESERVE: 10,
      NOT_ALLOWED: 11,
      UNAVAILABLE: 12,
      PENDING_RESUME: 13,
    });
  });

  it("Test 2: a 41 percent read 30 seconds ago allows", () => {
    const verdict = evaluateGuard({ snapshot: snapshotAt(41), nowMs: NOW_MS, pausedRunCount: 0 });
    expect(verdict).toMatchObject({
      allowed: true,
      exitCode: 0,
      status: "ok",
      reason: null,
      freshness: "live",
      usedPercent: 41,
      ordinaryUsageAllowed: true,
    });
    expect(verdict.resetsAt).toBe(new Date(RESETS_AT_S * 1000).toISOString());
  });

  it("Test 3: 83 percent refuses on the reserve line with exit 10", () => {
    const verdict = evaluateGuard({ snapshot: snapshotAt(83), nowMs: NOW_MS, pausedRunCount: 0 });
    expect(verdict).toMatchObject({
      allowed: false,
      exitCode: 10,
      status: "low",
      reason: "reserve-line",
    });
  });

  it("Test 5: an unavailable snapshot refuses with exit 12 and no number", () => {
    const snapshot = normalizeRateLimitsReply("not an object", { observedAtMs: OBSERVED_AT_MS });
    const verdict = evaluateGuard({ snapshot, nowMs: NOW_MS, pausedRunCount: 0 });
    expect(verdict).toMatchObject({
      allowed: false,
      exitCode: 12,
      status: "unavailable",
      reason: "usage-unavailable",
      freshness: "unavailable",
      usedPercent: null,
    });
  });
});

describe("buildCodexHeadroom (tracer, CODEX-11, D-23)", () => {
  it("Test 4: allows at 41 percent and refuses at 83 percent, both schema-valid", () => {
    const allow = buildCodexHeadroom({ snapshot: snapshotAt(41), nowMs: NOW_MS });
    expect(CodexHeadroomSchema.safeParse(allow).success).toBe(true);
    expect(allow).toEqual({
      verdict: "allow",
      reason: null,
      worstWindow: {
        windowMinutes: 10_080,
        usedPercent: 41,
        resetsAt: new Date(RESETS_AT_S * 1000).toISOString(),
      },
      source: "app-server",
      observedAt: new Date(OBSERVED_AT_MS).toISOString(),
      freshness: "live",
      pausedRuns: { count: 0, earliestResetAt: null },
    });

    const refuse = buildCodexHeadroom({ snapshot: snapshotAt(83), nowMs: NOW_MS });
    expect(CodexHeadroomSchema.safeParse(refuse).success).toBe(true);
    expect(refuse).toMatchObject({ verdict: "refuse", reason: "reserve-line" });
  });

  it("Test 5: an unavailable snapshot has no worst window and unavailable freshness", () => {
    const snapshot = normalizeRateLimitsReply(null, { observedAtMs: OBSERVED_AT_MS });
    const headroom = buildCodexHeadroom({ snapshot, nowMs: NOW_MS });
    expect(CodexHeadroomSchema.safeParse(headroom).success).toBe(true);
    expect(headroom).toMatchObject({
      verdict: "refuse",
      reason: "usage-unavailable",
      worstWindow: null,
      freshness: "unavailable",
    });
  });
});

const OPTIONS = { observedAtMs: OBSERVED_AT_MS } as const;

function replyOf(
  windows: readonly { usedPercent: number; windowDurationMins: number | null }[],
  over: Record<string, unknown> = {},
  limits: Record<string, unknown> = {},
): unknown {
  const [first, second] = windows;
  return {
    rateLimits: {
      primary: first ? { ...first, resetsAt: RESETS_AT_S } : null,
      secondary: second ? { ...second, resetsAt: RESETS_AT_S } : null,
      rateLimitReachedType: null,
      ...limits,
    },
    ordinaryUsageAllowed: true,
    ...over,
  };
}

function verdictFor(raw: unknown, pausedRunCount = 0, nowMs = NOW_MS) {
  return evaluateGuard({
    snapshot: normalizeRateLimitsReply(raw, OPTIONS),
    nowMs,
    pausedRunCount,
  });
}

describe("evaluateGuard edge cases (CODEX-12, D-22)", () => {
  it("Test 3: the worst percent over every limit snapshot decides", () => {
    const reply = {
      ...(replyOf([{ usedPercent: 20, windowDurationMins: 300 }]) as object),
      rateLimitsByLimitId: {
        weekly: { primary: { usedPercent: 83, windowDurationMins: 10_080, resetsAt: RESETS_AT_S } },
      },
    };
    expect(verdictFor(reply)).toMatchObject({
      allowed: false,
      exitCode: 10,
      status: "low",
      usedPercent: 83,
    });
  });

  it("Test 3: exactly 80 refuses and 79.9 allows; 100 is exhausted", () => {
    expect(verdictFor(replyOf([{ usedPercent: 80, windowDurationMins: 60 }]))).toMatchObject({
      allowed: false,
      exitCode: 10,
      status: "low",
    });
    expect(verdictFor(replyOf([{ usedPercent: 79.9, windowDurationMins: 60 }]))).toMatchObject({
      allowed: true,
      exitCode: 0,
      status: "ok",
    });
    expect(verdictFor(replyOf([{ usedPercent: 100, windowDurationMins: 60 }]))).toMatchObject({
      allowed: false,
      exitCode: 10,
      status: "exhausted",
    });
    expect(verdictFor(replyOf([{ usedPercent: 400, windowDurationMins: 60 }]))).toMatchObject({
      status: "exhausted",
      usedPercent: 100,
    });
  });

  it("Test 3: a window with a null duration counts for the guard", () => {
    expect(verdictFor(replyOf([{ usedPercent: 91, windowDurationMins: null }]))).toMatchObject({
      allowed: false,
      exitCode: 10,
    });
  });

  it("Test 4: ordinary usage not allowed refuses with exit 11 and its own reason", () => {
    expect(
      verdictFor(
        replyOf([{ usedPercent: 30, windowDurationMins: 60 }], { ordinaryUsageAllowed: false }),
      ),
    ).toMatchObject({
      allowed: false,
      exitCode: 11,
      status: "exhausted",
      reason: "usage-not-allowed",
      ordinaryUsageAllowed: false,
    });
  });

  it("Test 4: a reached type at 30 percent refuses with exit 11 and the reserve-line reason", () => {
    expect(
      verdictFor(
        replyOf(
          [{ usedPercent: 30, windowDurationMins: 60 }],
          {},
          { rateLimitReachedType: "rate_limit_reached" },
        ),
      ),
    ).toMatchObject({
      allowed: false,
      exitCode: 11,
      reason: "reserve-line",
      ordinaryUsageAllowed: false,
    });
  });

  it("Test 4: a reached type never turns a null allowance into a boolean", () => {
    const verdict = verdictFor(
      replyOf(
        [{ usedPercent: 30, windowDurationMins: 60 }],
        { ordinaryUsageAllowed: null },
        { rateLimitReachedType: "rate_limit_reached" },
      ),
    );
    expect(verdict).toMatchObject({
      exitCode: 12,
      status: "unavailable",
      ordinaryUsageAllowed: null,
    });
  });

  it("Test 4: a null or absent allowance is unavailable with exit 12 but keeps the numbers", () => {
    for (const ordinaryUsageAllowed of [null, undefined]) {
      const verdict = verdictFor(
        replyOf([{ usedPercent: 41, windowDurationMins: 10_080 }], { ordinaryUsageAllowed }),
      );
      expect(verdict).toMatchObject({
        allowed: false,
        exitCode: 12,
        status: "unavailable",
        reason: "usage-unavailable",
        usedPercent: 41,
        ordinaryUsageAllowed: null,
      });
      expect(verdict.resetsAt).toBe(new Date(RESETS_AT_S * 1000).toISOString());
    }
  });

  it("Test 5: a paused run with a healthy snapshot refuses with exit 13", () => {
    const verdict = verdictFor(replyOf([{ usedPercent: 20, windowDurationMins: 60 }]), 1);
    expect(verdict).toMatchObject({
      allowed: false,
      exitCode: 13,
      status: "ok",
      reason: "paused-run",
    });
  });

  it("Test 5: reserve and not-allowed outrank a paused run in the exit code and the reason", () => {
    const reserve = verdictFor(replyOf([{ usedPercent: 90, windowDurationMins: 60 }]), 2);
    expect(reserve).toMatchObject({ exitCode: 10, reason: "reserve-line" });
    const notAllowed = verdictFor(
      replyOf([{ usedPercent: 10, windowDurationMins: 60 }], { ordinaryUsageAllowed: false }),
      2,
    );
    expect(notAllowed).toMatchObject({ exitCode: 11, reason: "usage-not-allowed" });
  });

  it("Test 5: a nonsense paused count is ignored rather than trusted", () => {
    const raw = replyOf([{ usedPercent: 20, windowDurationMins: 60 }]);
    for (const count of [Number.NaN, -3, Number.POSITIVE_INFINITY]) {
      expect(verdictFor(raw, count)).toMatchObject({ allowed: true, exitCode: 0 });
    }
  });

  it("Test 6: the rollout fallback never allows, even at 5 percent", () => {
    const snapshot = normalizeRolloutRateLimits(
      { primary: { used_percent: 5, window_minutes: 10_080, resets_at: RESETS_AT_S } },
      OPTIONS,
    );
    const verdict = evaluateGuard({ snapshot, nowMs: NOW_MS, pausedRunCount: 0 });
    expect(verdict).toMatchObject({
      allowed: false,
      status: "unavailable",
      exitCode: 12,
      reason: "no-live-read",
      usedPercent: 5,
    });
    const headroom = buildCodexHeadroom({ snapshot, nowMs: NOW_MS });
    expect(headroom).toMatchObject({
      verdict: "refuse",
      reason: "no-live-read",
      source: "rollout-fallback",
      worstWindow: { usedPercent: 5 },
    });
    expect(CodexHeadroomSchema.safeParse(headroom).success).toBe(true);
  });

  it("Test 6: a fallback at 90 percent states the reserve line first (UI-SPEC order)", () => {
    const snapshot = normalizeRolloutRateLimits({ primary: { used_percent: 90 } }, OPTIONS);
    expect(evaluateGuard({ snapshot, nowMs: NOW_MS })).toMatchObject({
      allowed: false,
      reason: "reserve-line",
    });
  });

  it("Test 7: ageFreshness is live to 120 s, stale to 600 s and unavailable beyond", () => {
    expect(ageFreshness(OBSERVED_AT_MS, OBSERVED_AT_MS + 119_000)).toBe("live");
    expect(ageFreshness(OBSERVED_AT_MS, OBSERVED_AT_MS + 120_000)).toBe("live");
    expect(ageFreshness(OBSERVED_AT_MS, OBSERVED_AT_MS + 121_000)).toBe("stale");
    expect(ageFreshness(OBSERVED_AT_MS, OBSERVED_AT_MS + 600_000)).toBe("stale");
    expect(ageFreshness(OBSERVED_AT_MS, OBSERVED_AT_MS + 601_000)).toBe("unavailable");
    expect(ageFreshness(Number.NaN, NOW_MS)).toBe("unavailable");
    expect(ageFreshness(OBSERVED_AT_MS, Number.NaN)).toBe("unavailable");
    // A read stamped in the future beyond clock skew is not trusted as live.
    expect(ageFreshness(OBSERVED_AT_MS + 3_600_000, OBSERVED_AT_MS)).toBe("unavailable");
    expect(ageFreshness(OBSERVED_AT_MS + 2_000, OBSERVED_AT_MS)).toBe("live");
  });

  it("Test 7: a 121 s old read keeps its numbers but refuses; a 601 s old read loses them", () => {
    const raw = replyOf([{ usedPercent: 41, windowDurationMins: 10_080 }]);
    const stale = verdictFor(raw, 0, OBSERVED_AT_MS + 121_000);
    expect(stale).toMatchObject({
      allowed: false,
      exitCode: 12,
      status: "unavailable",
      reason: "usage-unavailable",
      freshness: "stale",
      usedPercent: 41,
    });
    const tooOld = verdictFor(raw, 0, OBSERVED_AT_MS + 601_000);
    expect(tooOld).toMatchObject({
      allowed: false,
      exitCode: 12,
      status: "unavailable",
      reason: "usage-unavailable",
      freshness: "unavailable",
      usedPercent: null,
      resetsAt: null,
    });
    const headroom = buildCodexHeadroom({
      snapshot: normalizeRateLimitsReply(raw, OPTIONS),
      nowMs: OBSERVED_AT_MS + 601_000,
    });
    expect(headroom).toMatchObject({
      verdict: "refuse",
      worstWindow: null,
      freshness: "unavailable",
    });
    expect(CodexHeadroomSchema.safeParse(headroom).success).toBe(true);
  });

  it("no non-live state ever allows (T-05.1-27)", () => {
    const healthy = replyOf([{ usedPercent: 5, windowDurationMins: 10_080 }]);
    const fresh = OBSERVED_AT_MS + 10_000;
    const cases: { name: string; verdict: ReturnType<typeof evaluateGuard> }[] = [
      { name: "null snapshot", verdict: evaluateGuard({ snapshot: null, nowMs: fresh }) },
      { name: "off-shape", verdict: verdictFor("junk", 0, fresh) },
      { name: "no limits", verdict: verdictFor({}, 0, fresh) },
      { name: "stale", verdict: verdictFor(healthy, 0, OBSERVED_AT_MS + 200_000) },
      { name: "too old", verdict: verdictFor(healthy, 0, OBSERVED_AT_MS + 900_000) },
      {
        name: "fallback",
        verdict: evaluateGuard({
          snapshot: normalizeRolloutRateLimits({ primary: { used_percent: 1 } }, OPTIONS),
          nowMs: fresh,
        }),
      },
      {
        name: "null allowance",
        verdict: verdictFor({ ...(healthy as object), ordinaryUsageAllowed: null }, 0, fresh),
      },
      { name: "paused", verdict: verdictFor(healthy, 1, fresh) },
      { name: "future stamp", verdict: verdictFor(healthy, 0, OBSERVED_AT_MS - 3_600_000) },
    ];
    for (const { name, verdict } of cases) {
      expect(verdict.allowed, name).toBe(false);
      expect(verdict.exitCode, name).not.toBe(0);
      expect(verdict.reason, name).not.toBeNull();
    }
    expect(verdictFor(healthy, 0, fresh)).toMatchObject({ allowed: true, exitCode: 0 });
  });

  it("headroom carries the paused-run count and the earliest reset, schema-valid", () => {
    const snapshot = normalizeRateLimitsReply(
      replyOf([{ usedPercent: 20, windowDurationMins: 60 }]),
      OPTIONS,
    );
    const earliest = new Date(RESETS_AT_S * 1000).toISOString();
    const headroom = buildCodexHeadroom({
      snapshot,
      nowMs: NOW_MS,
      pausedRuns: { count: 2, earliestResetAt: earliest },
    });
    expect(headroom).toMatchObject({
      verdict: "refuse",
      reason: "paused-run",
      pausedRuns: { count: 2, earliestResetAt: earliest },
    });
    expect(CodexHeadroomSchema.safeParse(headroom).success).toBe(true);
    const zero = buildCodexHeadroom({
      snapshot,
      nowMs: NOW_MS,
      pausedRuns: { count: 0, earliestResetAt: earliest },
    });
    expect(zero).toMatchObject({
      verdict: "allow",
      pausedRuns: { count: 0, earliestResetAt: null },
    });
    const garbage = buildCodexHeadroom({
      snapshot,
      nowMs: NOW_MS,
      pausedRuns: { count: 1, earliestResetAt: "yesterday-ish" },
    });
    expect(CodexHeadroomSchema.safeParse(garbage).success).toBe(true);
    expect(garbage.pausedRuns.earliestResetAt).toBeNull();
  });

  it("headroom with no snapshot states no source and no observation", () => {
    const headroom = buildCodexHeadroom({ snapshot: null, nowMs: NOW_MS });
    expect(headroom).toEqual({
      verdict: "refuse",
      reason: "usage-unavailable",
      worstWindow: null,
      source: null,
      observedAt: null,
      freshness: "unavailable",
      pausedRuns: { count: 0, earliestResetAt: null },
    });
  });

  it("headroom picks the worst window across limits", () => {
    const reply = {
      ...(replyOf([{ usedPercent: 20, windowDurationMins: 300 }]) as object),
      rateLimitsByLimitId: {
        weekly: { primary: { usedPercent: 83, windowDurationMins: 10_080, resetsAt: RESETS_AT_S } },
      },
    };
    const headroom = buildCodexHeadroom({
      snapshot: normalizeRateLimitsReply(reply, OPTIONS),
      nowMs: NOW_MS,
    });
    expect(headroom.worstWindow).toMatchObject({ windowMinutes: 10_080, usedPercent: 83 });
  });
});
