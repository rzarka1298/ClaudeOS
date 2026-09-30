import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMigrations,
  type OperationalStore,
  openStore,
  queryTokenActivity,
  recordUsage,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localDayOf, rangeBounds } from "./usage-summary.js";

// Audit (05 wave 4, 05-12 truth 6): "today" is computed in local time. In a
// half-hour-offset zone (Asia/Kolkata, UTC+05:30) local midnight falls at
// :30 UTC, mid-way through a UTC hour bucket.

const ZONE = "Asia/Kolkata";
// 2026-09-30 01:30 local; local midnight of 2026-09-30 is 2026-09-29T18:30Z.
const NOW = new Date("2026-09-29T20:00:00.000Z");
// 2026-09-30 00:10 local: today, but in the 18:00Z bucket that starts before midnight.
const JUST_AFTER_MIDNIGHT = "2026-09-29T18:40:00.000Z";

let dir: string;
let store: OperationalStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-audit-tz-"));
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function record(messageId: string, timestamp: string, input: number): void {
  recordUsage(
    store.db,
    [
      {
        messageId,
        claudeSessionId: "sess-tz",
        timestamp,
        model: "claude-opus-4-8",
        skillKey: null,
        projectKey: null,
        counters: { input, output: 0, cacheWrite: 0, cacheRead: 0 },
      },
    ],
    NOW.toISOString(),
  );
}

describe("half-hour UTC offset day bucketing (audit)", () => {
  it("the fixture message is local today", () => {
    expect(localDayOf(JUST_AFTER_MIDNIGHT, ZONE)).toBe("2026-09-30");
    expect(localDayOf(NOW.getTime(), ZONE)).toBe("2026-09-30");
  });

  // AUDIT-BUG (05-12, MINOR): usage is stored in whole UTC hour buckets and
  // "today" queries hour_bucket >= local midnight (18:30Z), so the 18:00Z
  // bucket is excluded and the first 30 minutes of every local day vanish
  // from every range in a half-hour-offset zone (India, Newfoundland, parts
  // of Australia). Unskip once buckets align to the zone or bounds round down.
  it.skip("a message ten minutes after local midnight counts toward today", () => {
    record("m-after-midnight", JUST_AFTER_MIDNIGHT, 100);
    const bounds = rangeBounds("today", NOW, ZONE);
    const rows = queryTokenActivity(store.db, { start: bounds.start, end: bounds.queryEnd });
    expect(rows.totals.input).toBe(100);
  });
});
