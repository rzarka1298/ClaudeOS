import type { CodexTokenCounters } from "@ccc/domain";
import type { RolloutFact } from "./rollout.js";

/**
 * Token fold and dedup (CODEX-10, D-24, RESEARCH Pitfall 12). Pure: the
 * caller supplies a `dayOf` (the timezone, or any bucket, is the caller's
 * concern) and nothing here reads a clock or persists anything.
 *
 * PLANNER ASSUMPTION (open owner item, R-OPEN 2): the dedup unit. The
 * CODEX-10 text names the cumulative `token_count` record; the research
 * recommendation, taken here, keys on THREAD and TURN from the per-turn
 * `token_usage_record` (which carries a turn id and a cumulative-within-turn
 * value) and keeps the LATEST value per key, never a sum. Rollouts and
 * versions that carry only the cumulative `token_count` (no turn id) fall
 * back to non-negative per-counter deltas against a durable high-water mark.
 * If the owner prefers the cumulative record as the unit, only the caller's
 * choice of which fold to run changes.
 */

/** Maps an ISO fact time to a bucket key (a day, or a quarter hour); the caller picks the policy. */
export type DayOf = (isoTime: string) => string;

export interface TurnTokenEntry {
  readonly threadId: string;
  readonly turnId: string;
  /** The bucket of the FIRST fact of this turn that carried a time. */
  readonly day: string;
  /** The LATEST cumulative-within-turn counters (never a sum). */
  readonly counters: CodexTokenCounters;
  /** The time of the latest timed fact for this turn. */
  readonly at: string;
}

export interface TurnTokenFold {
  readonly entries: ReadonlyMap<string, TurnTokenEntry>;
  /** Facts that could not be used: no recognisable counters, no thread id, or no time. */
  readonly skipped: number;
}

/** The map key of a turn; ids never contain a newline, so the key is unambiguous. */
export function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\n${turnId}`;
}

interface Pending {
  threadId: string;
  turnId: string;
  day: string | null;
  counters: CodexTokenCounters;
  at: string | null;
}

/**
 * Folds per-turn usage facts: one entry per thread and turn, holding the
 * LATEST counters in fact order and the bucket of the first timed fact.
 * Cumulative within a turn means latest wins; summing would count the same
 * tokens many times. Repeated identical facts change nothing. `fallbackThreadId`
 * is used when a fact carries no thread id (the thread id from the file name).
 */
export function foldTurnTokens(
  facts: readonly RolloutFact[],
  options: { readonly dayOf: DayOf; readonly fallbackThreadId?: string },
): TurnTokenFold {
  const pending = new Map<string, Pending>();
  let skipped = 0;
  for (const fact of facts) {
    if (fact.kind !== "tokens-turn") continue;
    const threadId = fact.threadId ?? options.fallbackThreadId ?? null;
    if (fact.counters === null || threadId === null) {
      skipped += 1;
      continue;
    }
    const key = turnKey(threadId, fact.turnId);
    let entry = pending.get(key);
    if (entry === undefined) {
      entry = { threadId, turnId: fact.turnId, day: null, counters: fact.counters, at: null };
      pending.set(key, entry);
    }
    entry.counters = fact.counters;
    if (fact.time !== null) {
      entry.day ??= options.dayOf(fact.time);
      entry.at = fact.time;
    }
  }
  const entries = new Map<string, TurnTokenEntry>();
  for (const [key, entry] of pending) {
    if (entry.day === null || entry.at === null) {
      skipped += 1;
      continue;
    }
    entries.set(key, {
      threadId: entry.threadId,
      turnId: entry.turnId,
      day: entry.day,
      counters: entry.counters,
      at: entry.at,
    });
  }
  return { entries, skipped };
}

const COUNTER_NAMES = [
  "input",
  "cachedInput",
  "cacheWrite",
  "output",
  "reasoningOutput",
  "total",
] as const satisfies readonly (keyof CodexTokenCounters)[];

const ZERO_COUNTERS: CodexTokenCounters = {
  input: 0,
  cachedInput: 0,
  cacheWrite: 0,
  output: 0,
  reasoningOutput: 0,
  total: 0,
};

export interface CumulativeFold {
  /** Non-negative deltas per bucket (only buckets that gained something). */
  readonly deltas: ReadonlyMap<string, CodexTokenCounters>;
  /** The next per-counter high-water mark; never lower than the one passed in. */
  readonly next: CodexTokenCounters;
  /** Cumulative facts with a value but no time (they cannot be bucketed and do not advance the mark). */
  readonly skipped: number;
}

/**
 * Folds the cumulative `token_count` facts of one thread's rollout against
 * its durable high-water mark (zero when `previous` is null). For each of the
 * six counters INDEPENDENTLY: delta = max(0, incoming - mark) and
 * next = max(mark, incoming). A decrease never re-baselines downward, a
 * replayed prefix emits nothing until usage passes the mark, and `info: null`
 * (null counters) changes nothing. A lower total is never read as a new
 * counting epoch. The caller persists `next` atomically with the deltas and
 * its cursor. An untimed fact is skipped WITHOUT advancing the mark, so its
 * tokens are carried by the next timed fact instead of being lost.
 */
export function foldCumulativeDeltas(
  facts: readonly RolloutFact[],
  previous: CodexTokenCounters | null,
  options: { readonly dayOf: DayOf },
): CumulativeFold {
  const mark: Record<keyof CodexTokenCounters, number> = { ...(previous ?? ZERO_COUNTERS) };
  const deltas = new Map<string, Record<keyof CodexTokenCounters, number>>();
  let skipped = 0;
  for (const fact of facts) {
    if (fact.kind !== "tokens-cumulative" || fact.counters === null) continue;
    if (fact.time === null) {
      skipped += 1;
      continue;
    }
    const bucket = options.dayOf(fact.time);
    for (const name of COUNTER_NAMES) {
      const incoming = fact.counters[name];
      const delta = Math.max(0, incoming - mark[name]);
      mark[name] = Math.max(mark[name], incoming);
      if (delta === 0) continue;
      let sums = deltas.get(bucket);
      if (sums === undefined) {
        sums = { ...ZERO_COUNTERS };
        deltas.set(bucket, sums);
      }
      sums[name] += delta;
    }
  }
  return { deltas, next: { ...mark }, skipped };
}
