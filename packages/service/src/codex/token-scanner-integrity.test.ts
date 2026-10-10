import {
  appendToggleLog,
  markCodexDayCovered,
  queryCodexTokenTotals,
  setCollectorSetting,
  setTurnContribution,
} from "@ccc/operational-store";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTokenHarness,
  jsonl,
  metaLine,
  raw,
  rolloutName,
  THREAD_A,
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
  it("a store written by the previous parser keeps a deleted rollout's usage", async () => {
    const h = createTokenHarness();
    harness = h;
    const at = "2026-10-10T11:00:00.000Z";
    // The previous parser's counted state: a turn row, its derived settings and day coverage.
    setCollectorSetting(
      h.temp.db,
      "codex_token_parser_version",
      String(CODEX_TOKEN_PARSER_VERSION - 1),
      at,
    );
    setTurnContribution(h.temp.db, {
      threadId: THREAD_A,
      turnId: turn(1),
      bucketStart: "2026-10-10T10:00:00.000Z",
      counters: {
        input: 150,
        cachedInput: 0,
        cacheWrite: 0,
        output: 0,
        reasoningOutput: 0,
        total: 150,
      },
      observedAt: at,
    });
    setCollectorSetting(h.temp.db, `codex_token_turn:${THREAD_A}:${turn(1)}`, "{}", at);
    markCodexDayCovered(h.temp.db, DAY, at);
    // The rollout itself no longer exists: nothing is listed.
    const outcome = await h.scanner.sweep();
    expect(queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input).toBe(150);
    expect(outcome.completed && queryCodexTokenTotals(h.temp.db, WIDE) === null).toBe(false);
  });
});
