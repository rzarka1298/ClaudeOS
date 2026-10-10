import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexTokenCounters, CodexUsageSnapshot, RunId } from "@ccc/domain";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addCodexRecognition,
  addCumulativeDelta,
  CODEX_ANALYTICS_TABLES,
  codexBucketStart,
  deleteAllUsageAnalytics,
  deleteCodexAnalytics,
  InvalidCodexRecordError,
  loadRateLimitSnapshot,
  markCodexDayCovered,
  queryCodexCoverage,
  queryCodexTokenTotals,
  readCodexCursor,
  readCodexRecognition,
  readCumulativeBaseline,
  resetCodexScanState,
  saveRateLimitSnapshot,
  upsertTurnTokens,
  writeCodexCursor,
  writeCumulativeBaseline,
} from "./codex-store.js";
import * as barrel from "./index.js";
import { insertRun } from "./run-store.js";
import { setSessionOverride } from "./session-store.js";
import { openMigratedFileDb } from "./test-support/migration-helper.js";
import {
  appendToggleLog,
  recordUsage,
  setCollectorSetting,
  USAGE_BUCKET_MS,
  writeCursor,
} from "./usage-store.js";

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

const KEY_A = "a".repeat(64);
const KEY_B = `${"0123456789abcdef".repeat(4)}`;

