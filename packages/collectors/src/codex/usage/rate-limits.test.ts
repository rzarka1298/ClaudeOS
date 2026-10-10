import { CodexUsageSnapshotSchema } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { normalizeRateLimitsReply, normalizeRolloutRateLimits } from "./rate-limits.js";

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

const OPTIONS = { observedAtMs: OBSERVED_AT_MS } as const;

function unavailableReason(raw: unknown): string | null {
  const snapshot = normalizeRateLimitsReply(raw, OPTIONS);
  return snapshot.kind === "unavailable" ? snapshot.reason : null;
}

function windowsOf(raw: unknown) {
  const snapshot = normalizeRateLimitsReply(raw, OPTIONS);
  if (snapshot.kind !== "available") throw new Error(`expected available, got ${snapshot.reason}`);
  return snapshot.windows;
}

describe("normalizeRateLimitsReply off-shape input (research R2 stability posture)", () => {
  it("Test 1: a reply that is not an object is unavailable shape-changed", () => {
    for (const raw of [null, undefined, "text", 7, true, [], [weeklyReply(10)]]) {
      expect(unavailableReason(raw)).toBe("shape-changed");
    }
  });

  it("Test 1: a missing, null or empty rate-limits member is unavailable no-limits", () => {
    expect(unavailableReason({})).toBe("no-limits");
    expect(unavailableReason({ rateLimits: null })).toBe("no-limits");
    expect(unavailableReason({ rateLimits: { primary: null, secondary: null } })).toBe("no-limits");
    expect(unavailableReason({ rateLimits: {} })).toBe("no-limits");
  });

  it("Test 1: a rate-limits member that is not an object is shape-changed", () => {
    expect(unavailableReason({ rateLimits: "x" })).toBe("shape-changed");
    expect(unavailableReason({ rateLimits: [] })).toBe("shape-changed");
  });

  it("Test 1: a window with a bad percent makes the reply unavailable unless another window is valid", () => {
    for (const usedPercent of ["41", Number.NaN, -1, Number.POSITIVE_INFINITY, null, undefined]) {
      const reply = { rateLimits: { primary: { usedPercent, windowDurationMins: 10_080 } } };
      expect(unavailableReason(reply)).toBe("shape-changed");
    }
    expect(unavailableReason({ rateLimits: { primary: "not a window" } })).toBe("shape-changed");
    expect(unavailableReason({ rateLimits: { primary: { windowDurationMins: 10_080 } } })).toBe(
      "shape-changed",
    );
    const mixed = {
      rateLimits: {
        primary: { usedPercent: "bad", windowDurationMins: 300 },
        secondary: { usedPercent: 12, windowDurationMins: 10_080 },
      },
      ordinaryUsageAllowed: true,
    };
    expect(windowsOf(mixed)).toEqual([
      { windowMinutes: 10_080, usedPercent: 12, resetsAt: null, limitLabel: null },
    ]);
    const skipped = {
      rateLimits: { primary: "not a window", secondary: { usedPercent: 12 } },
      ordinaryUsageAllowed: true,
    };
    expect(windowsOf(skipped)).toHaveLength(1);
  });

  it("Test 2: unknown extra keys at every level never change the snapshot", () => {
    const plain = normalizeRateLimitsReply(weeklyReply(41), OPTIONS);
    const noisy = normalizeRateLimitsReply(
      {
        rateLimits: {
          primary: {
            usedPercent: 41,
            windowDurationMins: 10_080,
            resetsAt: RESETS_AT_S,
            futureField: { nested: [1, 2, 3] },
          },
          secondary: null,
          planType: "prolite",
          rateLimitReachedType: null,
          credits: { balance: "12.00" },
          individualLimit: 5,
          spendControlReached: true,
          limitName: "Some Name",
          normalModelSlug: "model-x",
          surprise: "value",
        },
        ordinaryUsageAllowed: true,
        accountId: ACCOUNT_MARKER,
        rateLimitResetCredits: { available: 3 },
        brandNewMember: 1,
      },
      OPTIONS,
    );
    expect(noisy).toEqual(plain);
    expect(JSON.stringify(noisy)).not.toMatch(/balance|surprise|prolite|Some Name|FAKE-ACCOUNT/);
  });

  it("Test 3: every window of every limit snapshot is kept, in order, with null durations counted", () => {
    const reply = {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: RESETS_AT_S },
        secondary: null,
      },
      rateLimitsByLimitId: {
        codex_weekly: {
          limitId: "codex_weekly",
          primary: { usedPercent: 83, windowDurationMins: 10_080, resetsAt: RESETS_AT_S },
          secondary: { usedPercent: 5, windowDurationMins: null, resetsAt: null },
        },
        "bad label/with slash": { primary: { usedPercent: 7 } },
        skipped: "not a snapshot",
      },
      ordinaryUsageAllowed: true,
    };
    const windows = windowsOf(reply);
    expect(windows.map((w) => w.usedPercent)).toEqual([20, 83, 5, 7]);
    expect(windows.map((w) => w.windowMinutes)).toEqual([300, 10_080, null, null]);
    expect(windows.map((w) => w.limitLabel)).toEqual([
      "codex",
      "codex_weekly",
      "codex_weekly",
      null,
    ]);
  });

  it("Test 3: a percent above 100 is clamped and a fractional percent is kept", () => {
    expect(windowsOf(weeklyReply(250))[0]?.usedPercent).toBe(100);
    expect(windowsOf(weeklyReply(12.5))[0]?.usedPercent).toBe(12.5);
  });

  it("keeps the eight worst windows when a reply carries more (T-05.1-12)", () => {
    const byId: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) {
      byId[`limit_${i}`] = { primary: { usedPercent: i, windowDurationMins: 60 } };
    }
    const windows = windowsOf({
      rateLimits: { primary: { usedPercent: 99 } },
      rateLimitsByLimitId: byId,
      ordinaryUsageAllowed: true,
    });
    expect(windows).toHaveLength(8);
    expect(Math.max(...windows.map((w) => w.usedPercent))).toBe(99);
    expect(windows.map((w) => w.usedPercent)).toContain(39);
    expect(windows.map((w) => w.usedPercent)).not.toContain(10);
  });

  it("refuses a limits-by-id member that is not an object instead of ignoring a limit", () => {
    const base = { rateLimits: { primary: { usedPercent: 10 } }, ordinaryUsageAllowed: true };
    expect(
      unavailableReason({ ...base, rateLimitsByLimitId: [{ primary: { usedPercent: 95 } }] }),
    ).toBe("shape-changed");
    expect(unavailableReason({ ...base, rateLimitsByLimitId: "oops" })).toBe("shape-changed");
    expect(windowsOf({ ...base, rateLimitsByLimitId: null })).toHaveLength(1);
  });

  it("keeps ordinaryUsageAllowed as a boolean or null and records reached types", () => {
    const snapshot = (over: Record<string, unknown>) =>
      normalizeRateLimitsReply(weeklyReply(30, over), OPTIONS);
    expect(snapshot({ ordinaryUsageAllowed: false })).toMatchObject({
      ordinaryUsageAllowed: false,
    });
    expect(snapshot({ ordinaryUsageAllowed: null })).toMatchObject({ ordinaryUsageAllowed: null });
    expect(snapshot({ ordinaryUsageAllowed: "yes" })).toMatchObject({ ordinaryUsageAllowed: null });
    const reached = (type: unknown) =>
      normalizeRateLimitsReply(
        {
          ...(weeklyReply(30) as object),
          rateLimits: { primary: { usedPercent: 30 }, rateLimitReachedType: type },
        },
        OPTIONS,
      );
    expect(reached("rate_limit_reached")).toMatchObject({
      rateLimitReached: true,
      rateLimitReachedType: "rate_limit_reached",
    });
    expect(reached("workspace_member_usage_limit_reached")).toMatchObject({
      rateLimitReachedType: "workspace_member_usage_limit_reached",
    });
    expect(reached("a_type_from_the_future")).toMatchObject({
      rateLimitReached: true,
      rateLimitReachedType: "other",
    });
    expect(reached(null)).toMatchObject({ rateLimitReached: false, rateLimitReachedType: null });
  });

  it("carries a well-formed Codex version and drops a malformed one", () => {
    const ok = normalizeRateLimitsReply(weeklyReply(10), { ...OPTIONS, codexVersion: "0.159.2" });
    expect(ok).toMatchObject({ codexVersion: "0.159.2" });
    const bad = normalizeRateLimitsReply(weeklyReply(10), {
      ...OPTIONS,
      codexVersion: "x; rm -rf /",
    });
    expect(bad).not.toHaveProperty("codexVersion");
    const unavailable = normalizeRateLimitsReply(null, { ...OPTIONS, codexVersion: "0.159.2" });
    expect(unavailable).toMatchObject({ version: "0.159.2" });
  });

  it("is total: no input throws and every result parses with the domain schema (T-05.1-12)", () => {
    const weird: unknown[] = [
      weeklyReply(Number.MAX_VALUE),
      { rateLimits: { primary: { usedPercent: 10, resetsAt: 1e20 } } },
      { rateLimits: { primary: { usedPercent: 10, resetsAt: -1e20 } } },
      { rateLimits: { primary: { usedPercent: 10, resetsAt: "soon" } } },
      { rateLimits: { primary: { usedPercent: 10, windowDurationMins: -5 } } },
      { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 1.5 } } },
      { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 1e300 } } },
      { rateLimits: { primary: { usedPercent: 10 }, rateLimitReachedType: { a: 1 } } },
      Object.create(null),
      {
        rateLimits: { primary: { usedPercent: 10 } },
        rateLimitsByLimitId: { __proto__: { primary: { usedPercent: 3 } } },
      },
    ];
    for (const raw of weird) {
      const snapshot = normalizeRateLimitsReply(raw, OPTIONS);
      expect(CodexUsageSnapshotSchema.safeParse(snapshot).success).toBe(true);
    }
    const badClock = normalizeRateLimitsReply(weeklyReply(10), { observedAtMs: Number.NaN });
    expect(CodexUsageSnapshotSchema.safeParse(badClock).success).toBe(true);
  });

  it("never lets the account id or reset-credit data into any result (CODEX-09)", () => {
    const replies: unknown[] = [
      weeklyReply(41),
      weeklyReply(41, { rateLimitResetCredits: { available: 2, id: ACCOUNT_MARKER } }),
      { accountId: ACCOUNT_MARKER },
      { accountId: ACCOUNT_MARKER, rateLimits: "x" },
      {
        accountId: ACCOUNT_MARKER,
        rateLimits: { primary: { usedPercent: "n", extra: ACCOUNT_MARKER } },
      },
    ];
    for (const raw of replies) {
      expect(JSON.stringify(normalizeRateLimitsReply(raw, OPTIONS))).not.toContain(ACCOUNT_MARKER);
    }
  });
});

