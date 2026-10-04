import type { ServiceEvent, SnapshotResponse, UsageSummary } from "@ccc/domain";
import { EMPTY_PROJECTS_SNAPSHOT, UsageSummarySchema } from "@ccc/domain";
import { beforeEach, describe, expect, it } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import { adoptClaudeSnapshot, applyClaudeServiceEvent } from "./claude-events.js";
import {
  applyUsageUpdated,
  claudeUsageState,
  claudeUsageStateFor,
  lastUsageEventAt,
  usageRange,
  usageSummary,
} from "./usage-signals.js";

/**
 * Task 1 (tracer): a `usage.updated` event, or a snapshot carrying usage,
 * updates `claudeUsageState` in the same tick (D-17, PATTERNS fact 4). With
 * no summary ever received, the state stays the Phase 3 honest "No source
 * yet" (`unavailable`, no reason) — never `ready` with invented zeros
 * (USAGE-06, Non-Negotiable 3).
 */

const LIVE: ConnectionState = { kind: "live" };
const CONNECTING: ConnectionState = { kind: "connecting" };
const NOW = Date.parse("2026-09-26T14:05:00.000Z");

/** A schema-valid `UsageSummary`, built and validated through the real zod
 * schema so a shape mistake in a fixture fails at construction with a real
 * zod error, not as a mysterious "applyUsageUpdated returned false". */
function summary(overrides: Record<string, unknown> = {}): UsageSummary {
  const offRange = {
    activity: { kind: "unavailable", reason: "analysis-off", version: null },
    cost: { kind: "unavailable", reason: "needs-activity-or-wrapper" },
  };
  const raw = {
    capacity: { kind: "unavailable", reason: "wrapper-not-installed", version: null },
    ranges: { today: offRange, "last-7-days": offRange, "this-month": offRange },
    analysis: { enabled: false, firstScanPending: false },
    observedAt: "2026-09-26T14:00:00.000Z",
    ...overrides,
  };
  return UsageSummarySchema.parse(raw);
}

/** A summary with all three concepts available, for freshness/partial tests. */
function readySummary(overrides: Record<string, unknown> = {}): UsageSummary {
  const bounds = { start: "2026-09-26T00:00:00.000Z", end: "2026-09-26T14:00:00.000Z" };
  const todayRange = {
    activity: {
      kind: "available",
      range: "today",
      bounds,
      totals: { input: 100, output: 50, cacheWrite: 10, cacheRead: 5 },
      byProject: [],
      byModel: [],
      bySkill: [],
      observedAt: "2026-09-26T14:00:00.000Z",
      source: "local-transcript-analysis",
      freshness: "live",
      partiality: { partial: false },
      coverage: { horizonDate: null, uncoveredDays: 0, analysisOffDays: 0 },
    },
    cost: {
      kind: "available",
      range: "today",
      bounds,
      usd: 1.2,
      basis: "claude-code-estimates",
      priceTableDate: null,
      excludedModelCount: 0,
      observedAt: "2026-09-26T14:00:00.000Z",
      source: "claude-code-estimates-and-list-prices",
      freshness: "live",
      partiality: { partial: false },
    },
  };
  const offRange = {
    activity: { kind: "unavailable", reason: "analysis-off", version: null },
    cost: { kind: "unavailable", reason: "needs-activity-or-wrapper" },
  };
  return summary({
    capacity: {
      kind: "available",
      windows: [{ window: "five-hour", usedPercent: 62, resetsAt: "2026-09-26T21:00:00.000Z" }],
      observedAt: "2026-09-26T14:00:00.000Z",
      source: "claude-code-status-line",
      freshness: "live",
      partiality: { partial: false },
    },
    ranges: { today: todayRange, "last-7-days": offRange, "this-month": offRange },
    ...overrides,
  });
}

function resetSignals(): void {
  usageSummary.value = null;
  lastUsageEventAt.value = null;
  usageRange.value = "today";
}

beforeEach(resetSignals);

describe("applyUsageUpdated: schema safety (T-05-43)", () => {
  it("applies a schema-valid usage.updated payload", () => {
    const applied = applyUsageUpdated(summary());
    expect(applied).toBe(true);
    expect(usageSummary.value).not.toBeNull();
  });

  it("ignores a payload that fails UsageSummarySchema, and the previous state stands", () => {
    applyUsageUpdated(summary());
    const before = usageSummary.value;
    const applied = applyUsageUpdated({ capacity: { kind: "not-a-real-kind" } });
    expect(applied).toBe(false);
    expect(usageSummary.value).toBe(before);
  });

  it("ignores a payload with no usable shape at all", () => {
    expect(applyUsageUpdated("not even an object")).toBe(false);
    expect(applyUsageUpdated(null)).toBe(false);
  });
});

describe("applyClaudeServiceEvent: usage.updated dispatch (05-06 hand-off)", () => {
  it("dispatches usage.updated to applyUsageUpdated and advances lastUsageEventAt on success", () => {
    const event: ServiceEvent = {
      id: 1,
      type: "usage.updated",
      occurredAt: "2026-09-26T14:01:00.000Z",
      payload: summary(),
    };
    applyClaudeServiceEvent(event);
    expect(usageSummary.value).not.toBeNull();
    expect(lastUsageEventAt.value).toBe("2026-09-26T14:01:00.000Z");
  });

  it("does not advance lastUsageEventAt when the payload is invalid", () => {
    const event: ServiceEvent = {
      id: 2,
      type: "usage.updated",
      occurredAt: "2026-09-26T14:02:00.000Z",
      payload: { not: "a summary" },
    };
    applyClaudeServiceEvent(event);
    expect(usageSummary.value).toBeNull();
    expect(lastUsageEventAt.value).toBeNull();
  });
});

