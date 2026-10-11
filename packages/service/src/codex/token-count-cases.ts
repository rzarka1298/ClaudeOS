import type { RolloutFact } from "@ccc/collectors";
import type { CodexTokenCounters } from "@ccc/domain";

/**
 * The counting table of token-count.test.ts, shared with the version guard
 * (token-count-version.guard.test.ts) so both read the same inputs.
 */

export const THREAD = "thread-aaaa1111";
export const t = (hh: number, mm: number, ss = 0): string =>
  `2026-10-10T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.000Z`;
export const ms = (iso: string): number => Date.parse(iso);

export const counters = (input: number): CodexTokenCounters => ({
  input,
  cachedInput: 0,
  cacheWrite: 0,
  output: 0,
  reasoningOutput: 0,
  total: input,
});

export const cum = (time: string, input: number): RolloutFact => ({
  kind: "tokens-cumulative",
  time,
  counters: counters(input),
});
export const pt = (
  n: number,
  time: string,
  input: number,
  threadId: string | null = null,
): RolloutFact => ({
  kind: "tokens-turn",
  threadId,
  turnId: `turn-${n}`,
  time,
  counters: counters(input),
});

export interface Case {
  readonly name: string;
  readonly records: readonly RolloutFact[];
  readonly expected: number;
  readonly buckets?: Readonly<Record<string, number>>;
  readonly off?: ReadonlyArray<readonly [string, string]>;
}