describe("rollout cursors (D-15: hashed keys, never paths)", () => {
  it("Test 1: round-trips inode, size and offset by hashed key and returns null for an unknown key", () => {
    expect(readCodexCursor(db, KEY_A)).toBeNull();
    writeCodexCursor(db, KEY_A, { inode: "123456789012345678", size: 4096, offset: 2048 }, NOW);
    expect(readCodexCursor(db, KEY_A)).toEqual({
      inode: "123456789012345678",
      size: 4096,
      offset: 2048,
    });
    writeCodexCursor(db, KEY_A, { inode: "123456789012345678", size: 8192, offset: 8192 }, NOW);
    expect(readCodexCursor(db, KEY_A)).toEqual({
      inode: "123456789012345678",
      size: 8192,
      offset: 8192,
    });
    expect(readCodexCursor(db, KEY_B)).toBeNull();
  });

  it("Test 1: a key that is not 64 hex characters is refused, so a path can never be a key", () => {
    const cursor = { inode: "1", size: 1, offset: 1 };
    for (const bad of [
      "/Users/USERNAME/repo/rollout.jsonl",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "g".repeat(64),
      "",
    ]) {
      expect(() => writeCodexCursor(db, bad, cursor, NOW), bad).toThrow(InvalidCodexRecordError);
      expect(() => readCodexCursor(db, bad), bad).toThrow(InvalidCodexRecordError);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM codex_rollout_cursors").get()).toEqual({ n: 0 });
  });

  it("refuses a negative or fractional size or offset", () => {
    expect(() => writeCodexCursor(db, KEY_A, { inode: "1", size: -1, offset: 0 }, NOW)).toThrow(
      InvalidCodexRecordError,
    );
    expect(() => writeCodexCursor(db, KEY_A, { inode: "1", size: 1, offset: 0.5 }, NOW)).toThrow(
      InvalidCodexRecordError,
    );
  });

  it("Test 3 (atomic chunk): a delta, a high-water mark and a cursor commit together or not at all", () => {
    const chunk = (fail: boolean) =>
      db.transaction(() => {
        addCumulativeDelta(db, { threadId: "t1", bucketStart: B0, delta: counters(5) });
        writeCumulativeBaseline(db, "t1", counters(5), NOW);
        writeCodexCursor(db, KEY_A, { inode: "1", size: 100, offset: 100 }, NOW);
        if (fail) throw new Error("injected");
      })();
    expect(() => chunk(true)).toThrow("injected");
    expect(db.prepare("SELECT COUNT(*) AS n FROM codex_token_deltas").get()).toEqual({ n: 0 });
    expect(readCumulativeBaseline(db, "t1")).toBeNull();
    expect(readCodexCursor(db, KEY_A)).toBeNull();
    chunk(false);
    expect(db.prepare("SELECT input FROM codex_token_deltas").get()).toEqual({ input: 5 });
    expect(readCumulativeBaseline(db, "t1")).toEqual(counters(5));
    expect(readCodexCursor(db, KEY_A)).toEqual({ inode: "1", size: 100, offset: 100 });
  });
});

describe("coverage", () => {
  it("Test 2: records and reports covered days; a day never marked reads not-scanned", () => {
    markCodexDayCovered(db, "2026-10-08", NOW);
    markCodexDayCovered(db, "2026-10-09", NOW);
    markCodexDayCovered(db, "2026-10-09", "2026-10-10T20:00:00.000Z");
    expect(
      db.prepare("SELECT recorded_at FROM codex_coverage_days WHERE day = '2026-10-09'").get(),
    ).toEqual({
      recorded_at: NOW,
    });
    expect(queryCodexCoverage(db, "2026-10-07", "2026-10-10")).toEqual([
      { day: "2026-10-07", status: "not-scanned" },
      { day: "2026-10-08", status: "covered" },
      { day: "2026-10-09", status: "covered" },
      { day: "2026-10-10", status: "not-scanned" },
    ]);
  });

  it("classifies days before the horizon and days analysis was switched off, like the Claude ledger", () => {
    markCodexDayCovered(db, "2026-10-08", NOW);
    const toggleLog = [{ at: "2026-10-09T10:00:00.000Z", enabled: false }];
    expect(queryCodexCoverage(db, "2026-10-06", "2026-10-10", "2026-10-07", toggleLog)).toEqual([
      { day: "2026-10-06", status: "before-horizon" },
      { day: "2026-10-07", status: "not-scanned" },
      { day: "2026-10-08", status: "covered" },
      { day: "2026-10-09", status: "analysis-off" },
      { day: "2026-10-10", status: "analysis-off" },
    ]);
  });

  it("refuses a malformed day", () => {
    expect(() => markCodexDayCovered(db, "10/10/2026", NOW)).toThrow(InvalidCodexRecordError);
    expect(() => queryCodexCoverage(db, "nope", "2026-10-10")).toThrow(RangeError);
  });
});

function availableSnapshot(usedPercent: number): CodexUsageSnapshot {
  return {
    kind: "available",
    windows: [
      {
        windowMinutes: 10080,
        usedPercent,
        resetsAt: "2026-10-14T00:00:00.000Z",
        limitLabel: null,
      },
    ],
    ordinaryUsageAllowed: true,
    rateLimitReached: false,
    rateLimitReachedType: null,
    source: "app-server",
    observedAt: NOW,
    freshness: "live",
  };
}

describe("the rate-limit snapshot", () => {
  it("Test 3: stores the snapshot in the single row, replaces it on the next save, and loads it back", () => {
    expect(loadRateLimitSnapshot(db)).toBeNull();
    saveRateLimitSnapshot(db, availableSnapshot(7), NOW);
    expect(loadRateLimitSnapshot(db)).toEqual(availableSnapshot(7));
    saveRateLimitSnapshot(db, availableSnapshot(42), "2026-10-10T13:00:00.000Z");
    expect(loadRateLimitSnapshot(db)).toEqual(availableSnapshot(42));
    expect(db.prepare("SELECT id, observed_at FROM codex_rate_limit_snapshot").all()).toEqual([
      { id: 1, observed_at: "2026-10-10T13:00:00.000Z" },
    ]);
  });

  it("Test 3: an unavailable snapshot round-trips", () => {
    const unavailable: CodexUsageSnapshot = {
      kind: "unavailable",
      reason: "read-failed",
      version: "0.159.2",
      observedAt: NOW,
    };
    saveRateLimitSnapshot(db, unavailable, NOW);
    expect(loadRateLimitSnapshot(db)).toEqual(unavailable);
  });

  it("Test 3: refuses to write a snapshot that fails the domain schema or carries an unknown member", () => {
    const bad = { ...availableSnapshot(7), accountId: "acct-1" } as unknown as CodexUsageSnapshot;
    expect(() => saveRateLimitSnapshot(db, bad, NOW)).toThrow(InvalidCodexRecordError);
    const outOfRange = availableSnapshot(101);
    expect(() => saveRateLimitSnapshot(db, outOfRange, NOW)).toThrow(InvalidCodexRecordError);
    const numericUnavailable = {
      kind: "unavailable",
      reason: "read-failed",
      version: null,
      observedAt: NOW,
      usedPercent: 0,
    } as unknown as CodexUsageSnapshot;
    expect(() => saveRateLimitSnapshot(db, numericUnavailable, NOW)).toThrow(
      InvalidCodexRecordError,
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM codex_rate_limit_snapshot").get()).toEqual({
      n: 0,
    });
  });

  it("Test 3: a stored row that fails the schema, or is not JSON, loads as null", () => {
    const put = (json: string) =>
      db
        .prepare(
          `INSERT INTO codex_rate_limit_snapshot (id, snapshot_json, observed_at) VALUES (1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET snapshot_json = excluded.snapshot_json`,
        )
        .run(json, NOW);
    put(
      JSON.stringify({
        kind: "unavailable",
        reason: "read-failed",
        version: null,
        observedAt: NOW,
        usedPercent: 0,
      }),
    );
    expect(loadRateLimitSnapshot(db)).toBeNull();
    put(JSON.stringify({ ...availableSnapshot(7), accountId: "acct-1" }));
    expect(loadRateLimitSnapshot(db)).toBeNull();
    put("not json {");
    expect(loadRateLimitSnapshot(db)).toBeNull();
    put(JSON.stringify(availableSnapshot(7)));
    expect(loadRateLimitSnapshot(db)).toEqual(availableSnapshot(7));
  });
});

