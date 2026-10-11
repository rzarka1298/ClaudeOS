import type { CodexTokenCounters } from "@ccc/domain";
import {
  addCumulativeDelta,
  appendToggleLog,
  deleteAllUsageAnalytics,
  getCollectorSetting,
  markCodexDayCovered,
  queryCodexCoverage,
  queryCodexTokenTotals,
  resetCodexScanState,
  setCollectorSetting,
  setTurnContribution,
  writeCumulativeBaseline,
} from "@ccc/operational-store";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTokenHarness,
  jsonl,
  metaLine,
  raw,
  rolloutName,
  THREAD_A,
  THREAD_B,
  type TokenHarness,
  tokenCountLine,
  turn,
  turnRecordLine,
} from "../test-support/codex-token-fixtures.js";
import { CODEX_TOKEN_PARSER_VERSION } from "./token-scanner.js";

/**
 * The three data-integrity reproductions of the Codex re-review
 * (20261010T211420683Z), as scanner-level regressions. Totals must depend on the
 * records only: never on chunk boundaries, never on which day a scan ran, and a
 * parser upgrade must never delete usage it cannot rebuild.
 */

const DAY = "2026-10-10";
const NAME = rolloutName("2026-10-10T08:00:00.000Z", THREAD_A);
const WIDE = { start: "2020-01-01T00:00:00.000Z", end: "2030-01-01T00:00:00.000Z" };

const t = (hh: number, mm: number, ss = 0): string =>
  `2026-10-10T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.000Z`;

let harness: TokenHarness | null = null;
afterEach(() => {
  harness?.cleanup();
  harness = null;
});