export const CASES: readonly Case[] = [
  {
    name: "100 cumulative + 10 per-turn after it => 110, in one bucket",
    records: [cum(t(10, 1), 100), pt(1, t(10, 2), 10)],
    expected: 110,
    buckets: { "2026-10-10T10:00:00.000Z": 110 },
  },
  {
    name: "cumulative 100 @10:21 then a new turn's per-turn 100 @10:30 => 200 (each in its own bucket)",
    records: [cum(t(10, 21), 100), pt(1, t(10, 30), 100)],
    expected: 200,
    buckets: { "2026-10-10T10:15:00.000Z": 100, "2026-10-10T10:30:00.000Z": 100 },
  },
  {
    name: "per-turn 100 at the very instant of the last cumulative 100 => 100",
    records: [cum(t(10, 21), 100), pt(1, t(10, 21), 100)],
    expected: 100,
  },
  {
    name: "a growing per-turn counter 100 -> 150 (no cumulative) => 150",
    records: [pt(1, t(10, 1), 100), pt(1, t(10, 2), 150)],
    expected: 150,
  },
  {
    name: "a turn that began before the cut counts only its growth beyond the cut value => 150",
    records: [pt(1, t(10, 1), 100), cum(t(10, 1), 100), pt(1, t(10, 2), 150)],
    expected: 150,
  },
  {
    name: "Codex repro 1: cum 100 @:01, per-turn 100 @:02, cum 100 @:02 => 100 (not 200)",
    records: [cum(t(10, 1), 100), pt(1, t(10, 2), 100), cum(t(10, 2), 100)],
    expected: 100,
  },
  {
    name: "Codex repro 2: cum 100 @:01, growing per-turn 150 @:02 with cum 150 => 150 (not 250)",
    records: [cum(t(10, 1), 100), pt(1, t(10, 2), 150), cum(t(10, 2), 150)],
    expected: 150,
  },
  {
    name: "repro 2 with the cumulative record first in file order => 150",
    records: [cum(t(10, 1), 100), cum(t(10, 2), 150), pt(1, t(10, 2), 150)],
    expected: 150,
  },
  {
    name: "per-turn superseded by a later cumulative that covers it, then new growth => 160",
    records: [cum(t(10, 1), 100), pt(1, t(10, 2), 40), cum(t(10, 3), 140), pt(1, t(10, 4), 60)],
    expected: 160,
  },
  {
    name: "two off intervals: stale cover is consumed by an off cumulative delta => 150",
    records: [
      cum(t(10, 1), 100),
      pt(1, t(10, 2), 150),
      cum(t(10, 4), 150),
      cum(t(10, 5), 250),
      cum(t(10, 17), 300),
    ],
    off: [
      [t(10, 2), t(10, 3)],
      [t(10, 5), t(10, 6)],
    ],
    expected: 150,
  },
  {
    name: "off cumulative delta larger than the cover consumes it all, later usage counts => 150",
    records: [
      cum(t(10, 1), 100),
      pt(1, t(10, 2), 150),
      cum(t(10, 4), 150),
      cum(t(10, 5), 400),
      cum(t(10, 17), 450),
    ],
    off: [
      [t(10, 2), t(10, 3)],
      [t(10, 5), t(10, 6)],
    ],
    expected: 150,
  },
  {
    name: "off cumulative delta smaller than the cover leaves the rest to cover later usage => 100",
    records: [
      cum(t(10, 1), 100),
      pt(1, t(10, 2), 150),
      cum(t(10, 4), 100),
      cum(t(10, 5), 120),
      cum(t(10, 17), 170),
    ],
    off: [
      [t(10, 2), t(10, 3)],
      [t(10, 5), t(10, 6)],
    ],
    expected: 100,
  },
  {
    name: "analysis-off increment is never counted: 100 / 200 (off) / 300 => 200",
    records: [pt(1, t(10, 0, 50), 100), pt(1, t(10, 2, 30), 200), pt(1, t(10, 4, 10), 300)],
    off: [[t(10, 2), t(10, 3)]],
    expected: 200,
  },
  {
    name: "analysis-off cumulative increment is never counted: 100 / 200 (off) / 300 => 200",
    records: [cum(t(10, 0, 50), 100), cum(t(10, 2, 30), 200), cum(t(10, 4, 10), 300)],
    off: [[t(10, 2), t(10, 3)]],
    expected: 200,
  },
  {
    name: "off cumulative record defines the cut: per-turn 100 (on), cum 200 (off), cum 300 (on) => 200",
    records: [pt(1, t(10, 0, 50), 100), cum(t(10, 2, 30), 200), cum(t(10, 4, 10), 300)],
    off: [[t(10, 2), t(10, 3)]],
    expected: 200,
  },
  {
    name: "off per-turn increment under an on cumulative: per-turn 100 (on), 200 (off), cum 300 (on) => 200",
    records: [pt(1, t(10, 0, 50), 100), pt(1, t(10, 2, 30), 200), cum(t(10, 4, 10), 300)],
    off: [[t(10, 2), t(10, 3)]],
    expected: 200,
  },
  {
    name: "off per-turn growth inside a cumulative-only thread: cum 100 (on), per-turn 150 (off), cum 250 (on) => 100",
    records: [cum(t(10, 0, 50), 100), pt(1, t(10, 2, 30), 150), cum(t(10, 4, 10), 250)],
    off: [[t(10, 2), t(10, 3)]],
    expected: 100,
  },
  {
    name: "off cumulative then a new on turn: cum 100 (on), cum 200 (off), new per-turn 50 (on) => 150",
    records: [cum(t(10, 0, 50), 100), cum(t(10, 2, 30), 200), pt(1, t(10, 4, 0), 50)],
    off: [[t(10, 2), t(10, 3)]],
    expected: 150,
  },
  {
    name: "off spanning the transition: per-turn 100 (on), 200 (off), cum 200 (off), per-turn 250 (on) => 150",
    records: [
      pt(1, t(10, 0, 50), 100),
      pt(1, t(10, 2, 30), 200),
      cum(t(10, 2, 45), 200),
      pt(1, t(10, 4, 10), 250),
    ],
    off: [[t(10, 2), t(10, 3)]],
    expected: 150,
  },
  {
    name: "partly off turn under an on cumulative: per-turn 100 (on), 160 (off), cum 200 (on) => 140",
    records: [pt(1, t(10, 0, 50), 100), pt(1, t(10, 2, 30), 160), cum(t(10, 4, 10), 200)],
    off: [[t(10, 2), t(10, 3)]],
    expected: 140,
  },
  {
    name: "a historical cumulative-only thread that later gets per-turn records: 100 + 10 => 110",
    records: [cum(t(8, 0), 100), pt(1, t(10, 0, 30), 10)],
    expected: 110,
  },
  {
    name: "two turns across a cut: the old one superseded, the new one in full => 150",
    records: [
      pt(1, t(10, 1), 50),
      pt(2, t(10, 1, 30), 30),
      cum(t(10, 2), 80),
      pt(2, t(10, 3), 80),
      pt(3, t(10, 4), 20),
    ],
    expected: 150,
  },
  // --- The three Codex re-review reproductions ------------------------------------------
  {
    name: "Codex finding 1: cum 100 (on), per-turn 150 (off), cum 150 and 250 (on), one bucket => 100, whatever the chunking",
    records: [cum(t(10, 1), 100), pt(1, t(10, 2, 30), 150), cum(t(10, 4), 150), cum(t(10, 5), 250)],
    off: [[t(10, 2), t(10, 3)]],
    expected: 100,
    buckets: { "2026-10-10T10:00:00.000Z": 100 },
  },
  {
    name: "Codex finding 2: turn 100 yesterday kept through an off cumulative, 150 today => yesterday 100, today 50",
    records: [
      pt(1, "2026-10-09T23:50:00.000Z", 100),
      cum("2026-10-10T00:07:00.000Z", 100),
      pt(1, "2026-10-10T00:20:00.000Z", 150),
    ],
    off: [["2026-10-10T00:05:00.000Z", "2026-10-10T00:10:00.000Z"]],
    expected: 150,
    buckets: { "2026-10-09T23:45:00.000Z": 100, "2026-10-10T00:15:00.000Z": 50 },
  },
  // --- Per-record attribution -----------------------------------------------------------
  {
    name: "a turn's growth is attributed to the bucket of the record that grew it",
    records: [pt(1, t(10, 1), 40), pt(1, t(10, 20), 100), pt(1, t(11, 5), 130)],
    expected: 130,
    buckets: {
      "2026-10-10T10:00:00.000Z": 40,
      "2026-10-10T10:15:00.000Z": 60,
      "2026-10-10T11:00:00.000Z": 30,
    },
  },
  {
    name: "a superseded turn leaves nothing in its old buckets; the cumulative delta lands in its own bucket",
    records: [pt(1, t(10, 1), 40), cum(t(10, 20), 100)],
    expected: 100,
    buckets: { "2026-10-10T10:15:00.000Z": 100 },
  },
  {
    name: "off per-turn growth is excluded in its own bucket, enabled growth around it stays",
    records: [pt(1, t(10, 1), 40), pt(1, t(10, 20), 100), pt(1, t(10, 40), 130)],
    off: [[t(10, 15), t(10, 30)]],
    expected: 70,
    buckets: { "2026-10-10T10:00:00.000Z": 40, "2026-10-10T10:30:00.000Z": 30 },
  },
  {
    name: "per-counter independence: a decreasing counter never lowers the mark",
    records: [cum(t(10, 1), 100), cum(t(10, 2), 60), cum(t(10, 3), 120)],
    expected: 120,
  },
  {
    name: "a replayed identical cumulative record adds nothing",
    records: [cum(t(10, 1), 100), cum(t(10, 1), 100), cum(t(10, 2), 100)],
    expected: 100,
  },
  {
    name: "a record at an earlier time than the last cumulative is covered, not counted",
    records: [cum(t(10, 5), 100), pt(1, t(10, 4), 30)],
    expected: 100,
  },
];
