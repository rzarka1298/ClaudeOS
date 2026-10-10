import type { CodexUsageSnapshot } from "@ccc/domain";
import type { CodexHomePort } from "./codex-home.js";

/** Signature stub (plan 05.1-33, RED): replaced by the implementation in the GREEN commit. */
export const ROLLOUT_RATE_LIMITS_CACHE_MS = 0;

export interface RolloutRateLimitsReader {
  read(): CodexUsageSnapshot | null;
}

export interface RolloutRateLimitsDeps {
  readonly port: Pick<CodexHomePort, "listRolloutFiles" | "statRollout" | "readRolloutRange">;
  readonly now: () => number;
  readonly logger?: { warn(fields: { readonly reason: string }, message: string): void };
  readonly cacheMs?: number;
}

export function createRolloutRateLimitsReader(
  _deps: RolloutRateLimitsDeps,
): RolloutRateLimitsReader {
  return { read: () => null };
}
