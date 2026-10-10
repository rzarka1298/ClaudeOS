import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexTokenCounters } from "@ccc/domain";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addCumulativeDelta,
  codexBucketStart,
  InvalidCodexRecordError,
  queryCodexTokenTotals,
  readCumulativeBaseline,
  upsertTurnTokens,
  writeCumulativeBaseline,
} from "./codex-store.js";
import { openMigratedFileDb } from "./test-support/migration-helper.js";
import { USAGE_BUCKET_MS } from "./usage-store.js";

const NOW = "2026-10-10T12:00:00.000Z";
const B0 = "2026-10-10T08:00:00.000Z";
const B1 = "2026-10-10T08:15:00.000Z";
const B2 = "2026-10-10T08:30:00.000Z";

function counters(n: number): CodexTokenCounters {
  return {
    input: n,
    cachedInput: n + 1,
    cacheWrite: n + 2,
    output: n + 3,
    reasoningOutput: n + 4,
    total: n + 5,
  };
}

let dir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-codex-store-"));
  dbPath = join(dir, "operational.db");
  db = openMigratedFileDb(dbPath);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function turnRows(): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM codex_token_turns ORDER BY thread_id, turn_id").all() as Array<
    Record<string, unknown>
  >;
}

describe("upsertTurnTokens (CODEX-10: latest cumulative wins, never summed)", () => {
  it("Test 1: three growing writes leave ONE row with the last counters and the first bucket", () => {
    upsertTurnTokens(db, {
      threadId: "t1",
      turnId: "u1",
      bucketStart: B0,
      counters: counters(10),
      observedAt: NOW,
    });
    upsertTurnTokens(db, {
      threadId: "t1",
      turnId: "u1",
      bucketStart: B1,
      counters: counters(20),
      observedAt: NOW,
    });
    upsertTurnTokens(db, {
      threadId: "t1",
      turnId: "u1",
      bucketStart: B2,
      counters: counters(30),
      observedAt: NOW,
    });
    const rows = turnRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      thread_id: "t1",
      turn_id: "u1",
      bucket_start: B0,
      input: 30,
      cached_input: 31,
      cache_write: 32,
      output: 33,
      reasoning_output: 34,
      total: 35,
    });
  });

  it("Test 1: a lower or mixed counter set arriving later never lowers any member", () => {
    upsertTurnTokens(db, {
      threadId: "t1",
      turnId: "u1",
      bucketStart: B0,
      counters: counters(50),
      observedAt: NOW,
    });
    upsertTurnTokens(db, {
      threadId: "t1",
      turnId: "u1",
      bucketStart: B0,
      counters: { ...counters(10), output: 999 },
      observedAt: NOW,
    });
    expect(turnRows()[0]).toMatchObject({
      input: 50,
      cached_input: 51,
      cache_write: 52,
      output: 999,
      reasoning_output: 54,
      total: 55,
    });
  });

  it("Test 2: two turns leave two rows and replaying identical facts changes nothing", () => {
    const facts = [
      { threadId: "t1", turnId: "u1", bucketStart: B0, counters: counters(10), observedAt: NOW },
      { threadId: "t1", turnId: "u2", bucketStart: B1, counters: counters(20), observedAt: NOW },
    ];
    for (const f of facts) upsertTurnTokens(db, f);
    const before = turnRows();
    expect(before).toHaveLength(2);
    for (const f of facts) upsertTurnTokens(db, f);
    for (const f of facts) upsertTurnTokens(db, f);
    expect(turnRows()).toEqual(before);
  });

  it("Test 5: counters are integers and a value above 2^31 round-trips exactly", () => {
    const big = 2 ** 31 + 12345;
    upsertTurnTokens(db, {
      threadId: "t1",
      turnId: "u1",
      bucketStart: B0,
      counters: { ...counters(1), input: big },
      observedAt: NOW,
    });
    expect(db.prepare("SELECT input, typeof(input) AS kind FROM codex_token_turns").get()).toEqual({
      input: big,
      kind: "integer",
    });
  });

  it("Test 5: a negative, fractional or unsafe counter throws before any write", () => {
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 53]) {
      expect(() =>
        upsertTurnTokens(db, {
          threadId: "t1",
          turnId: "u1",
          bucketStart: B0,
          counters: { ...counters(1), output: bad },
          observedAt: NOW,
        }),
      ).toThrow(InvalidCodexRecordError);
    }
    expect(turnRows()).toHaveLength(0);
  });

  it("refuses an empty identifier and a bucket that is not a canonical quarter hour", () => {
    const base = { threadId: "t1", turnId: "u1", counters: counters(1), observedAt: NOW };
    expect(() => upsertTurnTokens(db, { ...base, threadId: "", bucketStart: B0 })).toThrow(
      InvalidCodexRecordError,
    );
    expect(() => upsertTurnTokens(db, { ...base, turnId: "", bucketStart: B0 })).toThrow(
      InvalidCodexRecordError,
    );
    for (const bucket of ["not a date", "2026-10-10T08:07:00.000Z", "2026-10-10T08:00:00Z"]) {
      expect(() => upsertTurnTokens(db, { ...base, bucketStart: bucket })).toThrow(
        InvalidCodexRecordError,
      );
    }
    expect(turnRows()).toHaveLength(0);
  });
});

