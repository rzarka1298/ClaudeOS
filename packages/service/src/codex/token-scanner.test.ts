import { statSync } from "node:fs";
import { CodexTokenSummarySchema } from "@ccc/domain";
import {
  queryCodexCoverage,
  queryCodexTokenTotals,
  readCodexCursor,
  resetCodexScanState,
} from "@ccc/operational-store";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  at,
  createTokenHarness,
  dumpCodexTables,
  jsonl,
  metaLine,
  perTurnRollout,
  raw,
  rolloutName,
  THREAD_A,
  type TokenHarness,
  tokenCountLine,
  turn,
  turnRecordLine,
} from "../test-support/codex-token-fixtures.js";

const DAY = "2026-10-10";
const NAME = rolloutName(at(0), THREAD_A);
const WIDE = { start: "2020-01-01T00:00:00.000Z", end: "2030-01-01T00:00:00.000Z" };

let harness: TokenHarness | null = null;

afterEach(() => {
  harness?.cleanup();
  harness = null;
});

function setup(options: Parameters<typeof createTokenHarness>[0] = {}): TokenHarness {
  harness = createTokenHarness(options);
  return harness;
}

function turnRows(db: Database.Database) {
  return db
    .prepare(
      "SELECT thread_id AS threadId, turn_id AS turnId, bucket_start AS bucketStart, input, output, total FROM codex_token_turns ORDER BY turn_id",
    )
    .all() as Array<{
    threadId: string;
    turnId: string;
    bucketStart: string;
    input: number;
    output: number;
    total: number;
  }>;
}

function cursorRows(db: Database.Database) {
  return db
    .prepare("SELECT cursor_key AS key, size, offset FROM codex_rollout_cursors")
    .all() as Array<{
    key: string;
    size: number;
    offset: number;
  }>;
}

