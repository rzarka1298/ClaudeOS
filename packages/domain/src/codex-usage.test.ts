import { describe, expect, it } from "vitest";
import {
  ClaudeHeadroomViewSchema,
  CODEX_HEADROOM_REASONS,
  CODEX_RESERVE_PERCENT,
  CODEX_USAGE_LIVE_MAX_AGE_MS,
  CODEX_USAGE_STALE_MAX_AGE_MS,
  CODEX_USAGE_UNAVAILABLE_REASONS,
  CODEX_WEEKLY_WINDOW_MINUTES,
  CodexHeadroomSchema,
  CodexUsageSnapshotSchema,
  HeadroomSignalSchema,
} from "./codex-usage.js";

const OBSERVED_AT = "2026-10-10T12:00:00.000Z";
const RESETS_AT = "2026-10-14T16:40:00.000Z";

const weekly = {
  windowMinutes: 10080,
  usedPercent: 41,
  resetsAt: RESETS_AT,
  limitLabel: null,
};

function available(overrides: Record<string, unknown> = {}) {
  return {
    kind: "available",
    windows: [weekly],
    ordinaryUsageAllowed: true,
    rateLimitReached: false,
    rateLimitReachedType: null,
    source: "app-server",
    observedAt: OBSERVED_AT,
    freshness: "live",
    ...overrides,
  };
}