describe("codexBucketStart", () => {
  it("floors an instant to its UTC quarter hour using the shared bucket width", () => {
    expect(USAGE_BUCKET_MS).toBe(15 * 60 * 1000);
    expect(codexBucketStart("2026-10-10T08:29:59.999Z")).toBe(B1);
    expect(codexBucketStart("2026-10-10T08:14:59.999Z")).toBe(B0);
    expect(codexBucketStart("garbage")).toBeNull();
  });
});

describe("addCumulativeDelta and the cumulative baseline", () => {
  it("Test 3: a delta adds into an existing thread and bucket row and creates it otherwise", () => {
    addCumulativeDelta(db, { threadId: "t1", bucketStart: B0, delta: counters(1) });
    addCumulativeDelta(db, { threadId: "t1", bucketStart: B0, delta: counters(10) });
    addCumulativeDelta(db, { threadId: "t1", bucketStart: B1, delta: counters(100) });
    const rows = db
      .prepare("SELECT bucket_start, input, total FROM codex_token_deltas ORDER BY bucket_start")
      .all();
    expect(rows).toEqual([
      { bucket_start: B0, input: 11, total: 16 + 5 },
      { bucket_start: B1, input: 100, total: 105 },
    ]);
  });

  it("Test 3: baselines round-trip, are null for an unknown thread, and never lower", () => {
    expect(readCumulativeBaseline(db, "t1")).toBeNull();
    writeCumulativeBaseline(db, "t1", counters(100), NOW);
    expect(readCumulativeBaseline(db, "t1")).toEqual(counters(100));
    writeCumulativeBaseline(db, "t1", counters(40), NOW);
    expect(readCumulativeBaseline(db, "t1")).toEqual(counters(100));
    writeCumulativeBaseline(db, "t1", { ...counters(40), output: 500, total: 1 }, NOW);
    expect(readCumulativeBaseline(db, "t1")).toEqual({ ...counters(100), output: 500 });
    expect(readCumulativeBaseline(db, "other")).toBeNull();
  });

  it("Test 3: the high-water marks survive closing and reopening the database", () => {
    writeCumulativeBaseline(db, "t1", counters(70), NOW);
    db.close();
    db = openMigratedFileDb(dbPath);
    expect(readCumulativeBaseline(db, "t1")).toEqual(counters(70));
  });

  it("Test 3: a delta and a baseline written in one transaction roll back together and commit once on retry", () => {
    const attempt = (fail: boolean) =>
      db.transaction(() => {
        addCumulativeDelta(db, { threadId: "t1", bucketStart: B0, delta: counters(5) });
        writeCumulativeBaseline(db, "t1", counters(5), NOW);
        if (fail) throw new Error("injected");
      })();
    expect(() => attempt(true)).toThrow("injected");
    expect(db.prepare("SELECT COUNT(*) AS n FROM codex_token_deltas").get()).toEqual({ n: 0 });
    expect(readCumulativeBaseline(db, "t1")).toBeNull();
    attempt(false);
    expect(db.prepare("SELECT input FROM codex_token_deltas").get()).toEqual({ input: 5 });
    expect(readCumulativeBaseline(db, "t1")).toEqual(counters(5));
  });

  it("Test 5: invalid deltas and baselines throw before any write", () => {
    expect(() =>
      addCumulativeDelta(db, {
        threadId: "t1",
        bucketStart: B0,
        delta: { ...counters(1), input: -2 },
      }),
    ).toThrow(InvalidCodexRecordError);
    expect(() => writeCumulativeBaseline(db, "t1", { ...counters(1), total: 0.5 }, NOW)).toThrow(
      InvalidCodexRecordError,
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM codex_token_deltas").get()).toEqual({ n: 0 });
    expect(readCumulativeBaseline(db, "t1")).toBeNull();
  });
});

describe("queryCodexTokenTotals", () => {
  it("Test 4: sums turn rows and delta rows in the half-open UTC range and excludes the end boundary", () => {
    upsertTurnTokens(db, {
      threadId: "t1",
      turnId: "u1",
      bucketStart: B0,
      counters: counters(10),
      observedAt: NOW,
    });
    upsertTurnTokens(db, {
      threadId: "t1",
      turnId: "u2",
      bucketStart: B1,
      counters: counters(20),
      observedAt: NOW,
    });
    addCumulativeDelta(db, { threadId: "t2", bucketStart: B1, delta: counters(100) });
    // On the end boundary: excluded.
    upsertTurnTokens(db, {
      threadId: "t1",
      turnId: "u3",
      bucketStart: B2,
      counters: counters(1000),
      observedAt: NOW,
    });
    addCumulativeDelta(db, { threadId: "t2", bucketStart: B2, delta: counters(1000) });

    const result = queryCodexTokenTotals(db, { start: B0, end: B2 });
    expect(result).toEqual({
      counters: {
        input: 10 + 20 + 100,
        cachedInput: 11 + 21 + 101,
        cacheWrite: 12 + 22 + 102,
        output: 13 + 23 + 103,
        reasoningOutput: 14 + 24 + 104,
        total: 15 + 25 + 105,
      },
      rows: 3,
    });
    // The start is inclusive.
    expect(queryCodexTokenTotals(db, { start: B1, end: B2 })?.rows).toBe(2);
  });

  it("Test 4: identical turn and delta rows are not collapsed", () => {
    upsertTurnTokens(db, {
      threadId: "t1",
      turnId: "u1",
      bucketStart: B0,
      counters: counters(7),
      observedAt: NOW,
    });
    addCumulativeDelta(db, { threadId: "t1", bucketStart: B0, delta: counters(7) });
    expect(queryCodexTokenTotals(db, { start: B0, end: B1 })).toMatchObject({
      counters: { input: 14 },
      rows: 2,
    });
  });

  it("Test 4: an uncovered range returns null, not zeros", () => {
    expect(queryCodexTokenTotals(db, { start: B0, end: B2 })).toBeNull();
    upsertTurnTokens(db, {
      threadId: "t1",
      turnId: "u1",
      bucketStart: B2,
      counters: counters(0),
      observedAt: NOW,
    });
    expect(queryCodexTokenTotals(db, { start: B0, end: B2 })).toBeNull();
    // A real row of zero counters is a real row, not an absence.
    expect(queryCodexTokenTotals(db, { start: B2, end: "2026-10-10T09:00:00.000Z" })?.rows).toBe(1);
  });

  it("refuses a range whose bounds are not canonical instants", () => {
    expect(() => queryCodexTokenTotals(db, { start: "yesterday", end: B2 })).toThrow(
      InvalidCodexRecordError,
    );
  });
});
