import type { RolloutFact } from "@ccc/collectors";
import type { CodexTokenCounters } from "@ccc/domain";
import { codexBucketStart } from "@ccc/operational-store";

/**
 * The Codex token counting core (plan 05.1-23, redesigned after the Codex
 * re-review 20261010T211420683Z). A PURE function: no I/O, no clock, no store.
 * It takes the WHOLE rollout's token records in file order and the analysis-off
 * intervals, and returns the counted usage per UTC quarter-hour bucket.
 *
 * Chunk independence holds by construction: there is no chunk, no cursor and no
 * persisted per-turn state here. The scanner re-reads a changed rollout in full
 * and replaces the rollout's stored rows with this function's result, so the
 * stored rows of a rollout are a function of its content, the toggle log and
 * nothing else (rows after an incremental append equal rows after a scan from
 * scratch of the final file).
 *
 * Attribution. Every increment belongs to the bucket of the RECORD that produced
 * it (never the scan time, never a later record). Analysis-off increments are
 * excluded per record, by the record's own timestamp, before anything is
 * aggregated into a bucket.
 *
 * The precedence rule between a thread's two token sources:
 *
 * - A thread-cumulative record (`token_count`) is authoritative up to and
 *   including its timestamp. Its usage is the positive per-counter delta against
 *   the running maximum of the cumulative totals (a decrease never lowers it and
 *   is never a new epoch). The latest cumulative timestamp L only moves forward.
 * - A per-turn record (`token_usage_record`) carries a within-turn counter that
 *   is cumulative. Its increment is the growth of that counter past its running
 *   maximum. An increment from a record at or before L is covered by the
 *   cumulative records and dropped; an increment after L counts in its own bucket
 *   (a turn first seen after L counts in full).
 * - When L advances to a new cumulative record, every turn of the thread whose
 *   latest record is not after it is cut: its pending (counted-so-far) per-turn
 *   increments are superseded by the cumulative delta and dropped, UNLESS that
 *   cumulative record was itself recorded while analysis was off. Its delta is
 *   then not counted, so the turn keeps the enabled usage it had seen, in the
 *   buckets where it happened (a superseded turn keeps its enabled usage).
 * - Off-period increments are excluded whichever source reports them. A
 *   per-turn increment recorded while analysis was off is never counted; the
 *   cumulative total that later covers it contains it, so it is held as pending
 *   "cover" and subtracted from the counted increments of enabled cumulative
 *   records until it is consumed.
 *
 * Timestamps in one rollout are taken to be non-decreasing in file order (the
 * file is append-only).
 */

/** A half-open interval [startMs, endMs) during which analysis was off. */
export interface OffInterval {
  readonly startMs: number;
  readonly endMs: number;
}

export interface RolloutTokenUsage {
  /** Counted usage by UTC quarter-hour bucket start (ISO text). Never holds an all-zero bucket. */
  readonly buckets: ReadonlyMap<string, CodexTokenCounters>;
  /** The thread ids the per-turn records named (the caller adds the file's own thread). */
  readonly threads: ReadonlySet<string>;
  /** Token records that could not be attributed (no time, no thread, unparseable time). */
  readonly skipped: number;
}

const KEYS = [
  "input",
  "cachedInput",
  "cacheWrite",
  "output",
  "reasoningOutput",
  "total",
] as const satisfies readonly (keyof CodexTokenCounters)[];

type Mutable = { -readonly [K in keyof CodexTokenCounters]: number };

function zero(): Mutable {
  return { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoningOutput: 0, total: 0 };
}

function isZero(counters: CodexTokenCounters): boolean {
  return KEYS.every((key) => counters[key] === 0);
}

function addInto(target: Mutable, source: CodexTokenCounters): void {
  for (const key of KEYS) target[key] += source[key];
}

function addToBucket(map: Map<string, Mutable>, bucket: string, source: CodexTokenCounters): void {
  if (isZero(source)) return;
  let known = map.get(bucket);
  if (known === undefined) {
    known = zero();
    map.set(bucket, known);
  }
  addInto(known, source);
}

