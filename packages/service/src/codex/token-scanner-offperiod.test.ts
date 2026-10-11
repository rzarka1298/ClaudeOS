import { appendToggleLog, queryCodexTokenTotals } from "@ccc/operational-store";
import { afterEach, describe, expect, it } from "vitest";
import {
  at,
  createTokenHarness,
  jsonl,
  metaLine,
  raw,
  rolloutName,
  THREAD_A,
  type TokenHarness,
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

function inputTotal(h: TokenHarness): number | undefined {
  return queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input;
}

describe("Codex token scanner: analysis-off increments within a turn", () => {
  it("excludes the off-period increment from later cumulative-within-turn records", async () => {
    const h = setup();
    appendToggleLog(h.temp.db, at(100), false);
    appendToggleLog(h.temp.db, at(200), true);
    h.rollouts.write(
      DAY,
      NAME,
      jsonl([
        metaLine(),
        turnRecordLine({ turnId: turn(1), timestamp: at(50), usage: raw(100, 0) }),
        turnRecordLine({ turnId: turn(1), timestamp: at(150), usage: raw(200, 0) }),
        turnRecordLine({ turnId: turn(1), timestamp: at(250), usage: raw(300, 0) }),
      ]),
    );
    await h.scanner.sweep();
    expect(inputTotal(h)).toBe(200);
  });

  it("keeps the off-period exclusion across a scanner restart and a cursor replay", async () => {
    const h = setup();
    appendToggleLog(h.temp.db, at(100), false);
    appendToggleLog(h.temp.db, at(200), true);
    h.rollouts.write(
      DAY,
      NAME,
      jsonl([
        metaLine(),
        turnRecordLine({ turnId: turn(1), timestamp: at(50), usage: raw(100, 0) }),
        turnRecordLine({ turnId: turn(1), timestamp: at(150), usage: raw(200, 0) }),
      ]),
    );
    await h.scanner.sweep();
    h.restart();
    h.rollouts.append(
      DAY,
      NAME,
      jsonl([turnRecordLine({ turnId: turn(1), timestamp: at(250), usage: raw(300, 0) })]),
    );
    await h.scanner.sweep();
    expect(inputTotal(h)).toBe(200);
  });
});
