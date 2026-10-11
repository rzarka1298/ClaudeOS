import type { RolloutFact } from "@ccc/collectors";
import { describe, expect, it } from "vitest";
import { type OffInterval, tokensForRollout } from "./token-count.js";

/**
 * Table tests of the pure counting core (plan 05.1-23). Every precedence
 * scenario of the earlier scanner suite is kept with its expected value; the
 * three Codex re-review reproductions are added. There is no chunk, cursor or
 * store here, so chunk independence is not a property to test: it holds because
 * the function sees the whole rollout.
 */

import { CASES, counters, cum, ms, pt, THREAD, t } from "./token-count-cases.js";

function run(
  records: readonly RolloutFact[],
  off: ReadonlyArray<readonly [string, string]> = [],
  fileThread: string | null = THREAD,
) {
  const intervals: OffInterval[] = off.map(([from, to]) => ({ startMs: ms(from), endMs: ms(to) }));
  return tokensForRollout(records, intervals, fileThread);
}

function inputByBucket(
  records: readonly RolloutFact[],
  off: ReadonlyArray<readonly [string, string]> = [],
) {
  return Object.fromEntries([...run(records, off).buckets].map(([bucket, c]) => [bucket, c.input]));
}

function total(
  records: readonly RolloutFact[],
  off: ReadonlyArray<readonly [string, string]> = [],
) {
  return [...run(records, off).buckets.values()].reduce((sum, c) => sum + c.input, 0);
}

describe("tokensForRollout: the precedence rule and per-record attribution", () => {
  it.each(CASES)("$name", ({ records, off, expected, buckets }) => {
    expect(total(records, off)).toBe(expected);
    if (buckets !== undefined) expect(inputByBucket(records, off)).toEqual(buckets);
  });
});

describe("tokensForRollout: edges", () => {
  it("returns nothing, and no all-zero bucket, for an empty or all-zero rollout", () => {
    expect(run([]).buckets.size).toBe(0);
    expect(run([cum(t(10, 1), 0), pt(1, t(10, 1), 0)]).buckets.size).toBe(0);
  });

  it("counts a cumulative-only rollout with no thread id as nothing (the file name names the thread)", () => {
    expect(run([cum(t(10, 1), 100)], [], null).buckets.size).toBe(0);
  });

  it("counts a per-turn record by its own thread id, and a record naming another thread is not cut by this thread's cumulative", () => {
    const records = [cum(t(10, 5), 100), pt(1, t(10, 4), 30, "thread-bbbb2222")];
    const result = run(records);
    expect([...result.buckets.values()].reduce((s, c) => s + c.input, 0)).toBe(130);
    expect([...result.threads]).toEqual(["thread-bbbb2222"]);
  });

  it("skips records that cannot be attributed and reports them", () => {
    const records: RolloutFact[] = [
      { kind: "tokens-turn", threadId: null, turnId: "turn-1", time: null, counters: counters(5) },
      {
        kind: "tokens-turn",
        threadId: null,
        turnId: "turn-2",
        time: "not a time",
        counters: counters(5),
      },
      { kind: "tokens-cumulative", time: null, counters: counters(5) },
      cum(t(10, 1), 7),
    ];
    const result = run(records);
    expect(result.skipped).toBe(3);
    expect([...result.buckets.values()].reduce((s, c) => s + c.input, 0)).toBe(7);
  });

  it("is deterministic: the same records give the same buckets, and a longer rollout never lowers an earlier bucket", () => {
    const records = [pt(1, t(10, 1), 40), pt(1, t(10, 20), 100), pt(2, t(11, 5), 30)];
    expect(inputByBucket(records)).toEqual(inputByBucket(records));
    const longer = inputByBucket([...records, pt(1, t(12, 0), 160)]);
    for (const [bucket, value] of Object.entries(inputByBucket(records))) {
      expect(longer[bucket] ?? 0).toBeGreaterThanOrEqual(value);
    }
  });
});
