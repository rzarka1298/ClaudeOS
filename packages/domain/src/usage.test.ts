import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ClaudeIntegrationStatusSchema } from "./claude-integration.js";
import { StatusLineSnapshotSchema } from "./claude-statusline.js";
import {
  EstimatedApiCostSchema,
  PlanCapacitySchema,
  SessionUsageSchema,
  TokenActivitySchema,
  USAGE_RANGES,
  UsageBoundsSchema,
  UsageSummarySchema,
} from "./usage.js";

const OBSERVED_AT = "2026-09-26T14:05:00.000Z";
const LIVE = { freshness: "live", partiality: { partial: false } } as const;

const counters = (n: number) => ({ input: n, output: n, cacheWrite: n, cacheRead: n });

function availableCapacity(windows: unknown[]) {
  return {
    kind: "available",
    windows,
    observedAt: OBSERVED_AT,
    source: "claude-code-status-line",
    ...LIVE,
  };
}

const FIVE_HOUR = { window: "five-hour", usedPercent: 62, resetsAt: "2026-09-26T16:40:00.000Z" };
const SEVEN_DAY = { window: "seven-day", usedPercent: 18, resetsAt: "2026-10-01T00:00:00.000Z" };

function availableActivity(range = "today") {
  return {
    kind: "available",
    range,
    bounds: { start: "2026-09-26T00:00:00.000Z", end: OBSERVED_AT },
    totals: counters(10),
    byProject: [
      { projectId: "proj-1", projectName: "Alpha", counters: counters(6) },
      { projectId: null, projectName: null, counters: counters(4) },
    ],
    byModel: [{ model: "claude-opus-4-5", counters: counters(10) }],
    bySkill: [],
    observedAt: OBSERVED_AT,
    source: "local-transcript-analysis",
    ...LIVE,
    coverage: { horizonDate: "2026-08-27", uncoveredDays: 0, analysisOffDays: 0 },
  };
}

function availableCost(range = "today", overrides: Record<string, unknown> = {}) {
  return {
    kind: "available",
    range,
    bounds: { start: "2026-09-26T00:00:00.000Z", end: OBSERVED_AT },
    usd: 12.4,
    basis: "claude-code-estimates",
    priceTableDate: null,
    excludedModelCount: 0,
    observedAt: OBSERVED_AT,
    source: "claude-code-estimates-and-list-prices",
    ...LIVE,
    ...overrides,
  };
}

describe("PlanCapacitySchema — available (Test 1, D-37)", () => {
  it("accepts an available plan capacity with both windows", () => {
    expect(PlanCapacitySchema.safeParse(availableCapacity([FIVE_HOUR, SEVEN_DAY])).success).toBe(
      true,
    );
  });

  it("accepts a single window", () => {
    expect(PlanCapacitySchema.safeParse(availableCapacity([FIVE_HOUR])).success).toBe(true);
  });

  it("rejects usedPercent above 100 and below 0", () => {
    for (const usedPercent of [101, -1]) {
      const capacity = availableCapacity([{ ...FIVE_HOUR, usedPercent }]);
      expect(PlanCapacitySchema.safeParse(capacity).success).toBe(false);
    }
  });

  it("rejects zero windows, three windows and a repeated window", () => {
    for (const windows of [[], [FIVE_HOUR, SEVEN_DAY, FIVE_HOUR], [FIVE_HOUR, FIVE_HOUR]]) {
      expect(PlanCapacitySchema.safeParse(availableCapacity(windows)).success).toBe(false);
    }
  });

  it("requires its source, observedAt, freshness and partiality", () => {
    for (const key of ["source", "observedAt", "freshness", "partiality"]) {
      const capacity: Record<string, unknown> = availableCapacity([FIVE_HOUR]);
      delete capacity[key];
      expect(PlanCapacitySchema.safeParse(capacity).success).toBe(false);
    }
  });
});

