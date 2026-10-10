import type { CodexUsageSnapshot } from "@ccc/domain";
import type { RolloutFact, RolloutRateLimits } from "./rollout.js";

/** Signature stub (plan 05.1-33, RED): replaced by the implementation in the GREEN commit. */
export const ROLLOUT_FALLBACK_WINDOW_MS = 0;

export interface NewestRolloutRateLimits {
  readonly limits: RolloutRateLimits;
  readonly time: string;
  readonly observedAtMs: number;
}

export function newestRolloutRateLimits(
  _facts: readonly RolloutFact[],
  _options: { readonly nowMs: number },
): NewestRolloutRateLimits | null {
  return null;
}

export function rolloutFallbackSnapshot(
  _newest: NewestRolloutRateLimits | null,
  _nowMs: number,
): CodexUsageSnapshot | null {
  return null;
}