describe("adoptClaudeSnapshot: usage adoption (Test 6, ADR-0007)", () => {
  it("adopts state.usage from a full-resync snapshot", () => {
    const snapshot: SnapshotResponse = {
      lastEventId: 5,
      state: {
        serviceStartedAt: "2026-09-26T00:00:00.000Z",
        projects: EMPTY_PROJECTS_SNAPSHOT,
        usage: summary(),
      },
    };
    adoptClaudeSnapshot(snapshot);
    expect(usageSummary.value).not.toBeNull();
  });

  it("leaves usageSummary unchanged when the snapshot carries no usage field (an older service)", () => {
    applyUsageUpdated(summary());
    const before = usageSummary.value;
    const snapshot: SnapshotResponse = {
      lastEventId: 6,
      state: { serviceStartedAt: "2026-09-26T00:00:00.000Z", projects: EMPTY_PROJECTS_SNAPSHOT },
    };
    adoptClaudeSnapshot(snapshot);
    expect(usageSummary.value).toBe(before);
  });
});

describe("claudeUsageStateFor: no summary is honestly unavailable, never zero (Test 5, USAGE-06)", () => {
  it("with no summary ever received, the state is unavailable with no reason, regardless of connection", () => {
    expect(claudeUsageStateFor(LIVE, null, NOW)).toEqual({ kind: "unavailable" });
    expect(claudeUsageStateFor(CONNECTING, null, NOW)).toEqual({ kind: "unavailable" });
  });

  it("claudeUsageState starts unavailable on a fresh module load (registry.test.ts parity)", () => {
    expect(claudeUsageState.value.kind).toBe("unavailable");
  });
});

describe("claudeUsageStateFor: a received summary is always ready, never zero-as-unavailable", () => {
  it("a summary with every concept off/not-installed is still ready — off is not unavailable (R-10)", () => {
    const state = claudeUsageStateFor(LIVE, summary(), NOW);
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.data.summary.capacity.kind).toBe("unavailable");
    expect(state.isEmpty).toBe(false);
    expect(state.freshness).not.toBe("unavailable");
  });

  it("freshness is the least fresh of the concepts producing numbers (R-10)", () => {
    const stale = readySummary({
      capacity: {
        kind: "available",
        windows: [{ window: "five-hour", usedPercent: 10, resetsAt: "2026-09-26T21:00:00.000Z" }],
        observedAt: "2026-09-26T13:00:00.000Z",
        source: "claude-code-status-line",
        freshness: "stale",
        partiality: { partial: false },
      },
    });
    const state = claudeUsageStateFor(LIVE, stale, NOW);
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.freshness).toBe("stale");
  });

  it("partiality.partial is true when any available concept is partial (R-10)", () => {
    const partial = readySummary();
    const withPartialActivity: UsageSummary = {
      ...partial,
      ranges: {
        ...partial.ranges,
        today: {
          ...partial.ranges.today,
          activity: {
            ...(partial.ranges.today.activity as Extract<
              UsageSummary["ranges"]["today"]["activity"],
              { kind: "available" }
            >),
            partiality: { partial: true, missingSources: [] },
          },
        },
      },
    };
    const state = claudeUsageStateFor(LIVE, withPartialActivity, NOW);
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.partiality.partial).toBe(true);
  });

  it("observedAt is the summary's own observedAt, never Date.now()", () => {
    const state = claudeUsageStateFor(LIVE, summary(), NOW);
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.observedAt).toBe("2026-09-26T14:00:00.000Z");
  });
});

describe("card freshness and partiality follow the selected range (wave 3 review, R-10)", () => {
  /** Today live and complete; the last 7 days stale and partial. */
  function splitSummary(): UsageSummary {
    const base = readySummary();
    const today = base.ranges.today;
    if (today.activity.kind !== "available" || today.cost.kind !== "available") {
      throw new Error("expected available today");
    }
    return {
      ...base,
      ranges: {
        ...base.ranges,
        "last-7-days": {
          activity: {
            ...today.activity,
            range: "last-7-days",
            freshness: "stale",
            partiality: { partial: true, missingSources: [] },
          },
          cost: { ...today.cost, range: "last-7-days", freshness: "stale" },
        },
      },
    };
  }

  it("reads today's concepts by default and the selected range's when one is given", () => {
    const s = splitSummary();
    const today = claudeUsageStateFor(LIVE, s, NOW);
    if (today.kind !== "ready") throw new Error("expected ready");
    expect(today.freshness).toBe("live");
    expect(today.partiality.partial).toBe(false);

    const week = claudeUsageStateFor(LIVE, s, NOW, "last-7-days");
    if (week.kind !== "ready") throw new Error("expected ready");
    expect(week.freshness).toBe("stale");
    expect(week.partiality).toEqual({
      partial: true,
      missingSources: ["Local transcript analysis"],
    });
  });

  it("claudeUsageState follows the usageRange view-state signal", () => {
    usageSummary.value = splitSummary();
    const before = claudeUsageState.value;
    if (before.kind !== "ready") throw new Error("expected ready");
    expect(before.freshness).toBe("live");
    usageRange.value = "last-7-days";
    const after = claudeUsageState.value;
    if (after.kind !== "ready") throw new Error("expected ready");
    expect(after.freshness).toBe("stale");
    expect(after.partiality.partial).toBe(true);
  });
});
