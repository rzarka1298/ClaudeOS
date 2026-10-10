import { statSync } from "node:fs";
import { CodexTokenSummarySchema, CodexTokensUpdatedPayloadSchema } from "@ccc/domain";
import {
  appendToggleLog,
  queryCodexCoverage,
  queryCodexTokenTotals,
  readCodexCursor,
  readCodexRecognition,
  resetCodexScanState,
  writeCodexCursor,
} from "@ccc/operational-store";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALL_DECOYS,
  at,
  CUMULATIVE_DAY,
  CUMULATIVE_NAME,
  CUMULATIVE_STEPS,
  CUMULATIVE_TODAY_TOTALS,
  CUMULATIVE_TOTALS,
  contentLines,
  createTokenHarness,
  cumulativeLines,
  dumpCodexTables,
  jsonl,
  metaLine,
  perTurnRollout,
  perTurnWithCumulativeRollout,
  raw,
  rolloutName,
  THREAD_A,
  THREAD_B,
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

// ---------------------------------------------------------------------------------
// Task 2: the cumulative fallback, restart safety, recognition, coverage, scheduling

const CUMULATIVE_ROWS = [
  {
    bucket: "2026-10-09T23:45:00.000Z",
    input: 150,
    cachedInput: 12,
    cacheWrite: 5,
    output: 50,
    reasoningOutput: 4,
    total: 200,
  },
  {
    bucket: "2026-10-10T00:00:00.000Z",
    input: 0,
    cachedInput: 8,
    cacheWrite: 0,
    output: 0,
    reasoningOutput: 2,
    total: 0,
  },
  {
    bucket: "2026-10-10T00:15:00.000Z",
    input: 30,
    cachedInput: 0,
    cacheWrite: 0,
    output: 10,
    reasoningOutput: 0,
    total: 40,
  },
];

function deltaRows(db: Database.Database) {
  return db
    .prepare(
      `SELECT bucket_start AS bucket, input, cached_input AS cachedInput, cache_write AS cacheWrite,
              output, reasoning_output AS reasoningOutput, total
         FROM codex_token_deltas ORDER BY bucket_start`,
    )
    .all();
}

