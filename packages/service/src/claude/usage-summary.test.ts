import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PRICE_TABLE_EFFECTIVE_FROM } from "@ccc/collectors";
import { type UsageSummary, UsageSummarySchema } from "@ccc/domain";
import {
  appendToggleLog,
  applyMigrations,
  markDayCovered,
  type OperationalStore,
  openStore,
  recordUsage,
  upsertCostSnapshot,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildUsageSummary,
  EMPTY_STATUS_LINE_OBSERVATION,
  rangeBounds,
  type TranscriptFacts,
} from "./usage-summary.js";

const TEST_BASE = join(homedir(), ".ccc-test");
const TZ = "America/New_York";
/** 11:00 local (EDT, UTC-4) on Sunday 2026-09-20. */
const NOW = new Date("2026-09-20T15:00:00.000Z");

let dir: string;
let store: OperationalStore;

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  dir = mkdtempSync(join(TEST_BASE, "us-"));
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function record(
  messageId: string,
  timestamp: string,
  counters: { input: number; output?: number },
  model = "claude-opus-4-8",
  claudeSessionId = "sess-1",
) {
  return {
    messageId,
    claudeSessionId,
    timestamp,
    model,
    skillKey: null,
    projectKey: null,
    counters: { input: counters.input, output: counters.output ?? 0, cacheWrite: 0, cacheRead: 0 },
  };
}

function summarize(
  transcripts: TranscriptFacts,
  options: { cleanupPeriodDays?: number; enabled?: boolean } = {},
): UsageSummary {
  const summary = buildUsageSummary({
    db: store.db,
    statusLineInstall: "not-installed",
    observation: EMPTY_STATUS_LINE_OBSERVATION,
    now: NOW,
    timeZone: TZ,
    analysis: { enabled: options.enabled ?? true, firstScanPending: false },
    cleanupPeriodDays: options.cleanupPeriodDays ?? 30,
    transcripts,
  });
  return UsageSummarySchema.parse(summary);
}

const SCANNED: TranscriptFacts = {
  verdict: { kind: "ok" },
  oldestTranscriptAt: "2026-09-17T14:00:00.000Z",
  lastScanAt: "2026-09-20T14:59:00.000Z",
};

describe("rangeBounds (D-45): local-time calendar ranges", () => {
  it("states today, the last seven days and this month from local midnight to now", () => {
    expect(rangeBounds("today", NOW, TZ)).toMatchObject({
      start: "2026-09-20T04:00:00.000Z",
      end: NOW.toISOString(),
      firstDay: "2026-09-20",
      lastDay: "2026-09-20",
    });
    expect(rangeBounds("last-7-days", NOW, TZ)).toMatchObject({
      start: "2026-09-14T04:00:00.000Z",
      firstDay: "2026-09-14",
    });
    expect(rangeBounds("this-month", NOW, TZ)).toMatchObject({
      start: "2026-09-01T04:00:00.000Z",
      firstDay: "2026-09-01",
    });
  });

  it("finds local midnight across a DST change", () => {
    // 2026-11-01 is the US fall-back day: midnight is still EDT (UTC-4),
    // and by 10:00 local it is EST (UTC-5).
    const afterFallBack = new Date("2026-11-01T15:00:00.000Z");
    expect(rangeBounds("today", afterFallBack, TZ).start).toBe("2026-11-01T04:00:00.000Z");
    expect(rangeBounds("today", new Date("2026-11-02T15:00:00.000Z"), TZ).start).toBe(
      "2026-11-02T05:00:00.000Z",
    );
  });
});

