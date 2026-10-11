import type { CodexTokenCounters } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  at,
  rawCounters,
  rolloutText,
  tokenCountLine,
  tokenUsageRecordLine,
  turnId,
} from "../../test-support/codex-rollouts.js";
import { parseRolloutChunk, type RolloutFact } from "./rollout.js";
import { foldCumulativeDeltas, foldTurnTokens, turnKey } from "./tokens.js";

/** UTC day, the way a caller with a UTC policy would bucket. */
const dayOf = (iso: string): string => iso.slice(0, 10);

const ZERO: CodexTokenCounters = {
  input: 0,
  cachedInput: 0,
  cacheWrite: 0,
  output: 0,
  reasoningOutput: 0,
  total: 0,
};

function counters(over: Partial<CodexTokenCounters>): CodexTokenCounters {
  return { ...ZERO, ...over };
}

function turnFact(
  turn: string,
  time: string | null,
  c: CodexTokenCounters | null,
  threadId: string | null = "thread-aaaa1111",
): RolloutFact {
  return { kind: "tokens-turn", threadId, turnId: turn, time, counters: c };
}

function cumFact(time: string | null, c: CodexTokenCounters | null): RolloutFact {
  return { kind: "tokens-cumulative", time, counters: c };
}

const DAY1 = "2026-10-10T23:59:00.000Z";
const DAY2 = "2026-10-11T00:01:00.000Z";

describe("Test 1: foldTurnTokens keeps the latest cumulative value per thread and turn", () => {
  it("folds three growing records of one turn to ONE entry holding the latest counters", () => {
    const fold = foldTurnTokens(
      [
        turnFact(turnId(1), DAY1, counters({ input: 10, output: 2, total: 12 })),
        turnFact(turnId(1), DAY1, counters({ input: 30, output: 5, total: 35 })),
        turnFact(turnId(1), DAY2, counters({ input: 50, output: 9, total: 59 })),
      ],
      { dayOf },
    );
    expect(fold.entries.size).toBe(1);
    const entry = fold.entries.get(turnKey("thread-aaaa1111", turnId(1)));
    expect(entry?.counters).toEqual(counters({ input: 50, output: 9, total: 59 }));
    // never the sum
    expect(entry?.counters.input).not.toBe(90);
    expect(entry?.at).toBe(DAY2);
  });

  it("takes the day of the FIRST record of the turn", () => {
    const fold = foldTurnTokens(
      [
        turnFact(turnId(1), DAY1, counters({ input: 10, total: 10 })),
        turnFact(turnId(1), DAY2, counters({ input: 20, total: 20 })),
      ],
      { dayOf },
    );
    expect([...fold.entries.values()][0]?.day).toBe("2026-10-10");
  });

  it("folds two different turns, and the same turn id on two threads, to separate entries", () => {
    const fold = foldTurnTokens(
      [
        turnFact(turnId(1), DAY1, counters({ input: 10, total: 10 })),
        turnFact(turnId(2), DAY1, counters({ input: 5, total: 5 })),
        turnFact(turnId(1), DAY1, counters({ input: 7, total: 7 }), "thread-bbbb2222"),
      ],
      { dayOf },
    );
    expect(fold.entries.size).toBe(3);
  });
});

describe("Test 2: repeated lines, null info and unrecognisable counters", () => {
  it("repeated identical lines and a null info change nothing", () => {
    const text = rolloutText([
      tokenUsageRecordLine({ turn: turnId(1), turnUsage: rawCounters(50, 10) }),
      tokenUsageRecordLine({ turn: turnId(1), turnUsage: rawCounters(50, 10) }),
      tokenCountLine({ total: null, rateLimits: null }),
      tokenUsageRecordLine({ turn: turnId(1), turnUsage: rawCounters(50, 10) }),
    ]);
    const { facts } = parseRolloutChunk(text);
    const fold = foldTurnTokens(facts, { dayOf });
    expect(fold.entries.size).toBe(1);
    expect([...fold.entries.values()][0]?.counters).toEqual(
      counters({ input: 50, output: 10, total: 60 }),
    );
    expect(fold.skipped).toBe(0);
    const cumulative = foldCumulativeDeltas(facts, null, { dayOf });
    expect(cumulative.next).toEqual(ZERO);
  });

  it("a missing member falls back to zero only when the other five parse", () => {
    const { cache_write_input_tokens: _omit, ...fiveOfSix } = rawCounters(10, 5);
    const text = rolloutText([tokenUsageRecordLine({ turn: turnId(1), turnUsage: fiveOfSix })]);
    const fold = foldTurnTokens(parseRolloutChunk(text).facts, { dayOf });
    expect([...fold.entries.values()][0]?.counters).toEqual(
      counters({ input: 10, output: 5, total: 15 }),
    );
  });

  it("skips and counts a record with no recognisable counters", () => {
    const text = rolloutText([
      tokenUsageRecordLine({ turn: turnId(1), turnUsage: { input_tokens: 4 } }),
      tokenUsageRecordLine({ turn: turnId(2), turnUsage: rawCounters(3, 1) }),
    ]);
    const fold = foldTurnTokens(parseRolloutChunk(text).facts, { dayOf });
    expect(fold.entries.size).toBe(1);
    expect(fold.skipped).toBe(1);
  });

  it("skips and counts an entry with no usable thread id or time", () => {
    const fold = foldTurnTokens(
      [
        turnFact(turnId(1), DAY1, counters({ input: 1, total: 1 }), null),
        turnFact(turnId(2), null, counters({ input: 1, total: 1 })),
      ],
      { dayOf },
    );
    expect(fold.entries.size).toBe(0);
    expect(fold.skipped).toBe(2);
    const withFallback = foldTurnTokens(
      [turnFact(turnId(1), DAY1, counters({ input: 1, total: 1 }), null)],
      {
        dayOf,
        fallbackThreadId: "thread-cccc3333",
      },
    );
    expect([...withFallback.entries.values()][0]?.threadId).toBe("thread-cccc3333");
  });
});