function markRows(db: Database.Database) {
  return db
    .prepare(
      `SELECT thread_id AS threadId, input, cached_input AS cachedInput, cache_write AS cacheWrite,
              output, reasoning_output AS reasoningOutput, total
         FROM codex_token_cumulative ORDER BY thread_id`,
    )
    .all();
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Totals per range, the per-bucket rows and the high-water marks: what every route must agree on. */
function signature(h: TokenHarness) {
  const { ranges } = h.scanner.summary();
  const totals = (activity: (typeof ranges)["today"]) =>
    activity.kind === "available" ? activity.totals : activity;
  return {
    deltas: deltaRows(h.temp.db),
    marks: markRows(h.temp.db),
    today: totals(ranges.today),
    week: totals(ranges["last-7-days"]),
    month: totals(ranges["this-month"]),
  };
}

const EXPECTED_SIGNATURE = {
  deltas: CUMULATIVE_ROWS,
  marks: [{ threadId: THREAD_A, ...CUMULATIVE_TOTALS }],
  today: CUMULATIVE_TODAY_TOTALS,
  week: CUMULATIVE_TOTALS,
  month: CUMULATIVE_TOTALS,
};

function writeCumulative(h: TokenHarness, steps = CUMULATIVE_STEPS.length): void {
  h.rollouts.write(CUMULATIVE_DAY, CUMULATIVE_NAME, jsonl(cumulativeLines(steps)));
}

/** The prefix of the cumulative rollout and the lines still to append. */
const PREFIX_STEPS = 3;
function tailText(): string {
  return jsonl(cumulativeLines().slice(cumulativeLines(PREFIX_STEPS).length));
}

describe("Task 2: the cumulative fallback against a durable high-water mark", () => {
  it("emits non-negative deltas per counter and never lowers the high-water mark", async () => {
    const h = setup();
    writeCumulative(h);
    const outcome = await h.scanner.sweep();
    expect(outcome.completed).toBe(true);
    expect(signature(h)).toEqual(EXPECTED_SIGNATURE);
    expect(queryCodexTokenTotals(h.temp.db, WIDE)?.counters).toEqual(CUMULATIVE_TOTALS);
  });

  it("does not count a replayed prefix again and counts only the usage past the mark", async () => {
    const h = setup();
    h.rollouts.write(
      CUMULATIVE_DAY,
      CUMULATIVE_NAME,
      jsonl([
        metaLine({ cliVersion: "0.58.0", timestamp: "2026-10-09T23:45:00.000Z" }),
        tokenCountLine({ timestamp: "2026-10-10T09:00:00.000Z", total: raw(100, 0) }),
        tokenCountLine({ timestamp: "2026-10-10T09:05:00.000Z", total: raw(150, 0) }),
      ]),
    );
    await h.scanner.sweep();
    expect(queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input).toBe(150);

    resetCodexScanState(h.temp.db);
    await h.scanner.sweep();
    expect(queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input).toBe(150);

    h.rollouts.append(
      CUMULATIVE_DAY,
      CUMULATIVE_NAME,
      jsonl([tokenCountLine({ timestamp: "2026-10-10T09:10:00.000Z", total: raw(200, 0) })]),
    );
    await h.scanner.sweep();
    expect(queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input).toBe(200);
    expect(markRows(h.temp.db)).toEqual([
      expect.objectContaining({ threadId: THREAD_A, input: 200 }),
    ]);
  });

  it("counts a cumulative event beside each per-turn record once: the cumulative record is authoritative", async () => {
    const h = setup();
    h.rollouts.write("2026-10-10", NAME, perTurnWithCumulativeRollout());
    await h.scanner.sweep();
    expect(count(h.temp.db, "codex_token_cumulative")).toBe(1);
    expect(turnRows(h.temp.db)).toHaveLength(0);
    expect(queryCodexTokenTotals(h.temp.db, WIDE)?.counters.total).toBe(550);
  });

  it("adds a later cumulative event to the totals instead of ignoring it (it covers everything up to its timestamp)", async () => {
    const h = setup();
    h.rollouts.write(DAY, NAME, perTurnWithCumulativeRollout());
    await h.scanner.sweep();
    h.restart();
    h.rollouts.append(
      DAY,
      NAME,
      jsonl([tokenCountLine({ timestamp: at(1300), total: raw(500, 110) })]),
    );
    await h.scanner.sweep();
    expect(queryCodexTokenTotals(h.temp.db, WIDE)?.counters.total).toBe(610);
  });

  it("counts nothing from cumulative lines when the file name carries no thread id", async () => {
    const h = setup();
    h.rollouts.write(
      "2026-10-10",
      "rollout-weird.jsonl",
      jsonl([tokenCountLine({ timestamp: at(30), total: raw(100, 0) })]),
    );
    await h.scanner.sweep();
    expect(count(h.temp.db, "codex_token_deltas")).toBe(0);
    expect(count(h.temp.db, "codex_token_cumulative")).toBe(0);
  });

  it("does not count tokens timestamped inside an analysis-off period but still raises the mark", async () => {
    const h = setup();
    appendToggleLog(h.temp.db, "2026-10-10T09:30:00.000Z", false);
    appendToggleLog(h.temp.db, "2026-10-10T10:30:00.000Z", true);
    h.rollouts.write(
      CUMULATIVE_DAY,
      CUMULATIVE_NAME,
      jsonl([
        metaLine({ cliVersion: "0.58.0", timestamp: "2026-10-09T23:45:00.000Z" }),
        tokenCountLine({ timestamp: "2026-10-10T09:00:00.000Z", total: raw(100, 0) }),
        tokenCountLine({ timestamp: "2026-10-10T10:00:00.000Z", total: raw(300, 0) }),
        tokenCountLine({ timestamp: "2026-10-10T11:00:00.000Z", total: raw(350, 0) }),
      ]),
    );
    await h.scanner.sweep();
    // 100 before, 200 inside the off period (dropped), 50 after.
    expect(queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input).toBe(150);
    expect(markRows(h.temp.db)).toEqual([expect.objectContaining({ input: 350 })]);
  });
});

describe("Task 2: chunk and restart safety (identical totals on every route)", () => {
  it("(a) one uninterrupted scan", async () => {
    const h = setup();
    writeCumulative(h);
    await h.scanner.sweep();
    expect(signature(h)).toEqual(EXPECTED_SIGNATURE);
  });

  it("(a2) split mid-line and across the bucket and day boundary with small chunks", async () => {
    const h = setup({ over: { chunkBytes: 173 } });
    writeCumulative(h);
    await h.scanner.sweep();
    expect(signature(h)).toEqual(EXPECTED_SIGNATURE);
  });

  it("(b) a prefix, a close and reopen of the store, then a new scanner resumes", async () => {
    const h = setup();
    writeCumulative(h, PREFIX_STEPS);
    await h.scanner.sweep();
    h.restart();
    h.rollouts.append(CUMULATIVE_DAY, CUMULATIVE_NAME, tailText());
    await h.scanner.sweep();
    expect(signature(h)).toEqual(EXPECTED_SIGNATURE);
  });

  it("(c) a full scan, a cursor reset, then a full rescan", async () => {
    const h = setup();
    writeCumulative(h);
    await h.scanner.sweep();
    resetCodexScanState(h.temp.db);
    await h.scanner.sweep();
    expect(signature(h)).toEqual(EXPECTED_SIGNATURE);
  });

  it("(d1) a truncated and recreated file replays the prefix and then new usage", async () => {
    const h = setup();
    writeCumulative(h, PREFIX_STEPS);
    await h.scanner.sweep();
    // Truncated below the cursor, then recreated with everything.
    h.rollouts.write(CUMULATIVE_DAY, CUMULATIVE_NAME, jsonl([cumulativeLines()[0] ?? ""]));
    await h.scanner.sweep();
    writeCumulative(h);
    await h.scanner.sweep();
    expect(signature(h)).toEqual(EXPECTED_SIGNATURE);
  });

  it("(d2) a recreated file with a different head restarts at zero and replays", async () => {
    const h = setup();
    writeCumulative(h, PREFIX_STEPS);
    await h.scanner.sweep();
    const lines = cumulativeLines();
    lines[0] = metaLine({ cliVersion: "0.58.0", timestamp: "2026-10-09T23:44:59.000Z" });
    h.rollouts.write(CUMULATIVE_DAY, CUMULATIVE_NAME, jsonl(lines));
    await h.scanner.sweep();
    expect(signature(h)).toEqual(EXPECTED_SIGNATURE);
  });

  it("(e) a parser version bump resets cursors but not the counted tokens or the marks", async () => {
    const h = setup();
    writeCumulative(h);
    await h.scanner.sweep();
    h.restart({ parserVersion: 2 });
    await h.scanner.sweep();
    expect(signature(h)).toEqual(EXPECTED_SIGNATURE);
    expect(
      h.temp.db.prepare("SELECT DISTINCT parser_version AS v FROM codex_recognition").all(),
    ).toEqual([{ v: 2 }]);
  });

  it("rolls the deltas, the high-water mark, the tallies and the cursor back together on a failed write", async () => {
    let failures = 1;
    const h = setup({
      over: {
        ops: {
          writeCodexCursor: (...args) => {
            if (failures > 0) {
              failures -= 1;
              throw new Error("injected cursor write failure");
            }
            return writeCodexCursor(...args);
          },
        },
      },
    });
    writeCumulative(h);

    const first = await h.scanner.sweep();

    expect(first.completed).toBe(false);
    expect(first.failedFiles).toBe(1);
    expect(count(h.temp.db, "codex_token_deltas")).toBe(0);
    expect(count(h.temp.db, "codex_token_cumulative")).toBe(0);
    expect(count(h.temp.db, "codex_rollout_cursors")).toBe(0);
    expect(count(h.temp.db, "codex_recognition")).toBe(0);
    expect(count(h.temp.db, "codex_coverage_days")).toBe(0);

    const retry = await h.scanner.sweep();
    expect(retry.completed).toBe(true);
    expect(signature(h)).toEqual(EXPECTED_SIGNATURE);
  });

  it("stops at the next chunk boundary when analysis is switched off during a read and writes nothing", async () => {
    const h = setup({ over: { chunkBytes: 200 } });
    writeCumulative(h);
    let reads = 0;
    const original = h.spy.port.readRolloutRange;
    h.spy.port.readRolloutRange = (ref, offset, max) => {
      reads += 1;
      const result = original(ref, offset, max);
      // The first call is the identity head; the second is the first body chunk.
      if (reads === 2) h.state.on = false;
      return result;
    };
    const outcome = await h.scanner.sweep();
    expect(outcome.completed).toBe(false);
    expect(count(h.temp.db, "codex_rollout_cursors")).toBe(0);
    expect(count(h.temp.db, "codex_token_deltas")).toBe(0);
    h.state.on = true;
    h.spy.port.readRolloutRange = original;
    await h.scanner.sweep();
    expect(signature(h)).toEqual(EXPECTED_SIGNATURE);
  });
});

describe("Task 2: recognition, the held verdict and the parser reset", () => {
  function badRollout(version = "0.150.0", n = 30): string {
    return jsonl([
      metaLine({ cliVersion: version }),
      ...Array.from({ length: n }, (_, i) =>
        turnRecordLine({
          turnId: turn(i + 1),
          timestamp: at(10 + i),
          usage: raw(1, 1),
          malformed: true,
        }),
      ),
    ]);
  }

  it("holds a chunk that crosses the thresholds: its tallies are kept, no usage and no cursor advance", async () => {
    const h = setup();
    h.rollouts.write("2026-10-10", NAME, badRollout());

    const outcome = await h.scanner.sweep();

    expect(outcome.held).toBe(true);
    expect(outcome.completed).toBe(false);
    expect(readCodexRecognition(h.temp.db, 1)).toEqual({
      "0.150.0": { sessions: 30, recognized: 0 },
    });
    expect(count(h.temp.db, "codex_token_turns")).toBe(0);
    expect(count(h.temp.db, "codex_rollout_cursors")).toBe(0);
    expect(count(h.temp.db, "codex_coverage_days")).toBe(0);
    expect(h.scanner.recognition()).toEqual({ kind: "unavailable", version: "0.150.0" });
    for (const range of Object.values(h.scanner.summary().ranges)) {
      expect(range).toEqual({ kind: "unavailable", reason: "format-changed", version: "0.150.0" });
    }
  });

  it("holds later sweeps without opening anything, across a restart too", async () => {
    const h = setup();
    h.rollouts.write("2026-10-10", NAME, badRollout());
    await h.scanner.sweep();
    h.spy.reset();
    const again = await h.scanner.sweep();
    expect(again.held).toBe(true);
    expect(h.spy.calls).toEqual({ listRolloutFiles: 0, statRollout: 0, readRolloutRange: 0 });

    h.restart();
    const afterRestart = await h.scanner.sweep();
    expect(afterRestart.held).toBe(true);
    expect(h.spy.calls.readRolloutRange).toBe(0);
  });

  it("does not hold a version whose token lines are mostly readable", async () => {
    const h = setup();
    h.rollouts.write("2026-10-10", NAME, perTurnWithCumulativeRollout());
    await h.scanner.sweep();
    expect(readCodexRecognition(h.temp.db, 1)).toEqual({
      "0.159.2": { sessions: 8, recognized: 8 },
    });
    expect(h.scanner.recognition()).toEqual({ kind: "ok" });
  });

  it("a null info line is not a format change", async () => {
    const h = setup();
    h.rollouts.write(
      CUMULATIVE_DAY,
      CUMULATIVE_NAME,
      jsonl([
        metaLine({ cliVersion: "0.58.0", timestamp: "2026-10-09T23:45:00.000Z" }),
        ...Array.from({ length: 25 }, (_, i) =>
          tokenCountLine({ timestamp: at(i), total: i === 0 ? raw(5, 5) : null }),
        ),
      ]),
    );
    await h.scanner.sweep();
    expect(h.scanner.recognition()).toEqual({ kind: "ok" });
  });

  it("a parser version bump drops cursors, coverage and tallies and keeps counted tokens", async () => {
    const h = setup();
    h.rollouts.write("2026-10-10", NAME, perTurnRollout());
    await h.scanner.sweep();
    const before = queryCodexTokenTotals(h.temp.db, WIDE);

    h.restart({ parserVersion: 2 });
    h.state.on = false;
    // Off: nothing runs, so nothing is reset yet.
    await h.scanner.sweep();
    expect(count(h.temp.db, "codex_rollout_cursors")).toBe(1);
    h.state.on = true;
    await h.scanner.sweep();

    expect(queryCodexTokenTotals(h.temp.db, WIDE)).toEqual(before);
    expect(
      h.temp.db
        .prepare("SELECT value FROM collector_settings WHERE key = ?")
        .get("codex_token_parser_version"),
    ).toEqual({ value: "2" });
  });
});

describe("Task 2: coverage and partiality", () => {
  it("marks a day covered only by a complete sweep, never by a single-file scan", async () => {
    const h = setup();
    const path = h.rollouts.write("2026-10-10", NAME, perTurnRollout());
    await h.scanner.scanFile({ path });
    expect(queryCodexCoverage(h.temp.db, "2026-10-10", "2026-10-10").map((d) => d.status)).toEqual([
      "not-scanned",
    ]);
    expect(count(h.temp.db, "codex_token_turns")).toBe(2);

    await h.scanner.sweep();
    expect(queryCodexCoverage(h.temp.db, "2026-10-10", "2026-10-10").map((d) => d.status)).toEqual([
      "covered",
    ]);
  });

  it("does not mark coverage when a sweep is capped, until a later sweep completes", async () => {
    const h = setup({ over: { maxFilesPerSweep: 1 } });
    h.rollouts.write(
      "2026-10-10",
      rolloutName(at(0), THREAD_A),
      jsonl([metaLine(), turnRecordLine({ turnId: turn(1), timestamp: at(10), usage: raw(7, 3) })]),
    );
    h.rollouts.write(
      "2026-10-10",
      rolloutName(at(60), THREAD_B),
      jsonl([
        metaLine({ id: THREAD_B }),
        turnRecordLine({
          turnId: turn(1),
          timestamp: at(70),
          usage: raw(5, 5),
          threadId: THREAD_B,
        }),
      ]),
    );

    const first = await h.scanner.sweep();
    expect(first).toMatchObject({ completed: false, capped: true });
    expect(count(h.temp.db, "codex_token_turns")).toBe(1);
    expect(count(h.temp.db, "codex_coverage_days")).toBe(0);

    const second = await h.scanner.sweep();
    expect(second.completed).toBe(true);
    expect(count(h.temp.db, "codex_token_turns")).toBe(2);
    expect(count(h.temp.db, "codex_coverage_days")).toBeGreaterThan(0);
    expect(queryCodexTokenTotals(h.temp.db, WIDE)?.counters.total).toBe(20);
  });

  it("carries a large file across sweeps under the byte cap and ends with the uninterrupted totals", async () => {
    const h = setup({ over: { chunkBytes: 400, maxBytesPerSweep: 400 } });
    h.rollouts.write("2026-10-10", NAME, perTurnRollout());
    let sweeps = 0;
    for (; sweeps < 40; sweeps += 1) {
      const outcome = await h.scanner.sweep();
      if (outcome.completed) break;
      expect(outcome.capped).toBe(true);
    }
    expect(sweeps).toBeGreaterThan(1);
    expect(queryCodexTokenTotals(h.temp.db, WIDE)?.counters.total).toBe(550);
  });

  it("states the horizon, the uncovered days and the analysis-off days, and marks those ranges partial", async () => {
    const h = setup();
    appendToggleLog(h.temp.db, "2026-10-08T08:00:00.000Z", false);
    appendToggleLog(h.temp.db, "2026-10-08T20:00:00.000Z", true);
    h.rollouts.write(
      "2026-10-08",
      rolloutName("2026-10-08T07:00:00.000Z", THREAD_B),
      jsonl([
        metaLine({ id: THREAD_B }),
        turnRecordLine({
          turnId: turn(1),
          timestamp: "2026-10-08T12:00:00.000Z",
          usage: raw(500, 500),
          threadId: THREAD_B,
        }),
        turnRecordLine({
          turnId: turn(2),
          timestamp: "2026-10-08T21:00:00.000Z",
          usage: raw(7, 3),
          threadId: THREAD_B,
        }),
      ]),
    );
    h.rollouts.write("2026-10-10", NAME, perTurnRollout());
    await h.scanner.sweep();

    const { ranges } = h.scanner.summary();
    const today = ranges.today;
    const week = ranges["last-7-days"];
    if (today.kind !== "available" || week.kind !== "available")
      throw new Error("must be available");
    expect(today.partiality).toEqual({ partial: false });
    expect(week.partiality.partial).toBe(true);
    expect(week.partiality.missingSources).toEqual(
      expect.arrayContaining(["analysis-off", "log-retention"]),
    );
    // Oct 4..7 are before the oldest rollout day (Oct 8); Oct 8 was partly off.
    expect(week.coverage).toEqual({
      horizonDate: "2026-10-08",
      uncoveredDays: 4,
      analysisOffDays: 1,
    });
    // The turn timestamped inside the off period is not counted.
    expect(week.totals.total).toBe(10 + 550);
  });

  it("reports first-scan-pending until the first complete sweep, then available", async () => {
    const h = setup();
    h.rollouts.write("2026-10-10", NAME, perTurnRollout());
    const before = h.scanner.summary();
    expect(before.firstScanPending).toBe(true);
    for (const range of Object.values(before.ranges)) {
      expect(range).toEqual({ kind: "unavailable", reason: "first-scan-pending", version: null });
    }
    await h.scanner.sweep();
    const after = h.scanner.summary();
    expect(after.firstScanPending).toBe(false);
    expect(after.ranges.today.kind).toBe("available");
  });

  it("an empty Codex home is available with zero counters after a complete sweep, never pending", async () => {
    const h = setup();
    await h.scanner.sweep();
    const today = h.scanner.summary().ranges.today;
    expect(today.kind).toBe("available");
    if (today.kind === "available") expect(today.totals.total).toBe(0);
  });
});

describe("Task 2: scheduling, subscriber gating and publication", () => {
  it("reads nothing without subscribers, sweeps on a tick with one, and stop clears the timer", async () => {
    const h = setup();
    h.rollouts.write("2026-10-10", NAME, perTurnRollout());
    h.scanner.start();
    expect(h.timers.armed()).toBe(1);

    h.state.subscribers = 0;
    h.timers.tick();
    await h.scanner.idle();
    expect(h.spy.calls).toEqual({ listRolloutFiles: 0, statRollout: 0, readRolloutRange: 0 });

    h.state.subscribers = 1;
    h.timers.tick();
    await h.scanner.idle();
    expect(h.spy.calls.listRolloutFiles).toBe(1);
    expect(count(h.temp.db, "codex_token_turns")).toBe(2);

    h.scanner.stop();
    expect(h.timers.armed()).toBe(0);
  });

  it("a tick with analysis off reads nothing", async () => {
    const h = setup({ on: false });
    h.rollouts.write("2026-10-10", NAME, perTurnRollout());
    h.scanner.start();
    h.timers.tick();
    await h.scanner.idle();
    expect(h.spy.calls.listRolloutFiles).toBe(0);
  });

  it("refreshIfStale starts at most one sweep, and another only after the interval", async () => {
    const h = setup({ over: { sweepIntervalMs: 60_000 } });
    h.rollouts.write("2026-10-10", NAME, perTurnRollout());
    h.scanner.refreshIfStale();
    h.scanner.refreshIfStale();
    h.scanner.refreshIfStale();
    await h.scanner.idle();
    expect(h.spy.calls.listRolloutFiles).toBe(1);

    h.scanner.refreshIfStale();
    await h.scanner.idle();
    expect(h.spy.calls.listRolloutFiles).toBe(1);

    h.state.nowMs += 61_000;
    h.scanner.refreshIfStale();
    await h.scanner.idle();
    expect(h.spy.calls.listRolloutFiles).toBe(2);
  });

  it("refreshIfStale does nothing while analysis is off", async () => {
    const h = setup({ on: false });
    h.scanner.refreshIfStale();
    await h.scanner.idle();
    expect(h.spy.calls.listRolloutFiles).toBe(0);
  });

  it("an immediate sweep runs when analysis is turned on, and turning it off cancels and publishes analysis-off", async () => {
    const h = setup({ on: false });
    h.rollouts.write("2026-10-10", NAME, perTurnRollout());
    h.state.on = true;
    h.scanner.onAnalysisChanged(true);
    await h.scanner.idle();
    expect(count(h.temp.db, "codex_token_turns")).toBe(2);
    const publishedBefore = h.published.length;
    expect(publishedBefore).toBeGreaterThan(0);

    h.state.on = false;
    h.scanner.onAnalysisChanged(false);
    await h.scanner.idle();
    const last = h.published.at(-1);
    expect(last?.ranges.today).toEqual({
      kind: "unavailable",
      reason: "analysis-off",
      version: null,
    });
    // Counted tokens are kept while analysis is off.
    expect(count(h.temp.db, "codex_token_turns")).toBe(2);
  });

  it("publishes codex.tokens.updated only when the serialised summary changed, and the payload parses", async () => {
    const h = setup();
    h.rollouts.write("2026-10-10", NAME, perTurnRollout());
    await h.scanner.sweep();
    expect(h.published).toHaveLength(1);
    expect(CodexTokensUpdatedPayloadSchema.safeParse(h.published[0]).success).toBe(true);

    h.state.nowMs += 5_000;
    await h.scanner.sweep();
    expect(h.published).toHaveLength(1);

    h.rollouts.append(
      "2026-10-10",
      NAME,
      jsonl([turnRecordLine({ turnId: turn(3), timestamp: at(2400), usage: raw(9, 1) })]),
    );
    await h.scanner.sweep();
    expect(h.published).toHaveLength(2);
  });

  it("reset forgets the scan state and goes back to first-scan-pending", async () => {
    const h = setup();
    h.rollouts.write("2026-10-10", NAME, perTurnRollout());
    await h.scanner.sweep();
    expect(h.scanner.summary().firstScanPending).toBe(false);
    h.temp.db.exec("DELETE FROM codex_token_turns");
    h.scanner.reset();
    expect(h.scanner.summary().firstScanPending).toBe(true);
  });
});

describe("Task 2: the database-wide decoy scan", () => {
  it("finds no prompt, reply, title, path or account marker in any table, payload, summary or log", async () => {
    const h = setup();
    h.rollouts.write("2026-10-10", NAME, perTurnRollout());
    h.rollouts.write(CUMULATIVE_DAY, CUMULATIVE_NAME, jsonl(cumulativeLines()));
    h.rollouts.write(
      "2026-10-10",
      rolloutName(at(100), THREAD_B),
      jsonl([
        metaLine({ id: THREAD_B, cliVersion: "0.150.0" }),
        ...contentLines(at(101)),
        ...Array.from({ length: 30 }, (_, i) =>
          turnRecordLine({
            turnId: turn(i + 1),
            timestamp: at(110 + i),
            usage: raw(1, 1),
            threadId: THREAD_B,
            malformed: true,
          }),
        ),
      ]),
    );
    await h.scanner.sweep();
    await h.scanner.sweep();

    const everything = [
      dumpCodexTables(h.temp.db),
      JSON.stringify(h.published),
      JSON.stringify(h.scanner.summary()),
      JSON.stringify(h.logs),
    ].join("\n");
    for (const decoy of ALL_DECOYS) expect(everything).not.toContain(decoy);
    expect(everything).not.toContain(h.rollouts.home.root);
    expect(everything).not.toContain("rollout-");
    expect(everything).not.toContain("/Users/");
  });
});
