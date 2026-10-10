import { CodexTokenSummarySchema } from "@ccc/domain";
import { markCodexDayCovered, upsertTurnTokens } from "@ccc/operational-store";
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