function unavailable(overrides: Record<string, unknown> = {}) {
  return {
    kind: "unavailable",
    reason: "read-failed",
    version: null,
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

describe("CodexUsageSnapshotSchema (CODEX-08, D-23)", () => {
  it("Test 1: parses an available snapshot with one weekly window and refuses out-of-range percentages and window counts", () => {
    expect(CodexUsageSnapshotSchema.safeParse(available()).success).toBe(true);
    for (const usedPercent of [101, -1]) {
      expect(
        CodexUsageSnapshotSchema.safeParse(available({ windows: [{ ...weekly, usedPercent }] }))
          .success,
      ).toBe(false);
    }
    expect(CodexUsageSnapshotSchema.safeParse(available({ windows: [] })).success).toBe(false);
    expect(
      CodexUsageSnapshotSchema.safeParse(
        available({ windows: Array.from({ length: 9 }, () => weekly) }),
      ).success,
    ).toBe(false);
    expect(
      CodexUsageSnapshotSchema.safeParse(
        available({ windows: Array.from({ length: 8 }, () => weekly) }),
      ).success,
    ).toBe(true);
  });

  it("refuses an available snapshot that claims unavailable freshness", () => {
    expect(
      CodexUsageSnapshotSchema.safeParse(available({ freshness: "unavailable" })).success,
    ).toBe(false);
  });

  it("accepts the rollout fallback source and refuses an unknown source", () => {
    expect(
      CodexUsageSnapshotSchema.safeParse(available({ source: "rollout-fallback" })).success,
    ).toBe(true);
    expect(CodexUsageSnapshotSchema.safeParse(available({ source: "auth-json" })).success).toBe(
      false,
    );
  });

  it("Test 2: parses every unavailable reason, with a version or null, and refuses any numeric key", () => {
    expect([...CODEX_USAGE_UNAVAILABLE_REASONS]).toEqual([
      "read-failed",
      "shape-changed",
      "no-limits",
      "too-old",
    ]);
    for (const reason of CODEX_USAGE_UNAVAILABLE_REASONS) {
      expect(CodexUsageSnapshotSchema.safeParse(unavailable({ reason })).success).toBe(true);
      expect(
        CodexUsageSnapshotSchema.safeParse(unavailable({ reason, version: "0.159.2" })).success,
      ).toBe(true);
    }
    for (const extra of [
      { usedPercent: 0 },
      { windows: [] },
      { windows: [weekly] },
      { count: 0 },
    ]) {
      expect(CodexUsageSnapshotSchema.safeParse(unavailable(extra)).success).toBe(false);
    }
  });

  it("Test 3: parses a null window and a safe limit label, and refuses unsafe labels", () => {
    const nullWindow = {
      windowMinutes: null,
      usedPercent: 12.5,
      resetsAt: null,
      limitLabel: "Usage window",
    };
    expect(CodexUsageSnapshotSchema.safeParse(available({ windows: [nullWindow] })).success).toBe(
      true,
    );
    for (const limitLabel of ["a/b", "line\nbreak", "x".repeat(41), ""]) {
      expect(
        CodexUsageSnapshotSchema.safeParse(available({ windows: [{ ...weekly, limitLabel }] }))
          .success,
      ).toBe(false);
    }
    expect(
      CodexUsageSnapshotSchema.safeParse(
        available({ windows: [{ ...weekly, limitLabel: "x".repeat(40) }] }),
      ).success,
    ).toBe(true);
  });

  it("refuses a non-positive or fractional window length", () => {
    for (const windowMinutes of [0, -5, 1.5]) {
      expect(
        CodexUsageSnapshotSchema.safeParse(available({ windows: [{ ...weekly, windowMinutes }] }))
          .success,
      ).toBe(false);
    }
  });

  it("accepts the allowlisted reached types and refuses others", () => {
    expect(
      CodexUsageSnapshotSchema.safeParse(
        available({ rateLimitReached: true, rateLimitReachedType: "rate_limit_reached" }),
      ).success,
    ).toBe(true);
    expect(
      CodexUsageSnapshotSchema.safeParse(available({ rateLimitReachedType: "other" })).success,
    ).toBe(true);
    expect(
      CodexUsageSnapshotSchema.safeParse(available({ rateLimitReachedType: "anything goes" }))
        .success,
    ).toBe(false);
  });

  it("guards the optional Codex version string", () => {
    expect(CodexUsageSnapshotSchema.safeParse(available({ codexVersion: "0.159.2" })).success).toBe(
      true,
    );
    expect(
      CodexUsageSnapshotSchema.safeParse(available({ codexVersion: "../../etc" })).success,
    ).toBe(false);
  });
});

function allowSignal(overrides: Record<string, unknown> = {}) {
  return {
    verdict: "allow",
    reason: null,
    worstWindow: { windowMinutes: 10080, usedPercent: 41, resetsAt: RESETS_AT },
    source: "app-server",
    observedAt: OBSERVED_AT,
    freshness: "live",
    pausedRuns: { count: 0, earliestResetAt: null },
    ...overrides,
  };
}

function claudeAvailable(overrides: Record<string, unknown> = {}) {
  return {
    kind: "available",
    window: "five-hour",
    usedPercent: 62,
    resetsAt: "2026-10-10T16:40:00.000Z",
    source: "claude-code-status-line",
    observedAt: OBSERVED_AT,
    freshness: "cached",
    ...overrides,
  };
}

function signal(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: OBSERVED_AT,
    codex: allowSignal(),
    claude: claudeAvailable(),
    ...overrides,
  };
}

describe("HeadroomSignalSchema (CODEX-11, CODEX-12, D-04, D-22)", () => {
  it("Test 4: orders the five refusal reasons as the UI-SPEC table does", () => {
    expect([...CODEX_HEADROOM_REASONS]).toEqual([
      "reserve-line",
      "usage-not-allowed",
      "paused-run",
      "no-live-read",
      "usage-unavailable",
    ]);
  });

  it("parses an allow signal with a null reason and a refuse signal for each reason", () => {
    expect(HeadroomSignalSchema.safeParse(signal()).success).toBe(true);
    for (const reason of CODEX_HEADROOM_REASONS) {
      const parsed = HeadroomSignalSchema.safeParse(
        signal({ codex: allowSignal({ verdict: "refuse", reason }) }),
      );
      expect(parsed.success, reason).toBe(true);
    }
  });

  it("refuses an allow with a reason and a refuse without one", () => {
    expect(
      HeadroomSignalSchema.safeParse(
        signal({ codex: allowSignal({ verdict: "allow", reason: "reserve-line" }) }),
      ).success,
    ).toBe(false);
    expect(
      HeadroomSignalSchema.safeParse(
        signal({ codex: allowSignal({ verdict: "refuse", reason: null }) }),
      ).success,
    ).toBe(false);
  });

  it("parses a refusal with no worst window, no observation and an unavailable freshness", () => {
    const codex = allowSignal({
      verdict: "refuse",
      reason: "usage-unavailable",
      worstWindow: null,
      source: null,
      observedAt: null,
      freshness: "unavailable",
    });
    expect(HeadroomSignalSchema.safeParse(signal({ codex })).success).toBe(true);
  });

  it("refuses routing members on the signal and on the Codex member", () => {
    for (const extra of [
      { recommendedAgent: "codex" },
      { ranking: ["codex", "claude"] },
      { dispatch: true },
    ]) {
      expect(HeadroomSignalSchema.safeParse(signal(extra)).success).toBe(false);
      expect(HeadroomSignalSchema.safeParse(signal({ codex: allowSignal(extra) })).success).toBe(
        false,
      );
      expect(
        HeadroomSignalSchema.safeParse(signal({ claude: claudeAvailable(extra) })).success,
      ).toBe(false);
    }
  });

  it("has exactly three keys: generatedAt, codex and claude", () => {
    expect(Object.keys(HeadroomSignalSchema.shape).sort()).toEqual([
      "claude",
      "codex",
      "generatedAt",
    ]);
  });

  it("carries the paused-run summary as a non-negative count and an earliest reset or null", () => {
    expect(
      CodexHeadroomSchema.safeParse(
        allowSignal({
          verdict: "refuse",
          reason: "paused-run",
          pausedRuns: { count: 2, earliestResetAt: RESETS_AT },
        }),
      ).success,
    ).toBe(true);
    expect(
      CodexHeadroomSchema.safeParse(
        allowSignal({ pausedRuns: { count: -1, earliestResetAt: null } }),
      ).success,
    ).toBe(false);
  });

  it("Test 5: parses the Claude member available and unavailable, the latter with no number", () => {
    expect(ClaudeHeadroomViewSchema.safeParse(claudeAvailable()).success).toBe(true);
    expect(
      ClaudeHeadroomViewSchema.safeParse(claudeAvailable({ window: "seven-day" })).success,
    ).toBe(true);
    expect(ClaudeHeadroomViewSchema.safeParse(claudeAvailable({ window: "monthly" })).success).toBe(
      false,
    );
    for (const reason of [
      "wrapper-not-installed",
      "no-report-yet",
      "sign-in-no-limits",
      "shape-changed",
    ]) {
      expect(ClaudeHeadroomViewSchema.safeParse({ kind: "unavailable", reason }).success).toBe(
        true,
      );
    }
    expect(
      ClaudeHeadroomViewSchema.safeParse({
        kind: "unavailable",
        reason: "no-report-yet",
        usedPercent: 0,
      }).success,
    ).toBe(false);
    expect(ClaudeHeadroomViewSchema.safeParse(claudeAvailable({ verdict: "allow" })).success).toBe(
      false,
    );
  });
});

describe("constants", () => {
  it("Test 6: pins the reserve line, the weekly window and the max ages (Assumption A11)", () => {
    expect(CODEX_RESERVE_PERCENT).toBe(80);
    expect(CODEX_WEEKLY_WINDOW_MINUTES).toBe(10080);
    expect(CODEX_USAGE_LIVE_MAX_AGE_MS).toBe(120_000);
    expect(CODEX_USAGE_STALE_MAX_AGE_MS).toBe(600_000);
  });
});

/** Every property name reachable through a zod schema's shape, however deeply nested. */
function shapeKeys(root: unknown): Set<string> {
  const keys = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    if ("shape" in node && typeof node.shape === "object" && node.shape !== null) {
      for (const key of Object.keys(node.shape)) keys.add(key);
    }
    for (const value of Object.values(node)) visit(value);
    if ("_zod" in node) visit((node as { _zod: unknown })._zod);
  };
  visit(root);
  return keys;
}

describe("structural privacy (CODEX-09, D-05)", () => {
  it("Test 7: no schema in the module declares an account, credit or auth field", () => {
    const forbidden = [
      "accountId",
      "account",
      "credits",
      "resetCredit",
      "rateLimitResetCredits",
      "auth",
      "planType",
      "price",
      "creatorAccountId",
    ];
    for (const schema of [CodexUsageSnapshotSchema, HeadroomSignalSchema]) {
      const keys = shapeKeys(schema);
      expect(keys.size).toBeGreaterThan(8);
      for (const name of forbidden) expect(keys.has(name), name).toBe(false);
    }
  });

  it("the walker does see nested keys (guards against a vacuous test)", () => {
    const keys = shapeKeys(HeadroomSignalSchema);
    expect(keys.has("pausedRuns")).toBe(true);
    expect(keys.has("earliestResetAt")).toBe(true);
    expect(shapeKeys(CodexUsageSnapshotSchema).has("limitLabel")).toBe(true);
  });
});
