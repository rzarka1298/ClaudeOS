import { CodexTokenSummarySchema } from "@ccc/domain";
import { appendToggleLog, markCodexDayCovered, upsertTurnTokens } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTempStore, type TempStore } from "../test-support/codex-token-fixtures.js";
import { buildCodexTokenSummary } from "./token-summary.js";

const NOW = new Date("2026-10-10T12:00:00.000Z");

let temp: TempStore;

beforeEach(() => {
  temp = openTempStore();
});
afterEach(() => temp.cleanup());

function counters(total: number) {
  return {
    input: total,
    cachedInput: 0,
    cacheWrite: 0,
    output: 0,
    reasoningOutput: 0,
    total,
  };
}

function seedTurn(turnId: string, bucketStart: string, total: number): void {
  upsertTurnTokens(temp.db, {
    threadId: "thread-aaaa1111",
    turnId,
    bucketStart,
    counters: counters(total),
    observedAt: bucketStart,
  });
}

function coverAll(): void {
  for (let day = 1; day <= 10; day += 1) {
    markCodexDayCovered(temp.db, `2026-10-${String(day).padStart(2, "0")}`, NOW.toISOString());
  }
}

function summarise(over: Partial<Parameters<typeof buildCodexTokenSummary>[0]> = {}) {
  return buildCodexTokenSummary({
    db: temp.db,
    now: NOW,
    timeZone: "UTC",
    analysisOn: true,
    firstScanPending: false,
    recognition: { kind: "ok" },
    lastScanAt: "2026-10-10T11:58:00.000Z",
    ...over,
  });
}

describe("Task 1: buildCodexTokenSummary, the available path and analysis-off", () => {
  it("splits turns across today, the last 7 days and this month with the stated bounds and source", () => {
    seedTurn("turn-0001", "2026-10-10T09:00:00.000Z", 100);
    seedTurn("turn-0002", "2026-10-06T09:00:00.000Z", 20);
    seedTurn("turn-0003", "2026-10-02T09:00:00.000Z", 3);
    coverAll();

    const summary = summarise();

    expect(CodexTokenSummarySchema.safeParse(summary).success).toBe(true);
    const totals = (range: "today" | "last-7-days" | "this-month") => {
      const activity = summary.ranges[range];
      return activity.kind === "available" ? activity.totals.total : null;
    };
    expect(totals("today")).toBe(100);
    expect(totals("last-7-days")).toBe(120);
    expect(totals("this-month")).toBe(123);
    const today = summary.ranges.today;
    if (today.kind !== "available") throw new Error("today must be available");
    expect(today.bounds).toEqual({
      start: "2026-10-10T00:00:00.000Z",
      end: "2026-10-10T12:00:00.000Z",
    });
    expect(today.source).toBe("codex-session-logs");
    expect(today.observedAt).toBe("2026-10-10T11:58:00.000Z");
    expect(today.freshness).toBe("live");
    expect(today.partiality.partial).toBe(false);
    expect(today.coverage).toEqual({ horizonDate: null, uncoveredDays: 0, analysisOffDays: 0 });
    expect(summary.firstScanPending).toBe(false);
  });

  it("reads analysis-off for every range and keeps no counter in the summary", () => {
    seedTurn("turn-0001", "2026-10-10T09:00:00.000Z", 100);
    coverAll();

    const summary = summarise({ analysisOn: false });

    for (const range of Object.values(summary.ranges)) {
      expect(range).toEqual({ kind: "unavailable", reason: "analysis-off", version: null });
    }
    expect(JSON.stringify(summary)).not.toContain("100");
  });

  it("carries no cost, price, billing or path member in any state", () => {
    seedTurn("turn-0001", "2026-10-10T09:00:00.000Z", 100);
    coverAll();
    const text = JSON.stringify([summarise(), summarise({ analysisOn: false })]);
    expect(text).not.toMatch(/cost|price|bill|usd|path|title/i);
  });
});