describe("Test 3: foldCumulativeDeltas with a durable high-water mark", () => {
  const total = (n: number): CodexTokenCounters => counters({ input: n, total: n });
  const sum = (fold: ReturnType<typeof foldCumulativeDeltas>): number =>
    [...fold.deltas.values()].reduce((acc, c) => acc + c.total, 0);

  it("emits 100, 50, 0, 0, 0, 30 for totals 100, 150, 150, null, 120, 180", () => {
    const sequence: (CodexTokenCounters | null)[] = [
      total(100),
      total(150),
      total(150),
      null,
      total(120),
      total(180),
    ];
    let mark: CodexTokenCounters | null = null;
    const emitted: number[] = [];
    for (const [i, c] of sequence.entries()) {
      const fold = foldCumulativeDeltas([cumFact(at(i), c)], mark, { dayOf });
      emitted.push(sum(fold));
      mark = fold.next;
    }
    expect(emitted).toEqual([100, 50, 0, 0, 0, 30]);
    expect(mark).toEqual(total(180));
    // one pass matches the stepwise result
    const single = foldCumulativeDeltas(
      sequence.map((c, i) => cumFact(at(i), c)),
      null,
      { dayOf },
    );
    expect(sum(single)).toBe(180);
    expect(single.next).toEqual(total(180));
  });

  it("replays a prefix against a saved mark of 180 and emits only the increment to 200", () => {
    const fold = foldCumulativeDeltas(
      [100, 150, 120, 180, 200].map((n, i) => cumFact(at(i), total(n))),
      total(180),
      { dayOf },
    );
    expect(sum(fold)).toBe(20);
    expect(fold.next).toEqual(total(200));
  });

  it("splits across calls and days with totals equal to a single pass", () => {
    const facts = [
      cumFact(DAY1, total(40)),
      cumFact(DAY1, total(90)),
      cumFact(DAY2, total(130)),
      cumFact(DAY2, total(130)),
      cumFact(DAY2, total(170)),
    ];
    const single = foldCumulativeDeltas(facts, null, { dayOf });
    const a = foldCumulativeDeltas(facts.slice(0, 2), null, { dayOf });
    const b = foldCumulativeDeltas(facts.slice(2), a.next, { dayOf });
    expect(single.deltas.get("2026-10-10")?.total).toBe(90);
    expect(single.deltas.get("2026-10-11")?.total).toBe(80);
    expect(a.deltas.get("2026-10-10")?.total).toBe(90);
    expect(b.deltas.get("2026-10-11")?.total).toBe(80);
    expect(b.next).toEqual(single.next);
  });

  it("tracks each counter independently: a decrease cannot lower a member or count another twice", () => {
    const first = counters({ input: 100, output: 50, total: 150 });
    const second = counters({ input: 90, output: 70, total: 160 });
    const third = counters({ input: 110, output: 60, total: 170 });
    const fold = foldCumulativeDeltas(
      [cumFact(DAY1, first), cumFact(DAY1, second), cumFact(DAY1, third)],
      null,
      {
        dayOf,
      },
    );
    expect(fold.next).toEqual(counters({ input: 110, output: 70, total: 170 }));
    expect(fold.deltas.get("2026-10-10")).toEqual(counters({ input: 110, output: 70, total: 170 }));
  });

  it("never lowers the mark and never returns a negative delta, whatever the input", () => {
    const mark = counters({
      input: 500,
      cachedInput: 300,
      cacheWrite: 20,
      output: 200,
      reasoningOutput: 10,
      total: 700,
    });
    const fold = foldCumulativeDeltas([cumFact(DAY1, counters({ input: 1, total: 1 }))], mark, {
      dayOf,
    });
    expect(fold.next).toEqual(mark);
    expect(sum(fold)).toBe(0);
    for (const value of fold.deltas.values()) {
      for (const n of Object.values(value)) expect(n).toBeGreaterThanOrEqual(0);
    }
  });

  it("does not mutate the previous mark and skips an untimed fact without advancing", () => {
    const previous = total(10);
    const fold = foldCumulativeDeltas(
      [cumFact(null, total(99)), cumFact(DAY1, total(40))],
      previous,
      { dayOf },
    );
    expect(previous).toEqual(total(10));
    expect(fold.skipped).toBe(1);
    expect(sum(fold)).toBe(30);
    expect(fold.next).toEqual(total(40));
  });
});

describe("Test 4: the fold carries the six counters and the Codex-reported total", () => {
  it("keeps the reported total even when it is not the sum of the others", () => {
    const reported = counters({
      input: 100,
      cachedInput: 40,
      cacheWrite: 5,
      output: 20,
      reasoningOutput: 7,
      total: 999,
    });
    const fold = foldTurnTokens([turnFact(turnId(1), DAY1, reported)], { dayOf });
    expect([...fold.entries.values()][0]?.counters).toEqual(reported);
    const cumulative = foldCumulativeDeltas([cumFact(DAY1, reported)], null, { dayOf });
    expect(cumulative.next.total).toBe(999);
    expect([...cumulative.deltas.values()][0]).toEqual(reported);
    expect(Object.keys(reported).sort()).toEqual(
      ["cacheWrite", "cachedInput", "input", "output", "reasoningOutput", "total"].sort(),
    );
  });
});
