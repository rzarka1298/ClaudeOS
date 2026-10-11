import { utimesSync } from "node:fs";
import { queryCodexCoverage, queryCodexTokenTotals } from "@ccc/operational-store";
import { afterEach, describe, expect, it } from "vitest";
import {
  at,
  createTokenHarness,
  jsonl,
  metaLine,
  NOW_ISO,
  raw,
  rolloutName,
  THREAD_A,
  type TokenHarness,
  tokenCountLine,
} from "../test-support/codex-token-fixtures.js";

/**
 * Opus phase-end review W1: a thread created long before the listing window, resumed today and
 * appended to its ORIGINAL dated rollout, must still be rescanned, and today must not read as
 * complete when that rollout could not be read.
 */

const OLD_DAY = "2026-07-01";
const NAME = rolloutName("2026-07-01T09:00:00.000Z", THREAD_A);
const WIDE = { start: "2020-01-01T00:00:00.000Z", end: "2030-01-01T00:00:00.000Z" };
const TODAY = "2026-10-10";

let harness: TokenHarness | null = null;

afterEach(() => {
  harness?.cleanup();
  harness = null;
});

function setup(options: Parameters<typeof createTokenHarness>[0] = {}): TokenHarness {
  harness = createTokenHarness(options);
  return harness;
}

function touch(path: string, iso: string): void {
  const when = new Date(iso);
  utimesSync(path, when, when);
}

const inputTotal = (h: TokenHarness): number | undefined =>
  queryCodexTokenTotals(h.temp.db, WIDE)?.counters.input;

describe("an old-dated rollout appended today", () => {
  it("is rescanned because its modification time falls in the coverage window", async () => {
    const h = setup();
    const path = h.rollouts.write(
      OLD_DAY,
      NAME,
      jsonl([
        metaLine({ timestamp: "2026-07-01T09:00:00.000Z" }),
        tokenCountLine({ timestamp: "2026-07-01T09:05:00.000Z", total: raw(50, 0) }),
      ]),
    );
    touch(path, "2026-07-02T00:00:00.000Z");
    await h.scanner.sweep();
    expect(inputTotal(h)).toBeUndefined();

    h.rollouts.append(
      OLD_DAY,
      NAME,
      jsonl([tokenCountLine({ timestamp: at(30), total: raw(80, 0) })]),
    );
    touch(path, NOW_ISO);
    const outcome = await h.scanner.sweep();
    expect(outcome.completed).toBe(true);
    expect(inputTotal(h)).toBe(80);
  });

  it("does not let today read as covered when that old rollout could not be read", async () => {
    const h = setup({ over: { maxRolloutBytes: 200 } });
    const path = h.rollouts.write(
      OLD_DAY,
      NAME,
      jsonl([
        metaLine(),
        tokenCountLine({ timestamp: at(30), total: raw(80, 0) }),
        tokenCountLine({ timestamp: at(60), total: raw(90, 0) }),
      ]),
    );
    touch(path, NOW_ISO);
    const outcome = await h.scanner.sweep();
    expect(outcome.notScanned).toBe(1);
    expect(outcome.completed).toBe(false);
    expect(queryCodexCoverage(h.temp.db, TODAY, TODAY).map((d) => d.status)).toEqual([
      "not-scanned",
    ]);
  });
});