describe("Task 2: the unavailable reasons, coverage and partiality", () => {
  it("names the newest failing version when the format changed", () => {
    const summary = summarise({ recognition: { kind: "unavailable", version: "0.151.0" } });
    for (const range of Object.values(summary.ranges)) {
      expect(range).toEqual({ kind: "unavailable", reason: "format-changed", version: "0.151.0" });
    }
  });

  it("keeps the version null when no failing key is a dotted version", () => {
    const summary = summarise({ recognition: { kind: "unavailable", version: null } });
    expect(summary.ranges.today).toEqual({
      kind: "unavailable",
      reason: "format-changed",
      version: null,
    });
  });

  it("reads first-scan-pending in every range and carries the flag", () => {
    const summary = summarise({ firstScanPending: true });
    expect(summary.firstScanPending).toBe(true);
    for (const range of Object.values(summary.ranges)) {
      expect(range).toEqual({ kind: "unavailable", reason: "first-scan-pending", version: null });
    }
  });

  it("orders the reasons: analysis-off, then format-changed, then first-scan-pending", () => {
    const off = summarise({
      analysisOn: false,
      firstScanPending: true,
      recognition: { kind: "unavailable", version: "0.151.0" },
    });
    expect(off.ranges.today).toMatchObject({ reason: "analysis-off" });
    const changed = summarise({
      firstScanPending: true,
      recognition: { kind: "unavailable", version: "0.151.0" },
    });
    expect(changed.ranges.today).toMatchObject({ reason: "format-changed" });
  });

  it("reads no-coverage, with no counter, when no day is covered and no row exists", () => {
    const summary = summarise();
    for (const range of Object.values(summary.ranges)) {
      expect(range).toEqual({ kind: "unavailable", reason: "no-coverage", version: null });
    }
  });

  it("is available and partial when rows exist for days no scan covered", () => {
    seedTurn("turn-0001", "2026-10-10T09:00:00.000Z", 100);
    const today = summarise().ranges.today;
    expect(today.kind).toBe("available");
    if (today.kind !== "available") return;
    expect(today.partiality.partial).toBe(true);
    expect(today.coverage.uncoveredDays).toBe(1);
  });

  it("is available with zero counters for a covered range holding no tokens", () => {
    coverAll();
    const today = summarise().ranges.today;
    expect(today.kind).toBe("available");
    if (today.kind !== "available") return;
    expect(today.totals.total).toBe(0);
    expect(today.partiality).toEqual({ partial: false });
  });

  it("counts days before the horizon and analysis-off days from the shared toggle log", () => {
    coverAll();
    appendToggleLog(temp.db, "2026-10-08T08:00:00.000Z", false);
    appendToggleLog(temp.db, "2026-10-08T20:00:00.000Z", true);
    const week = summarise({ horizonDay: "2026-10-06" }).ranges["last-7-days"];
    expect(week.kind).toBe("available");
    if (week.kind !== "available") return;
    expect(week.coverage).toEqual({
      horizonDate: "2026-10-06",
      uncoveredDays: 2,
      analysisOffDays: 1,
    });
    expect(week.partiality).toEqual({
      partial: true,
      missingSources: ["analysis-off", "log-retention"],
    });
  });

  it("states freshness from the last scan and treats a missing scan time as cached", () => {
    coverAll();
    expect(summarise({ lastScanAt: "2026-10-10T11:58:00.000Z" }).ranges.today).toMatchObject({
      freshness: "live",
    });
    expect(summarise({ lastScanAt: "2026-10-10T08:00:00.000Z" }).ranges.today).toMatchObject({
      freshness: "cached",
    });
    expect(summarise({ lastScanAt: null }).ranges.today).toMatchObject({ freshness: "cached" });
  });

  it("computes the ranges in the injected time zone", () => {
    // 2026-10-10T03:00Z is still Oct 9 in New York: its "today" starts at 04:00Z on Oct 9.
    const now = new Date("2026-10-10T03:00:00.000Z");
    markCodexDayCovered(temp.db, "2026-10-09", now.toISOString());
    markCodexDayCovered(temp.db, "2026-10-10", now.toISOString());
    seedTurn("turn-0001", "2026-10-09T05:00:00.000Z", 40);
    const today = summarise({ now, timeZone: "America/New_York" }).ranges.today;
    expect(today.kind).toBe("available");
    if (today.kind !== "available") return;
    expect(today.totals.total).toBe(40);
    expect(today.bounds.start).toBe("2026-10-09T04:00:00.000Z");
  });
});