describe("recognition tallies", () => {
  it("Test 4: accumulates per parser version and CLI version and reads back the tallies", () => {
    addCodexRecognition(db, 1, { "0.159.2": { sessions: 3, recognized: 2 } }, NOW);
    addCodexRecognition(
      db,
      1,
      { "0.159.2": { sessions: 1, recognized: 1 }, "0.160.0": { sessions: 2, recognized: 0 } },
      NOW,
    );
    addCodexRecognition(db, 2, { "0.159.2": { sessions: 9, recognized: 9 } }, NOW);
    addCodexRecognition(db, 1, { "0.1.0": { sessions: 0, recognized: 0 } }, NOW);
    expect(readCodexRecognition(db, 1)).toEqual({
      "0.159.2": { sessions: 4, recognized: 3 },
      "0.160.0": { sessions: 2, recognized: 0 },
    });
    expect(readCodexRecognition(db, 2)).toEqual({ "0.159.2": { sessions: 9, recognized: 9 } });
    expect(readCodexRecognition(db, 3)).toEqual({});
  });
});

describe("resetCodexScanState", () => {
  it("Test 4: clears cursors, coverage and recognition and leaves token counters and high-water marks exact", () => {
    upsertTurnTokens(db, {
      threadId: "t1",
      turnId: "u1",
      bucketStart: B0,
      counters: counters(10),
      observedAt: NOW,
    });
    addCumulativeDelta(db, { threadId: "t2", bucketStart: B1, delta: counters(20) });
    writeCumulativeBaseline(db, "t1", counters(10), NOW);
    writeCumulativeBaseline(db, "t2", counters(20), NOW);
    writeCodexCursor(db, KEY_A, { inode: "1", size: 1, offset: 1 }, NOW);
    markCodexDayCovered(db, "2026-10-10", NOW);
    addCodexRecognition(db, 1, { "0.159.2": { sessions: 1, recognized: 1 } }, NOW);

    resetCodexScanState(db);

    expect(readCodexCursor(db, KEY_A)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM codex_coverage_days").get()).toEqual({ n: 0 });
    expect(readCodexRecognition(db, 1)).toEqual({});
    expect(readCumulativeBaseline(db, "t1")).toEqual(counters(10));
    expect(readCumulativeBaseline(db, "t2")).toEqual(counters(20));
    expect(queryCodexTokenTotals(db, { start: B0, end: B2 })).toEqual({
      counters: {
        input: 30,
        cachedInput: 32,
        cacheWrite: 34,
        output: 36,
        reasoningOutput: 38,
        total: 40,
      },
      rows: 2,
    });
  });
});

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function fillEverything(): void {
  upsertTurnTokens(db, {
    threadId: "t1",
    turnId: "u1",
    bucketStart: B0,
    counters: counters(10),
    observedAt: NOW,
  });
  addCumulativeDelta(db, { threadId: "t2", bucketStart: B1, delta: counters(20) });
  writeCumulativeBaseline(db, "t1", counters(10), NOW);
  writeCodexCursor(db, KEY_A, { inode: "1", size: 1, offset: 1 }, NOW);
  markCodexDayCovered(db, "2026-10-10", NOW);
  addCodexRecognition(db, 1, { "0.159.2": { sessions: 1, recognized: 1 } }, NOW);
  saveRateLimitSnapshot(db, availableSnapshot(7), NOW);
  // Claude usage and the things deleting analytics must never touch.
  db.prepare(
    "INSERT INTO projects (project_id, path, workspace_id, display_name, registered_at) VALUES ('project-a', '/Users/USERNAME/code/a', NULL, 'A', ?)",
  ).run(NOW);
  insertRun(db, {
    runId: "mgz1a2b3c0000000000000001" as RunId,
    kind: "automation",
    projectId: null,
    claudeSessionId: null,
    state: "completed",
    startedAt: NOW,
    lastActivityAt: null,
    endedAt: NOW,
  });
  setSessionOverride(db, "session-1", "project-a", NOW);
  setCollectorSetting(db, "transcript_analysis_enabled", "true", NOW);
  appendToggleLog(db, NOW, true);
  recordUsage(
    db,
    [
      {
        messageId: "m1",
        claudeSessionId: "s1",
        timestamp: "2026-10-10T08:01:00.000Z",
        model: "model-x",
        skillKey: null,
        projectKey: null,
        counters: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 },
      },
    ],
    NOW,
  );
  writeCursor(db, "/Users/USERNAME/repo/transcript.jsonl", { inode: "9", size: 9, offset: 9 }, NOW);
}

