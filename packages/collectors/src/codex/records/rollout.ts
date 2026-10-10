import type { CodexTokenCounters } from "@ccc/domain";
import { EMPTY_CARRY, type TranscriptCarry } from "../../transcripts/split-lines.js";

// RED stub: signatures only (plan 05.1-08 Task 1). The implementation lands in the green commit.

export const CODEX_INACTIVITY_MS = 30 * 60 * 1000;

export const LIFECYCLE_EVENTS = ["task_started", "task_complete", "turn_aborted"] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

export interface RolloutLimitWindow {
  readonly usedPercent: number;
  readonly windowMinutes: number | null;
  readonly resetsAt: number | null;
}

export interface RolloutRateLimits {
  readonly limitId: string | null;
  readonly limitName: string | null;
  readonly primary: RolloutLimitWindow | null;
  readonly secondary: RolloutLimitWindow | null;
  readonly reachedType: string | null;
}

export type RolloutFact =
  | {
      readonly kind: "meta";
      readonly id: string | null;
      readonly cwd: string | null;
      readonly cliVersion: string | null;
      readonly originator: string | null;
      readonly source: string | null;
      readonly time: string | null;
    }
  | {
      readonly kind: "lifecycle";
      readonly event: LifecycleEvent;
      readonly turnId: string | null;
      readonly time: string | null;
    }
  | {
      readonly kind: "tokens-turn";
      readonly threadId: string | null;
      readonly turnId: string;
      readonly time: string | null;
      readonly counters: CodexTokenCounters | null;
    }
  | {
      readonly kind: "tokens-cumulative";
      readonly time: string | null;
      readonly counters: CodexTokenCounters | null;
    }
  | {
      readonly kind: "rate-limits";
      readonly time: string | null;
      readonly limits: RolloutRateLimits;
    }
  | { readonly kind: "limit-hit"; readonly time: string | null };

export interface RolloutStats {
  readonly lines: number;
  readonly recognized: number;
  readonly oversized: number;
  readonly unrecognized: number;
}

export interface RolloutParseResult {
  readonly facts: readonly RolloutFact[];
  readonly carry: TranscriptCarry;
  readonly bytesConsumed: number;
  readonly stats: RolloutStats;
}

export function parseRolloutChunk(
  _chunk: Uint8Array | string,
  carry: TranscriptCarry = EMPTY_CARRY,
): RolloutParseResult {
  return {
    facts: [],
    carry,
    bytesConsumed: 0,
    stats: { lines: 0, recognized: 0, oversized: 0, unrecognized: 0 },
  };
}

export type LifecycleState = "running" | "completed" | "cancelled" | "stale" | "none";

export interface LifecycleOptions {
  readonly nowMs: number;
  readonly inactivityMs: number;
  readonly lastActivityMs: number;
}

export interface LifecycleDerivation {
  readonly state: LifecycleState;
  readonly display: "running" | "completed" | "cancelled" | "stale" | null;
  readonly lastEvent: LifecycleEvent | null;
  readonly lastEventAt: string | null;
  readonly limitHitAfter: boolean;
}

export function deriveLifecycle(
  _facts: readonly RolloutFact[],
  _options: LifecycleOptions,
): LifecycleDerivation {
  return { state: "none", display: null, lastEvent: null, lastEventAt: null, limitHitAfter: false };
}