describe("token activity by range and coverage (Test 6, D-44, D-45, USAGE-09)", () => {
  beforeEach(() => {
    // On since August; off for part of 09-18 and all of 09-19's start, back on during 09-19.
    appendToggleLog(store.db, "2026-08-01T12:00:00.000Z", true);
    appendToggleLog(store.db, "2026-09-18T14:00:00.000Z", false);
    appendToggleLog(store.db, "2026-09-19T14:00:00.000Z", true);
    for (const day of ["2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"]) {
      markDayCovered(store.db, day, "2026-09-20T14:59:00.000Z");
    }
    recordUsage(
      store.db,
      [
        record("msg_1", "2026-09-17T15:00:00.000Z", { input: 100 }),
        // 01:00 local on 09-20 (05:00Z): today, by local time, not by UTC date.
        record("msg_2", "2026-09-20T05:00:00.000Z", { input: 7, output: 3 }),
        // 23:00 local on 09-19 (03:00Z on 09-20): NOT today locally.
        record("msg_3", "2026-09-20T03:00:00.000Z", { input: 40 }),
      ],
      "2026-09-20T14:59:00.000Z",
    );
  });

  it("counts today in local time, stated bounds, fully covered", () => {
    const today = summarize(SCANNED, { cleanupPeriodDays: 3 }).ranges.today.activity;
    expect(today.kind).toBe("available");
    if (today.kind !== "available") throw new Error("unreachable");
    expect(today.range).toBe("today");
    expect(today.bounds).toEqual({ start: "2026-09-20T04:00:00.000Z", end: NOW.toISOString() });
    expect(today.totals).toEqual({ input: 7, output: 3, cacheWrite: 0, cacheRead: 0 });
    expect(today.partiality.partial).toBe(false);
    expect(today.coverage).toEqual({ horizonDate: null, uncoveredDays: 0, analysisOffDays: 0 });
    expect(today.source).toBe("local-transcript-analysis");
    expect(today.freshness).toBe("live");
  });

  it("makes last-7-days partial at the retention horizon and counts analysis-off days", () => {
    const week = summarize(SCANNED, { cleanupPeriodDays: 3 }).ranges["last-7-days"].activity;
    expect(week.kind).toBe("available");
    if (week.kind !== "available") throw new Error("unreachable");
    expect(week.partiality.partial).toBe(true);
    expect(week.coverage).toEqual({
      horizonDate: "2026-09-17",
      uncoveredDays: 3,
      analysisOffDays: 2,
    });
    expect(week.totals.input).toBe(147);
  });

  it("uses the later of now − cleanupPeriodDays and the oldest surviving transcript", () => {
    const olderTranscripts = { ...SCANNED, oldestTranscriptAt: "2026-08-01T12:00:00.000Z" };
    const week = summarize(olderTranscripts, { cleanupPeriodDays: 5 }).ranges["last-7-days"];
    if (week.activity.kind !== "available") throw new Error("expected available");
    expect(week.activity.coverage.horizonDate).toBe("2026-09-15");
  });

  it("reads no-coverage, never zero, for a range without one covered day", () => {
    const fresh = openStore(join(dir, "fresh.db"));
    applyMigrations(fresh.db);
    try {
      const summary = UsageSummarySchema.parse(
        buildUsageSummary({
          db: fresh.db,
          statusLineInstall: "not-installed",
          observation: EMPTY_STATUS_LINE_OBSERVATION,
          now: NOW,
          timeZone: TZ,
          analysis: { enabled: true, firstScanPending: true },
          cleanupPeriodDays: 30,
          transcripts: { verdict: { kind: "ok" }, oldestTranscriptAt: null, lastScanAt: null },
        }),
      );
      for (const range of Object.values(summary.ranges)) {
        expect(range.activity).toEqual({
          kind: "unavailable",
          reason: "no-coverage",
          version: null,
        });
        expect(range.cost).toEqual({ kind: "unavailable", reason: "needs-activity-or-wrapper" });
      }
      expect(summary.analysis).toEqual({ enabled: true, firstScanPending: true });
    } finally {
      fresh.close();
    }
  });

  it("reads analysis-off while analysis is off, keeping the aggregates for later (D-47)", () => {
    const summary = summarize(SCANNED, { enabled: false });
    expect(summary.ranges.today.activity).toEqual({
      kind: "unavailable",
      reason: "analysis-off",
      version: null,
    });
    expect(summarize(SCANNED).ranges.today.activity.kind).toBe("available");
  });
});

