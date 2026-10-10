import { CodexUsageSnapshotSchema } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { normalizeRateLimitsReply } from "./rate-limits.js";

/** An obviously fake marker, never a real identifier (CODEX-09). */
const ACCOUNT_MARKER = "FAKE-ACCOUNT-MARKER-1";
const RESETS_AT_S = 1_790_000_000;
const OBSERVED_AT_MS = Date.UTC(2026, 9, 10, 12, 0, 0);

function weeklyReply(usedPercent: number, over: Record<string, unknown> = {}): unknown {
  return {
    rateLimits: {
      primary: { usedPercent, windowDurationMins: 10_080, resetsAt: RESETS_AT_S },
      secondary: null,
      planType: "prolite",
      rateLimitReachedType: null,
    },
    ordinaryUsageAllowed: true,
    accountId: ACCOUNT_MARKER,
    ...over,
  };
}

describe("normalizeRateLimitsReply (tracer, CODEX-08, CODEX-09, D-21)", () => {
  it("Test 1: a weekly-window reply becomes an available snapshot without the account id", () => {
    const snapshot = normalizeRateLimitsReply(weeklyReply(41), { observedAtMs: OBSERVED_AT_MS });
    expect(snapshot).toEqual({
      kind: "available",
      windows: [
        {
          windowMinutes: 10_080,
          usedPercent: 41,
          resetsAt: new Date(RESETS_AT_S * 1000).toISOString(),
          limitLabel: null,
        },
      ],
      ordinaryUsageAllowed: true,
      rateLimitReached: false,
      rateLimitReachedType: null,
      source: "app-server",
      observedAt: new Date(OBSERVED_AT_MS).toISOString(),
      freshness: "live",
    });
    expect(CodexUsageSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(ACCOUNT_MARKER);
    expect(JSON.stringify(snapshot)).not.toContain("prolite");
  });
});
