import { describe, expect, it } from "vitest";
import { buildDiagnosticBundle } from "./diagnostic-bundle.js";
import { cleanBundleInput, richHealth } from "./diagnostic-corpus.js";
import { HEALTH_STALE_AFTER_MS } from "./diagnostics.js";

/**
 * Phase-end fix round FIX6A (opus minor 1, domain part): the bundle used to copy each row's
 * freshness as it was, so an answer hours old was exported as `live`. The bundle now ages every
 * row against its own `generatedAt` with the shared five-minute window, the same rule the plugin
 * applies to what it shows.
 */

const GENERATED = "2026-10-22T11:00:00.000Z";

function bundleAt(generatedAt: string, checkedAt: string | null, freshness = "live") {
  const health = JSON.parse(JSON.stringify(richHealth())) as ReturnType<typeof richHealth>;
  const rows = health.rows as unknown as Array<{ checkedAt: string | null; freshness: string }>;
  for (const row of rows) {
    row.checkedAt = checkedAt;
    row.freshness = freshness;
  }
  health.generatedAt = checkedAt ?? health.generatedAt;
  return buildDiagnosticBundle({ ...cleanBundleInput(), generatedAt, health });
}

describe("FIX6A opus minor 1: the bundle ages each row's freshness", () => {
  it("a two-hour-old live answer is exported as stale, with its real check time", () => {
    const checked = "2026-10-22T09:00:00.000Z";
    const bundle = bundleAt(GENERATED, checked);
    for (const row of bundle.subsystems) expect(row.freshness, row.id).toBe("stale");
    expect(bundle.subsystems[1]?.checkedAt).toBe(checked);
  });

  it("an answer exactly at the window stays live, one millisecond past it is stale", () => {
    const generatedMs = Date.parse(GENERATED);
    const atWindow = new Date(generatedMs - HEALTH_STALE_AFTER_MS).toISOString();
    const past = new Date(generatedMs - HEALTH_STALE_AFTER_MS - 1).toISOString();
    for (const row of bundleAt(GENERATED, atWindow).subsystems) {
      expect(row.freshness, row.id).toBe("live");
    }
    for (const row of bundleAt(GENERATED, past).subsystems) {
      expect(row.freshness, row.id).toBe("stale");
    }
  });

  it("a cached answer ages the same way", () => {
    const bundle = bundleAt(GENERATED, "2026-10-22T09:00:00.000Z", "cached");
    expect(bundle.subsystems[1]?.freshness).toBe("stale");
    const young = bundleAt(GENERATED, "2026-10-22T10:58:00.000Z", "cached");
    expect(young.subsystems[1]?.freshness).toBe("cached");
  });

  it("an unavailable row stays unavailable (no answer to age)", () => {
    const bundle = bundleAt(GENERATED, "2026-10-22T09:00:00.000Z", "unavailable");
    expect(bundle.subsystems[1]?.freshness).toBe("unavailable");
  });

  it("a row with no check time is never made stale", () => {
    const bundle = bundleAt(GENERATED, null, "unavailable");
    expect(bundle.subsystems[1]).toMatchObject({ checkedAt: null, freshness: "unavailable" });
  });
});