describe("PlanCapacitySchema — unavailable is never a number (Test 2, D-38, USAGE-06)", () => {
  it.each([["wrapper-not-installed"], ["no-report-yet"], ["sign-in-no-limits"], ["shape-changed"]])(
    "accepts the unavailable reason %s",
    (reason) => {
      const result = PlanCapacitySchema.safeParse({ kind: "unavailable", reason, version: null });
      expect(result.success).toBe(true);
    },
  );

  it("rejects an unavailable capacity carrying usedPercent: 0", () => {
    const result = PlanCapacitySchema.safeParse({
      kind: "unavailable",
      reason: "wrapper-not-installed",
      version: null,
      usedPercent: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unavailable capacity carrying windows", () => {
    const result = PlanCapacitySchema.safeParse({
      kind: "unavailable",
      reason: "no-report-yet",
      version: null,
      windows: [FIVE_HOUR],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unlisted reason", () => {
    const result = PlanCapacitySchema.safeParse({
      kind: "unavailable",
      reason: "zero",
      version: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("TokenActivitySchema (Test 3, D-40..D-45)", () => {
  it("accepts an available value with totals, breakdowns, coverage and provenance", () => {
    expect(TokenActivitySchema.safeParse(availableActivity()).success).toBe(true);
  });

  it("rejects a negative or fractional counter", () => {
    for (const bad of [-1, 1.5]) {
      const activity = { ...availableActivity(), totals: { ...counters(1), input: bad } };
      expect(TokenActivitySchema.safeParse(activity).success).toBe(false);
    }
  });

  it("rejects an unknown range", () => {
    expect(TokenActivitySchema.safeParse(availableActivity("forever")).success).toBe(false);
  });

  it("accepts each unavailable reason and carries no counters", () => {
    for (const unavailable of [
      { kind: "unavailable", reason: "analysis-off", version: null },
      { kind: "unavailable", reason: "format-changed", version: "2.1.290" },
      { kind: "unavailable", reason: "no-coverage", version: null },
    ]) {
      expect(TokenActivitySchema.safeParse(unavailable).success).toBe(true);
      expect(TokenActivitySchema.safeParse({ ...unavailable, totals: counters(0) }).success).toBe(
        false,
      );
    }
  });

  it("requires the version that changed the format", () => {
    const result = TokenActivitySchema.safeParse({
      kind: "unavailable",
      reason: "format-changed",
      version: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("EstimatedApiCostSchema (Test 4, D-42)", () => {
  it("accepts a cost from Claude Code's own estimates without a price-table date", () => {
    expect(EstimatedApiCostSchema.safeParse(availableCost()).success).toBe(true);
  });

  it.each([["list-prices"], ["mixed"]])(
    "requires a priceTableDate when the basis is %s",
    (basis) => {
      expect(EstimatedApiCostSchema.safeParse(availableCost("today", { basis })).success).toBe(
        false,
      );
      expect(
        EstimatedApiCostSchema.safeParse(
          availableCost("today", { basis, priceTableDate: "2026-09-01" }),
        ).success,
      ).toBe(true);
    },
  );

  it("rejects a negative usd, a missing excludedModelCount and an unknown basis", () => {
    expect(EstimatedApiCostSchema.safeParse(availableCost("today", { usd: -0.01 })).success).toBe(
      false,
    );
    const noExcluded: Record<string, unknown> = availableCost();
    delete noExcluded.excludedModelCount;
    expect(EstimatedApiCostSchema.safeParse(noExcluded).success).toBe(false);
    expect(
      EstimatedApiCostSchema.safeParse(availableCost("today", { basis: "invoice" })).success,
    ).toBe(false);
  });

  it("accepts the unavailable variant with its one reason", () => {
    expect(
      EstimatedApiCostSchema.safeParse({ kind: "unavailable", reason: "needs-activity-or-wrapper" })
        .success,
    ).toBe(true);
  });
});

describe("available usage values are never freshness unavailable (ADR-0002)", () => {
  it.each([
    ["PlanCapacitySchema", PlanCapacitySchema, () => availableCapacity([FIVE_HOUR])],
    ["TokenActivitySchema", TokenActivitySchema, () => availableActivity()],
    ["EstimatedApiCostSchema", EstimatedApiCostSchema, () => availableCost()],
  ] as const)(
    "%s rejects an available value whose freshness is unavailable",
    (_, schema, build) => {
      for (const freshness of ["live", "cached", "stale"]) {
        expect(schema.safeParse({ ...build(), freshness }).success).toBe(true);
      }
      const result = schema.safeParse({ ...build(), freshness: "unavailable" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("freshness");
      }
    },
  );
});

describe("UsageSummarySchema (Test 5, PR-23)", () => {
  function summary() {
    return {
      capacity: { kind: "unavailable", reason: "wrapper-not-installed", version: null },
      ranges: Object.fromEntries(
        USAGE_RANGES.map((range) => [
          range,
          { activity: availableActivity(range), cost: availableCost(range) },
        ]),
      ),
      analysis: { enabled: true, firstScanPending: false },
      observedAt: OBSERVED_AT,
    };
  }

  it("declares the three ranges in order", () => {
    expect([...USAGE_RANGES]).toEqual(["today", "last-7-days", "this-month"]);
  });

  it("accepts capacity plus exactly the three ranges and the analysis flags", () => {
    expect(UsageSummarySchema.safeParse(summary()).success).toBe(true);
  });

  it("rejects a summary missing a range or carrying an extra one", () => {
    const missing = summary();
    delete (missing.ranges as Record<string, unknown>)["this-month"];
    expect(UsageSummarySchema.safeParse(missing).success).toBe(false);
    const extra = summary();
    (extra.ranges as Record<string, unknown>).forever = (
      extra.ranges as Record<string, unknown>
    ).today;
    expect(UsageSummarySchema.safeParse(extra).success).toBe(false);
  });

  it("rejects a range whose activity reports a different range", () => {
    const mismatched = summary();
    (mismatched.ranges as Record<string, unknown>).today = {
      activity: availableActivity("this-month"),
      cost: availableCost("today"),
    };
    expect(UsageSummarySchema.safeParse(mismatched).success).toBe(false);
  });

  it("requires the analysis flags as booleans", () => {
    const bad = { ...summary(), analysis: { enabled: "yes", firstScanPending: false } };
    expect(UsageSummarySchema.safeParse(bad).success).toBe(false);
  });

  it("accepts per-session usage for the detail pane", () => {
    const result = SessionUsageSchema.safeParse({
      runId: "0mfk1a2b3c4d5e6f7a8b9c0d1",
      activity: availableActivity("session"),
      cost: availableCost("session"),
    });
    expect(result.success).toBe(true);
  });

  it("pins per-Session usage to range 'session', never a summary range", () => {
    for (const range of USAGE_RANGES) {
      for (const [activity, cost] of [
        [availableActivity(range), availableCost("session")],
        [availableActivity("session"), availableCost(range)],
      ]) {
        expect(
          SessionUsageSchema.safeParse({ runId: "0mfk1a2b3c4d5e6f7a8b9c0d1", activity, cost })
            .success,
        ).toBe(false);
      }
    }
    expect(
      SessionUsageSchema.safeParse({
        runId: "0mfk1a2b3c4d5e6f7a8b9c0d1",
        activity: { kind: "unavailable", reason: "analysis-off", version: null },
        cost: { kind: "unavailable", reason: "needs-activity-or-wrapper" },
      }).success,
    ).toBe(true);
  });

  it("orders bounds: start after end is rejected", () => {
    expect(
      UsageBoundsSchema.safeParse({ start: OBSERVED_AT, end: "2026-09-26T00:00:00.000Z" }).success,
    ).toBe(false);
    expect(UsageBoundsSchema.safeParse({ start: OBSERVED_AT, end: OBSERVED_AT }).success).toBe(
      true,
    );
  });
});

describe("StatusLineSnapshotSchema (Test 6, PR-14)", () => {
  function snapshot(extra: Record<string, unknown> = {}) {
    return {
      eventId: randomUUID(),
      observedAt: OBSERVED_AT,
      session_id: "0f3c2a8e-5b1d-4c7e-9a2f-1e6d8b4c3a90",
      ...extra,
    };
  }

  it("accepts the envelope alone", () => {
    expect(StatusLineSnapshotSchema.safeParse(snapshot()).success).toBe(true);
  });

  it("accepts every forwarded usage and identity field", () => {
    const result = StatusLineSnapshotSchema.safeParse(
      snapshot({
        session_name: "Fix the parser",
        model_id: "claude-opus-4-5",
        version: "2.1.283",
        cost_total_usd: 1.25,
        effort_level: "high",
        rate_limits: {
          five_hour: { used_percentage: 62, resets_at: "2026-09-26T16:40:00.000Z" },
          seven_day: { used_percentage: 18, resets_at: 1790000000 },
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("strips repository, pull-request and worktree keys at every level", () => {
    const result = StatusLineSnapshotSchema.safeParse(
      snapshot({
        workspace: { repo: "private-repo-name", current_dir: "/Users/USERNAME/code" },
        pr: { number: 12, title: "private" },
        worktree: { name: "fix-parser", path: "/Users/USERNAME/code/wt" },
        rate_limits: {
          five_hour: { used_percentage: 5, resets_at: 1790000000, repo: "private-repo-name" },
        },
      }),
    );
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("workspace");
    expect(result.data).not.toHaveProperty("pr");
    expect(result.data).not.toHaveProperty("worktree");
    expect(JSON.stringify(result.data)).not.toContain("private");
    expect(JSON.stringify(result.data)).not.toContain("/Users/");
  });

  it("rejects a used_percentage above 100 and a negative cost", () => {
    expect(
      StatusLineSnapshotSchema.safeParse(
        snapshot({ rate_limits: { five_hour: { used_percentage: 101, resets_at: 1 } } }),
      ).success,
    ).toBe(false);
    expect(StatusLineSnapshotSchema.safeParse(snapshot({ cost_total_usd: -1 })).success).toBe(
      false,
    );
  });

  it("requires session_id", () => {
    const record: Record<string, unknown> = snapshot();
    delete record.session_id;
    expect(StatusLineSnapshotSchema.safeParse(record).success).toBe(false);
  });
});

describe("ClaudeIntegrationStatusSchema (Test 7, PR-24)", () => {
  const base = {
    hooks: "not-installed",
    hookRuntimeMissing: false,
    disableAllHooks: null,
    lastEventAt: null,
    telemetry: { kind: "ok" },
    detectedClaudeVersion: null,
    statusLine: "not-installed",
    statusLineReported: false,
    transcriptAnalysis: { enabled: false },
    spoolDropCount: 0,
    unknownEventCount: 0,
    cleanupPeriodDays: 30,
  };

  it("parses the not-installed form", () => {
    expect(ClaudeIntegrationStatusSchema.safeParse(base).success).toBe(true);
  });

  it("parses the installed form with a last event", () => {
    const installed = {
      ...base,
      hooks: "installed",
      disableAllHooks: false,
      lastEventAt: OBSERVED_AT,
      detectedClaudeVersion: "2.1.283",
      statusLine: "installed",
      statusLineReported: true,
      transcriptAnalysis: { enabled: true },
    };
    expect(ClaudeIntegrationStatusSchema.safeParse(installed).success).toBe(true);
  });

  it("parses the shape-changed and unsupported-version telemetry forms", () => {
    for (const telemetry of [
      { kind: "shape-changed", version: "2.1.290" },
      { kind: "shape-changed", version: null },
      { kind: "unsupported-version", version: "2.1.100" },
    ]) {
      expect(ClaudeIntegrationStatusSchema.safeParse({ ...base, telemetry }).success).toBe(true);
    }
  });

  it("rejects a cleanupPeriodDays below 1 and an extra key", () => {
    expect(ClaudeIntegrationStatusSchema.safeParse({ ...base, cleanupPeriodDays: 0 }).success).toBe(
      false,
    );
    expect(
      ClaudeIntegrationStatusSchema.safeParse({ ...base, settingsPath: "/Users/USERNAME/.claude" })
        .success,
    ).toBe(false);
  });
});
