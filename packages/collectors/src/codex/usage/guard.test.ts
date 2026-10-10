import { CodexHeadroomSchema } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { buildCodexHeadroom, evaluateGuard, GUARD_EXIT } from "./guard.js";
import { normalizeRateLimitsReply } from "./rate-limits.js";

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