interface TurnState {
  /** The highest within-turn counters seen, counted or not. */
  readonly hw: Mutable;
  /** The latest record time, in ms. */
  latestMs: number;
  /** Enabled increments since the turn was last cut, by their own bucket. */
  live: Map<string, Mutable>;
  /** Off-period increments since the turn was last cut. */
  offWindow: Mutable;
  /** Enabled increments an analysis-off cumulative record superseded: kept for good. */
  readonly kept: Map<string, Mutable>;
}

export function tokensForRollout(
  records: readonly RolloutFact[],
  offIntervals: readonly OffInterval[],
  fileThreadId: string | null,
): RolloutTokenUsage {
  const isOff = (ms: number): boolean =>
    offIntervals.some((interval) => ms >= interval.startMs && ms < interval.endMs);

  const out = new Map<string, Mutable>();
  const threads = new Set<string>();
  const turns = new Map<string, TurnState>();
  const mark = zero();
  /** Off-period usage already known to be inside the cumulative total, not yet subtracted. */
  const pool = zero();
  let lastCumulativeMs: number | null = null;
  let skipped = 0;

  for (const fact of records) {
    if (fact.kind === "tokens-turn") {
      const threadId = fact.threadId ?? fileThreadId;
      const tMs = fact.time === null ? Number.NaN : Date.parse(fact.time);
      const bucket = fact.time === null ? null : codexBucketStart(fact.time);
      if (fact.counters === null || threadId === null || Number.isNaN(tMs) || bucket === null) {
        skipped += 1;
        continue;
      }
      threads.add(threadId);
      const key = `${threadId}\u0000${fact.turnId}`;
      let turn = turns.get(key);
      if (turn === undefined) {
        turn = {
          hw: zero(),
          latestMs: tMs,
          live: new Map(),
          offWindow: zero(),
          kept: new Map(),
        };
        turns.set(key, turn);
      }
      const increment = zero();
      for (const name of KEYS) {
        increment[name] = Math.max(0, fact.counters[name] - turn.hw[name]);
        turn.hw[name] = Math.max(turn.hw[name], fact.counters[name]);
      }
      turn.latestMs = Math.max(turn.latestMs, tMs);
      const covered =
        threadId === fileThreadId && lastCumulativeMs !== null && tMs <= lastCumulativeMs;
      if (covered) continue;
      if (isOff(tMs)) addInto(turn.offWindow, increment);
      else addToBucket(turn.live, bucket, increment);
      continue;
    }

    if (fact.kind !== "tokens-cumulative") continue;
    if (fileThreadId === null || fact.counters === null) continue;
    if (fact.time === null) {
      skipped += 1;
      continue;
    }
    const tcMs = Date.parse(fact.time);
    const bucket = codexBucketStart(fact.time);
    const cumulativeOff = !Number.isNaN(tcMs) && isOff(tcMs);

    // The cut: this record is authoritative for everything up to its timestamp.
    if (!Number.isNaN(tcMs) && (lastCumulativeMs === null || tcMs > lastCumulativeMs)) {
      for (const [key, turn] of turns) {
        if (!key.startsWith(`${fileThreadId}\u0000`) || turn.latestMs > tcMs) continue;
        if (cumulativeOff) {
          // Its own delta is not counted, so the turn keeps what it saw while enabled.
          for (const [liveBucket, live] of turn.live) addToBucket(turn.kept, liveBucket, live);
        } else {
          addInto(pool, turn.offWindow);
        }
        turn.live = new Map();
        turn.offWindow = zero();
      }
      lastCumulativeMs = tcMs;
    }

    const delta = zero();
    for (const name of KEYS) {
      delta[name] = Math.max(0, fact.counters[name] - mark[name]);
      mark[name] = Math.max(mark[name], fact.counters[name]);
    }
    if (isZero(delta)) continue;
    if (bucket === null) {
      skipped += 1;
      continue;
    }
    if (cumulativeOff) continue;
    for (const name of KEYS) {
      const covered = Math.min(pool[name], delta[name]);
      pool[name] -= covered;
      delta[name] -= covered;
    }
    addToBucket(out, bucket, delta);
  }

  for (const turn of turns.values()) {
    for (const [bucket, usage] of turn.live) addToBucket(out, bucket, usage);
    for (const [bucket, usage] of turn.kept) addToBucket(out, bucket, usage);
  }
  return { buckets: out, threads, skipped };
}
