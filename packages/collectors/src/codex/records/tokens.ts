// RED stub: signatures only (plan 05.1-08 Task 3). The implementation lands in the green commit.
import type { CodexTokenCounters } from "@ccc/domain";
import type { RolloutFact } from "./rollout.js";

export type DayOf = (isoTime: string) => string;

export interface TurnTokenEntry {
  readonly threadId: string;
  readonly turnId: string;
  readonly day: string;
  readonly counters: CodexTokenCounters;
  readonly at: string;
}

export interface TurnTokenFold {
  readonly entries: ReadonlyMap<string, TurnTokenEntry>;
  readonly skipped: number;
}

export function turnKey(_threadId: string, _turnId: string): string {
  return "";
}

export function foldTurnTokens(
  _facts: readonly RolloutFact[],
  _options: { readonly dayOf: DayOf; readonly fallbackThreadId?: string },
): TurnTokenFold {
  return { entries: new Map(), skipped: 0 };
}

export interface CumulativeFold {
  readonly deltas: ReadonlyMap<string, CodexTokenCounters>;
  readonly next: CodexTokenCounters;
  readonly skipped: number;
}

export function foldCumulativeDeltas(
  _facts: readonly RolloutFact[],
  _previous: CodexTokenCounters | null,
  _options: { readonly dayOf: DayOf },
): CumulativeFold {
  return {
    deltas: new Map(),
    next: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoningOutput: 0, total: 0 },
    skipped: 0,
  };
}
