import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  estimateCostUsd,
  PRICE_ROWS,
  PRICE_TABLE_EFFECTIVE_FROM,
  PRICING_TABLE_VERSION,
  type TokenCounters,
} from "./pricing.js";

const COUNTERS: TokenCounters = {
  input: 1_200,
  output: 3_400,
  cacheWrite: 50_000,
  cacheRead: 2_000_000,
};

describe("estimateCostUsd (Test 4, USAGE-03, D-42)", () => {
  it("prices a listed model at the hand-computed per-million-token sum", () => {
    // Claude Opus 4.8 list prices: $5 input, $25 output, $6.25 5-minute cache write, $0.50 cache read.
    const expected = (1_200 * 5 + 3_400 * 25 + 50_000 * 6.25 + 2_000_000 * 0.5) / 1_000_000;
    const result = estimateCostUsd("claude-opus-4-8", COUNTERS);
    expect(result.kind).toBe("priced");
    if (result.kind !== "priced") return;
    expect(Number.isFinite(result.usd)).toBe(true);
    expect(result.usd).toBeCloseTo(expected, 10);
  });

  it("prices a dated model id through its family row", () => {
    // Claude Haiku 4.5: $1 input, $5 output, $1.25 cache write, $0.10 cache read.
    const expected = (1_200 * 1 + 3_400 * 5 + 50_000 * 1.25 + 2_000_000 * 0.1) / 1_000_000;
    const result = estimateCostUsd("claude-haiku-4-5-20251001", COUNTERS);
    expect(result).toEqual({ kind: "priced", usd: expect.closeTo(expected, 10) });
  });

  it("prices Opus 5.5 cache reads at its own 0.05x rate, not the 0.1x default", () => {
    const result = estimateCostUsd("claude-opus-5-5", {
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 1_000_000,
    });
    expect(result).toEqual({ kind: "priced", usd: expect.closeTo(0.2, 10) });
  });

  it.each([
    "claude-unlisted-9",
    "gpt-synthetic",
    "claude-opus-4-9",
    "claude-sonnet-4-7",
    // Not on the cited pricing page (wave 2 review): unpriced, never guessed.
    "claude-sonnet-5-5",
    "",
  ])(
    "reports %j as unpriced, never as zero dollars",
    (model) => {
      expect(estimateCostUsd(model, COUNTERS)).toEqual({ kind: "unpriced" });
    },
  );

  it("prices the <synthetic> model at zero as a priced result", () => {
    expect(estimateCostUsd("<synthetic>", COUNTERS)).toEqual({ kind: "priced", usd: 0 });
  });
});

describe("price table provenance (Test 5, PR-11)", () => {
  it("carries a non-empty version and an ISO effective date", () => {
    expect(PRICING_TABLE_VERSION.length).toBeGreaterThan(0);
    expect(PRICE_TABLE_EFFECTIVE_FROM).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(PRICE_TABLE_EFFECTIVE_FROM))).toBe(false);
  });

  it("has one row per model id and a finite, non-negative price in every column", () => {
    const ids = PRICE_ROWS.map((row) => row.model);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of PRICE_ROWS) {
      for (const price of [row.input, row.output, row.cacheWrite, row.cacheRead]) {
        expect(Number.isFinite(price) && price >= 0).toBe(true);
      }
    }
  });

  it("is data only: cites its source URL and makes no network call", () => {
    const source = readFileSync(new URL("./pricing.ts", import.meta.url), "utf8");
    expect(source).toContain("https://platform.claude.com/docs/en/about-claude/pricing");
    expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|from\s+["']node:(https?|net|dns)["']/);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });
});