describe("normalizeRolloutRateLimits (OQ-3 fallback)", () => {
  it("Test 6: maps the snake-case rollout shape to a rollout-fallback snapshot", () => {
    const snapshot = normalizeRolloutRateLimits(
      {
        limit_id: "codex",
        limit_name: null,
        primary: { used_percent: 12.5, window_minutes: 10_080, resets_at: RESETS_AT_S },
        secondary: { used_percent: 3, window_minutes: 300, resets_at: null },
        credits: { balance: "9" },
        plan_type: "prolite",
        rate_limit_reached_type: null,
      },
      OPTIONS,
    );
    expect(snapshot).toEqual({
      kind: "available",
      windows: [
        {
          windowMinutes: 10_080,
          usedPercent: 12.5,
          resetsAt: new Date(RESETS_AT_S * 1000).toISOString(),
          limitLabel: "codex",
        },
        { windowMinutes: 300, usedPercent: 3, resetsAt: null, limitLabel: "codex" },
      ],
      ordinaryUsageAllowed: null,
      rateLimitReached: false,
      rateLimitReachedType: null,
      source: "rollout-fallback",
      observedAt: new Date(OBSERVED_AT_MS).toISOString(),
      freshness: "live",
    });
  });

  it("records a reached type and treats off-shape rollouts like off-shape replies", () => {
    expect(
      normalizeRolloutRateLimits(
        { primary: { used_percent: 90 }, rate_limit_reached_type: "rate_limit_reached" },
        OPTIONS,
      ),
    ).toMatchObject({ rateLimitReached: true, rateLimitReachedType: "rate_limit_reached" });
    expect(normalizeRolloutRateLimits("x", OPTIONS)).toMatchObject({ reason: "shape-changed" });
    expect(normalizeRolloutRateLimits({}, OPTIONS)).toMatchObject({ reason: "no-limits" });
    expect(normalizeRolloutRateLimits({ primary: { used_percent: "9" } }, OPTIONS)).toMatchObject({
      reason: "shape-changed",
    });
  });

  it("ages a fallback snapshot by the injected clock without ever naming it unavailable", () => {
    const old = normalizeRolloutRateLimits(
      { primary: { used_percent: 9, window_minutes: 60 } },
      { observedAtMs: OBSERVED_AT_MS, nowMs: OBSERVED_AT_MS + 300_000 },
    );
    expect(old).toMatchObject({
      kind: "available",
      freshness: "stale",
      source: "rollout-fallback",
    });
  });
});