describe("estimated cost basis (Test 7, D-42, USAGE-03)", () => {
  beforeEach(() => {
    appendToggleLog(store.db, "2026-08-01T12:00:00.000Z", true);
    markDayCovered(store.db, "2026-09-20", "2026-09-20T14:59:00.000Z");
  });

  it("uses list prices with the table date when no status-line snapshot exists; an unlisted model is excluded and counted", () => {
    recordUsage(
      store.db,
      [
        record("msg_p1", "2026-09-20T13:00:00.000Z", { input: 1_000_000 }),
        record("msg_p2", "2026-09-20T13:00:00.000Z", { input: 500 }, "claude-unlisted-9"),
      ],
      NOW.toISOString(),
    );
    const cost = summarize(SCANNED).ranges.today.cost;
    expect(cost.kind).toBe("available");
    if (cost.kind !== "available") throw new Error("unreachable");
    expect(cost.basis).toBe("list-prices");
    expect(cost.priceTableDate).toBe(PRICE_TABLE_EFFECTIVE_FROM);
    // claude-opus-4-8 input lists at $5 per million tokens.
    expect(cost.usd).toBeCloseTo(5, 10);
    expect(cost.excludedModelCount).toBe(1);
    expect(cost.partiality.partial).toBe(true);
    expect(cost.range).toBe("today");
    expect(cost.bounds).toEqual({ start: "2026-09-20T04:00:00.000Z", end: NOW.toISOString() });
  });

  it("uses a session's own estimate where it covers the session and list prices for the rest (mixed)", () => {
    recordUsage(
      store.db,
      [
        record("msg_m1", "2026-09-20T13:00:00.000Z", { input: 1_000_000 }, undefined, "sess-1"),
        record("msg_m2", "2026-09-20T13:00:00.000Z", { input: 1_000_000 }, undefined, "sess-2"),
      ],
      NOW.toISOString(),
    );
    upsertCostSnapshot(store.db, {
      claudeSessionId: "sess-1",
      totalCostUsd: 2,
      observedAt: "2026-09-20T14:00:00.000Z",
    });
    const cost = summarize(SCANNED).ranges.today.cost;
    if (cost.kind !== "available") throw new Error("expected available");
    expect(cost.basis).toBe("mixed");
    expect(cost.usd).toBeCloseTo(7, 10);
    expect(cost.excludedModelCount).toBe(0);
    expect(cost.partiality.partial).toBe(false);
    expect(cost.priceTableDate).toBe(PRICE_TABLE_EFFECTIVE_FROM);
  });

  it("never charges a session's estimate to a range its lifetime straddles", () => {
    recordUsage(
      store.db,
      [record("msg_s1", "2026-09-20T13:00:00.000Z", { input: 1_000_000 }, undefined, "sess-9")],
      NOW.toISOString(),
    );
    // First seen yesterday evening (local), last seen today: not wholly inside today.
    upsertCostSnapshot(store.db, {
      claudeSessionId: "sess-9",
      totalCostUsd: 40,
      observedAt: "2026-09-19T20:00:00.000Z",
    });
    upsertCostSnapshot(store.db, {
      claudeSessionId: "sess-9",
      totalCostUsd: 41,
      observedAt: "2026-09-20T14:00:00.000Z",
    });
    const summary = summarize(SCANNED);
    const today = summary.ranges.today.cost;
    if (today.kind !== "available") throw new Error("expected available");
    expect(today.basis).toBe("list-prices");
    expect(today.usd).toBeCloseTo(5, 10);
    const week = summary.ranges["last-7-days"].cost;
    if (week.kind !== "available") throw new Error("expected available");
    expect(week.basis).toBe("claude-code-estimates");
    expect(week.usd).toBe(41);
  });
});