/** The counted rows without their owner key (a path hash differs between two homes). */
function rowsOf(h: TokenHarness) {
  return h.temp.db
    .prepare(
      `SELECT bucket_start AS bucket, input, cached_input AS cachedInput, cache_write AS cacheWrite,
              output, reasoning_output AS reasoningOutput, total
         FROM codex_token_deltas ORDER BY bucket_start`,
    )
    .all();
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function range(h: TokenHarness, start: string, end: string): number | undefined {
  return queryCodexTokenTotals(h.temp.db, { start, end })?.counters.input;
}

describe("Codex re-review finding 1: totals do not depend on chunk boundaries", () => {
  // cumulative 100 while enabled, per-turn 150 while disabled, then cumulative 150 and 250
  // while enabled, all in one bucket. The off-period usage is excluded exactly once whatever
  // the chunking: 100 enabled usage (the cumulative record that follows includes the 150).
  const lines = [
    metaLine(),
    tokenCountLine({ timestamp: t(10, 1), total: raw(100, 0) }),
    turnRecordLine({ turnId: turn(1), timestamp: t(10, 2, 30), usage: raw(150, 0) }),
    tokenCountLine({ timestamp: t(10, 4), total: raw(150, 0) }),
    tokenCountLine({ timestamp: t(10, 5), total: raw(250, 0) }),
  ];

  for (const chunkBytes of [1, 64, 4096, 256 * 1024]) {
    it(`chunk size ${chunkBytes} counts 100`, async () => {
      const h = createTokenHarness({ over: { chunkBytes } });
      harness = h;
      appendToggleLog(h.temp.db, t(10, 2), false);
      appendToggleLog(h.temp.db, t(10, 3), true);
      h.rollouts.write(DAY, NAME, jsonl(lines));
      await h.scanner.sweep();
      expect(queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input).toBe(100);
    });
  }
});

describe("Codex re-review finding 2: retained usage stays on the day it happened", () => {
  it("turn 100 yesterday kept through an off cumulative, 150 today => yesterday 100, today 50", async () => {
    const h = createTokenHarness();
    harness = h;
    appendToggleLog(h.temp.db, "2026-10-10T00:05:00.000Z", false);
    appendToggleLog(h.temp.db, "2026-10-10T00:10:00.000Z", true);
    h.rollouts.write(
      DAY,
      NAME,
      jsonl([
        metaLine(),
        turnRecordLine({
          turnId: turn(1),
          timestamp: "2026-10-09T23:50:00.000Z",
          usage: raw(100, 0),
        }),
        tokenCountLine({ timestamp: "2026-10-10T00:07:00.000Z", total: raw(100, 0) }),
        turnRecordLine({
          turnId: turn(1),
          timestamp: "2026-10-10T00:20:00.000Z",
          usage: raw(150, 0),
        }),
      ]),
    );
    await h.scanner.sweep();
    expect(range(h, "2026-10-09T00:00:00.000Z", "2026-10-10T00:00:00.000Z")).toBe(100);
    expect(range(h, "2026-10-10T00:00:00.000Z", "2026-10-11T00:00:00.000Z")).toBe(50);
  });
});

describe("Codex re-review finding 3: a parser upgrade never deletes usage it cannot rebuild", () => {
  const AT = "2026-10-10T11:00:00.000Z";
  const six = (n: number): CodexTokenCounters => ({
    input: n,
    cachedInput: 0,
    cacheWrite: 0,
    output: 0,
    reasoningOutput: 0,
    total: n,
  });

  /** A store as the version-2 scanner left it: rows by thread, derived settings, coverage. */
  function seedV2Store(h: TokenHarness): void {
    const db = h.temp.db;
    setCollectorSetting(
      db,
      "codex_token_parser_version",
      String(CODEX_TOKEN_PARSER_VERSION - 1),
      AT,
    );
    setTurnContribution(db, {
      threadId: THREAD_A,
      turnId: turn(1),
      bucketStart: "2026-10-10T10:00:00.000Z",
      counters: six(150),
      observedAt: AT,
    });
    addCumulativeDelta(db, {
      threadId: THREAD_B,
      bucketStart: "2026-10-09T09:00:00.000Z",
      delta: six(70),
    });
    writeCumulativeBaseline(db, THREAD_B, six(70), AT);
    setCollectorSetting(db, `codex_token_turn:${THREAD_A}:${turn(1)}`, "{}", AT);
    setCollectorSetting(db, `codex_token_cumat:${THREAD_B}`, AT, AT);
    markCodexDayCovered(db, "2026-10-09", AT);
    markCodexDayCovered(db, DAY, AT);
  }

  const SEEDED_TOTAL = 220;

  it("a deleted rollout keeps its rows, is reported not-rescanned, and the sweep is not zero or null", async () => {
    const h = createTokenHarness();
    harness = h;
    seedV2Store(h);

    const outcome = await h.scanner.sweep();

    expect(queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input).toBe(SEEDED_TOTAL);
    expect(outcome.notRescanned).toBe(2);
    expect(count(h.temp.db, "codex_token_turns")).toBe(1);
    // The previous parser's derived state is gone; the coverage of the kept rows is not.
    expect(getCollectorSetting(h.temp.db, `codex_token_turn:${THREAD_A}:${turn(1)}`)).toBeNull();
    expect(count(h.temp.db, "codex_token_cumulative")).toBe(0);
    expect(queryCodexCoverage(h.temp.db, "2026-10-09", DAY).map((d) => d.status)).toEqual([
      "covered",
      "covered",
    ]);
    const week = h.scanner.summary().ranges["last-7-days"];
    expect(week.kind === "available" && week.totals.input).toBe(SEEDED_TOTAL);
  });

  it("a rollout that can be read again replaces only its own thread's old rows", async () => {
    const h = createTokenHarness();
    harness = h;
    seedV2Store(h);
    // Thread A's rollout still exists; thread B's was deleted.
    h.rollouts.write(
      DAY,
      NAME,
      jsonl([
        metaLine(),
        turnRecordLine({ turnId: turn(1), timestamp: t(10, 2), usage: raw(160, 0) }),
      ]),
    );

    const outcome = await h.scanner.sweep();

    // A's 150 is replaced by the rebuilt 160; B's 70 stays.
    expect(queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input).toBe(230);
    expect(count(h.temp.db, "codex_token_turns")).toBe(0);
    expect(outcome).toMatchObject({ completed: true, notRescanned: 1, notScanned: 0 });
    // A second sweep changes nothing.
    await h.scanner.sweep();
    expect(queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input).toBe(230);
  });

  it("a rollout above the size bound is not-scanned: its old rows stay, nothing is claimed complete", async () => {
    const h = createTokenHarness({ over: { maxRolloutBytes: 100 } });
    harness = h;
    seedV2Store(h);
    h.rollouts.write(
      DAY,
      NAME,
      jsonl([
        metaLine(),
        turnRecordLine({ turnId: turn(1), timestamp: t(10, 2), usage: raw(160, 0) }),
      ]),
    );

    const outcome = await h.scanner.sweep();

    expect(outcome).toMatchObject({ completed: false, notScanned: 1, notRescanned: 2 });
    expect(queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input).toBe(SEEDED_TOTAL);
    expect(count(h.temp.db, "codex_rollout_cursors")).toBe(0);
    expect(h.scanner.summary().firstScanPending).toBe(true);
    // The partial read is never counted either, on a direct scan.
    const direct = await h.scanner.scanFile({ path: h.rollouts.home.rolloutPath(DAY, NAME) });
    expect(direct).toEqual({ kind: "not-scanned", reason: "too-large" });
  });

  it("a rollout that grows past the bound keeps the rows of its last complete read", async () => {
    const first = jsonl([
      metaLine(),
      turnRecordLine({ turnId: turn(1), timestamp: t(10, 2), usage: raw(40, 0) }),
    ]);
    const h = createTokenHarness({ over: { maxRolloutBytes: Buffer.byteLength(first) + 50 } });
    harness = h;
    h.rollouts.write(DAY, NAME, first);
    await h.scanner.sweep();
    expect(queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input).toBe(40);
    h.rollouts.append(
      DAY,
      NAME,
      jsonl([
        turnRecordLine({ turnId: turn(1), timestamp: t(10, 3), usage: raw(90, 0) }),
        turnRecordLine({ turnId: turn(1), timestamp: t(10, 4), usage: raw(95, 0) }),
      ]),
    );
    const outcome = await h.scanner.sweep();
    expect(outcome.notScanned).toBe(1);
    expect(queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input).toBe(40);
  });

  it("the usage of a deleted rollout also survives a second upgrade-free sweep and analytics deletion clears it", async () => {
    const h = createTokenHarness();
    harness = h;
    seedV2Store(h);
    await h.scanner.sweep();
    await h.scanner.sweep();
    expect(queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input).toBe(SEEDED_TOTAL);
    deleteAllUsageAnalytics(h.temp.db);
    h.scanner.reset();
    expect(queryCodexTokenTotals(h.temp.db, WIDE)).toBeNull();
    expect(getCollectorSetting(h.temp.db, "codex_token_parser_version")).toBe(
      String(CODEX_TOKEN_PARSER_VERSION),
    );
  });
});

describe("Codex re-review finding 2 (cont.): attribution is by record time, never scan time", () => {
  it("scanning the same rollout on another day, in two steps, yields the same rows", async () => {
    const lines = [
      metaLine(),
      turnRecordLine({
        turnId: turn(1),
        timestamp: "2026-10-09T23:50:00.000Z",
        usage: raw(100, 0),
      }),
      tokenCountLine({ timestamp: "2026-10-10T00:07:00.000Z", total: raw(100, 0) }),
      turnRecordLine({
        turnId: turn(1),
        timestamp: "2026-10-10T00:20:00.000Z",
        usage: raw(150, 0),
      }),
    ];
    const rows: unknown[] = [];
    for (const nowIso of ["2026-10-10T12:00:00.000Z", "2026-10-12T03:00:00.000Z"]) {
      const h = createTokenHarness({ nowIso });
      appendToggleLog(h.temp.db, "2026-10-10T00:05:00.000Z", false);
      appendToggleLog(h.temp.db, "2026-10-10T00:10:00.000Z", true);
      h.rollouts.write(DAY, NAME, jsonl(lines.slice(0, 2)));
      await h.scanner.sweep();
      h.rollouts.append(DAY, NAME, jsonl(lines.slice(2)));
      await h.scanner.sweep();
      rows.push(rowsOf(h));
      h.cleanup();
    }
    expect(rows[0]).toEqual(rows[1]);
    expect(
      (rows[0] as Array<{ bucket: string; input: number }>).map((r) => [r.bucket, r.input]),
    ).toEqual([
      ["2026-10-09T23:45:00.000Z", 100],
      ["2026-10-10T00:15:00.000Z", 50],
    ]);
  });
});

describe("Incremental growth and a scan from scratch store identical rows", () => {
  // Per-turn and cumulative records, an analysis-off window, a bucket and a day boundary.
  const lines = [
    metaLine(),
    tokenCountLine({ timestamp: "2026-10-09T23:30:00.000Z", total: raw(100, 0) }),
    turnRecordLine({ turnId: turn(1), timestamp: "2026-10-09T23:50:00.000Z", usage: raw(30, 0) }),
    tokenCountLine({ timestamp: "2026-10-10T00:02:00.000Z", total: raw(140, 0) }),
    turnRecordLine({ turnId: turn(1), timestamp: "2026-10-10T00:20:00.000Z", usage: raw(70, 0) }),
    turnRecordLine({ turnId: turn(2), timestamp: "2026-10-10T00:40:00.000Z", usage: raw(25, 0) }),
    turnRecordLine({ turnId: turn(2), timestamp: "2026-10-10T01:10:00.000Z", usage: raw(60, 0) }),
    tokenCountLine({ timestamp: "2026-10-10T01:20:00.000Z", total: raw(260, 0) }),
    turnRecordLine({ turnId: turn(3), timestamp: "2026-10-10T01:50:00.000Z", usage: raw(15, 0) }),
    turnRecordLine({ turnId: turn(3), timestamp: "2026-10-10T02:10:00.000Z", usage: raw(45, 0) }),
    tokenCountLine({ timestamp: "2026-10-10T02:20:00.000Z", total: raw(330, 0) }),
    turnRecordLine({ turnId: turn(4), timestamp: "2026-10-10T03:05:00.000Z", usage: raw(12, 0) }),
  ];
  const off = [["2026-10-10T00:30:00.000Z", "2026-10-10T01:30:00.000Z"]] as const;

  function arrange(h: TokenHarness): void {
    for (const [from, to] of off) {
      appendToggleLog(h.temp.db, from, false);
      appendToggleLog(h.temp.db, to, true);
    }
  }

  it("rows after every incremental append, restart and cursor reset equal a from-scratch scan of the final file", async () => {
    const fresh = createTokenHarness();
    arrange(fresh);
    fresh.rollouts.write(DAY, NAME, jsonl(lines));
    await fresh.scanner.sweep();
    const scratch = rowsOf(fresh);
    fresh.cleanup();
    expect(scratch.length).toBeGreaterThan(3);

    for (const step of [1, 2, 5]) {
      const h = createTokenHarness({ over: { chunkBytes: 97 } });
      harness = h;
      arrange(h);
      for (let i = 0; i < lines.length; i += step) {
        const group = jsonl(lines.slice(i, i + step));
        if (i === 0) h.rollouts.write(DAY, NAME, group);
        else h.rollouts.append(DAY, NAME, group);
        await h.scanner.sweep();
        if (i % 2 === 0) h.restart({ chunkBytes: 97 });
        else resetCodexScanState(h.temp.db);
      }
      expect(rowsOf(h)).toEqual(scratch);
      h.cleanup();
      harness = null;
    }
  });
});