describe("Task 1 (tracer): one rollout with per-turn records is scanned once, counted once, summarised", () => {
  it("counts the latest cumulative value per turn, advances the cursor, marks the day covered and summarises today", async () => {
    const h = setup();
    const path = h.rollouts.write(DAY, NAME, perTurnRollout());

    const outcome = await h.scanner.sweep();

    expect(outcome.completed).toBe(true);
    const rows = turnRows(h.temp.db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      threadId: THREAD_A,
      turnId: turn(1),
      input: 400,
      output: 90,
      total: 490,
    });
    expect(rows[1]).toMatchObject({ turnId: turn(2), input: 50, output: 10, total: 60 });
    // The bucket is the UTC quarter hour of each turn's first record.
    expect(rows[0]?.bucketStart).toBe("2026-10-10T10:00:00.000Z");
    expect(rows[1]?.bucketStart).toBe("2026-10-10T10:15:00.000Z");

    const cursors = cursorRows(h.temp.db);
    expect(cursors).toHaveLength(1);
    expect(cursors[0]?.offset).toBe(statSync(path).size);
    const covered = queryCodexCoverage(h.temp.db, DAY, DAY).map((d) => d.status);
    expect(covered).toEqual(["covered"]);

    const summary = h.scanner.summary();
    expect(CodexTokenSummarySchema.safeParse(summary).success).toBe(true);
    const today = summary.ranges.today;
    expect(today.kind).toBe("available");
    if (today.kind !== "available") return;
    expect(today.totals).toEqual({
      input: 450,
      cachedInput: 0,
      cacheWrite: 0,
      output: 100,
      reasoningOutput: 0,
      total: 550,
    });
    expect(today.source).toBe("codex-session-logs");
    expect(today.range).toBe("today");
    expect(JSON.stringify(summary)).not.toMatch(/cost|price|bill|usd/i);
  });

  it("a second sweep over the unchanged file reads nothing; an appended record counts only the new data", async () => {
    const h = setup();
    h.rollouts.write(DAY, NAME, perTurnRollout());
    await h.scanner.sweep();
    const before = queryCodexTokenTotals(h.temp.db, WIDE);

    h.spy.reset();
    await h.scanner.sweep();
    expect(h.spy.calls.readRolloutRange).toBe(0);
    expect(queryCodexTokenTotals(h.temp.db, WIDE)).toEqual(before);

    h.rollouts.append(
      DAY,
      NAME,
      jsonl([
        turnRecordLine({ turnId: turn(2), timestamp: at(1300), usage: raw(80, 20) }),
        turnRecordLine({ turnId: turn(3), timestamp: at(2400), usage: raw(30, 5) }),
      ]),
    );
    h.spy.reset();
    await h.scanner.sweep();
    expect(h.spy.bytesRead()).toBeGreaterThan(0);
    const rows = turnRows(h.temp.db);
    expect(rows.map((r) => [r.turnId, r.total])).toEqual([
      [turn(1), 490],
      [turn(2), 100],
      [turn(3), 35],
    ]);
  });

  it("replaying the whole file after a cursor reset leaves the totals unchanged", async () => {
    const h = setup();
    h.rollouts.write(DAY, NAME, perTurnRollout());
    await h.scanner.sweep();
    const before = queryCodexTokenTotals(h.temp.db, WIDE);

    resetCodexScanState(h.temp.db);
    h.spy.reset();
    await h.scanner.sweep();

    expect(h.spy.bytesRead()).toBeGreaterThan(0);
    expect(queryCodexTokenTotals(h.temp.db, WIDE)).toEqual(before);
    expect(turnRows(h.temp.db)).toHaveLength(2);
  });

  it("with analysis off a sweep lists no file, opens no file, counts nothing and every range reads analysis-off", async () => {
    const h = setup({ on: false });
    h.rollouts.write(DAY, NAME, perTurnRollout());

    const outcome = await h.scanner.sweep();
    await h.scanner.scanFile({ path: h.rollouts.home.rolloutPath(DAY, NAME) });

    expect(outcome.completed).toBe(false);
    expect(h.spy.calls).toEqual({ listRolloutFiles: 0, statRollout: 0, readRolloutRange: 0 });
    expect(turnRows(h.temp.db)).toHaveLength(0);
    expect(cursorRows(h.temp.db)).toHaveLength(0);
    const { ranges } = h.scanner.summary();
    for (const range of [ranges.today, ranges["last-7-days"], ranges["this-month"]]) {
      expect(range).toEqual({ kind: "unavailable", reason: "analysis-off", version: null });
    }
  });

  it("keys the cursor by a 64 hex character hash and stores no path anywhere", async () => {
    const h = setup();
    const path = h.rollouts.write(DAY, NAME, perTurnRollout());
    await h.scanner.sweep();

    const cursors = cursorRows(h.temp.db);
    expect(cursors[0]?.key).toMatch(/^[0-9a-f]{64}$/);
    expect(readCodexCursor(h.temp.db, cursors[0]?.key ?? "")).not.toBeNull();
    const dump = dumpCodexTables(h.temp.db);
    expect(dump).not.toContain(h.rollouts.home.root);
    expect(dump).not.toContain(path);
    expect(dump).not.toContain("rollout-");
    expect(dump).not.toContain("/Users/");
  });

  it("counts a rollout read in small chunks exactly like a whole one", async () => {
    const h = setup({ over: { chunkBytes: 700 } });
    h.rollouts.write(DAY, NAME, perTurnRollout());
    await h.scanner.sweep();
    const split = queryCodexTokenTotals(h.temp.db, WIDE);
    expect(split?.counters.total).toBe(550);
    expect(turnRows(h.temp.db)).toHaveLength(2);
  });

  it("keeps the thread id of the record when it differs from the file name", async () => {
    const h = setup();
    h.rollouts.write(
      DAY,
      NAME,
      jsonl([
        metaLine(),
        turnRecordLine({
          turnId: turn(7),
          timestamp: at(10),
          usage: raw(5, 5),
          threadId: "thread-cccc3333",
        }),
        tokenCountLine({ timestamp: at(10), total: raw(5, 5) }),
      ]),
    );
    await h.scanner.sweep();
    expect(turnRows(h.temp.db).map((r) => r.threadId)).toEqual(["thread-cccc3333"]);
  });
});