const PRESERVED_TABLES = ["runs", "session_overrides", "collector_settings", "analysis_toggle_log"];

describe("deleting cached analytics (D-17, Pitfall 13)", () => {
  it("Test 5: CODEX_ANALYTICS_TABLES lists the six analytics tables plus the rate-limit snapshot", () => {
    expect([...CODEX_ANALYTICS_TABLES].sort()).toEqual(
      [
        "codex_coverage_days",
        "codex_rate_limit_snapshot",
        "codex_recognition",
        "codex_rollout_cursors",
        "codex_token_cumulative",
        "codex_token_deltas",
        "codex_token_turns",
      ].sort(),
    );
  });

  it("Test 5: deleteCodexAnalytics empties exactly the Codex tables", () => {
    fillEverything();
    for (const t of CODEX_ANALYTICS_TABLES) expect(count(t), t).toBeGreaterThan(0);
    deleteCodexAnalytics(db);
    for (const t of CODEX_ANALYTICS_TABLES) expect(count(t), t).toBe(0);
    for (const t of ["usage_quarter_hourly", "usage_seen_messages", "transcript_cursors"]) {
      expect(count(t), t).toBeGreaterThan(0);
    }
  });

  it("Test 5: deleteAllUsageAnalytics empties the Claude usage and Codex tables and keeps runs and settings", () => {
    fillEverything();
    const kept = Object.fromEntries(PRESERVED_TABLES.map((t) => [t, count(t)]));
    for (const t of PRESERVED_TABLES) expect(kept[t], t).toBeGreaterThan(0);
    deleteAllUsageAnalytics(db);
    for (const t of CODEX_ANALYTICS_TABLES) expect(count(t), t).toBe(0);
    for (const t of ["usage_quarter_hourly", "usage_seen_messages", "transcript_cursors"]) {
      expect(count(t), t).toBe(0);
    }
    for (const t of PRESERVED_TABLES) expect(count(t), t).toBe(kept[t]);
  });

  it("Test 5: a failing second delete rolls the first back (one transaction)", () => {
    fillEverything();
    const claudeRows = count("usage_quarter_hourly");
    expect(claudeRows).toBeGreaterThan(0);
    db.exec("DROP TABLE codex_rate_limit_snapshot");
    expect(() => deleteAllUsageAnalytics(db)).toThrow();
    expect(count("usage_quarter_hourly")).toBe(claudeRows);
    expect(count("transcript_cursors")).toBe(1);
    expect(count("codex_token_turns")).toBe(1);
  });
});

describe("the barrel", () => {
  it("Test 6: exports the Codex store API and keeps the Phase 5 exports", () => {
    for (const name of [
      "addCodexRecognition",
      "addCumulativeDelta",
      "codexBucketStart",
      "deleteAllUsageAnalytics",
      "deleteCodexAnalytics",
      "loadRateLimitSnapshot",
      "markCodexDayCovered",
      "queryCodexCoverage",
      "queryCodexTokenTotals",
      "readCodexCursor",
      "readCodexRecognition",
      "readCumulativeBaseline",
      "resetCodexScanState",
      "saveRateLimitSnapshot",
      "upsertTurnTokens",
      "writeCodexCursor",
      "writeCumulativeBaseline",
    ]) {
      expect(typeof (barrel as Record<string, unknown>)[name], name).toBe("function");
    }
    expect(barrel.CODEX_ANALYTICS_TABLES).toBe(CODEX_ANALYTICS_TABLES);
    expect(typeof barrel.InvalidCodexRecordError).toBe("function");
    for (const name of [
      "deleteUsageAnalytics",
      "recordUsage",
      "queryTokenActivity",
      "resetTranscriptScanState",
      "openStore",
      "applyMigrations",
    ]) {
      expect(typeof (barrel as Record<string, unknown>)[name], name).toBe("function");
    }
  });
});
