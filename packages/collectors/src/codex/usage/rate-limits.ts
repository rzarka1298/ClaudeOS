import type { CodexUsageSnapshot } from "@ccc/domain";

/** Inputs the caller injects so this module never reads a clock or the environment. */
export interface NormalizeOptions {
  readonly observedAtMs: number;
  readonly nowMs?: number;
  readonly codexVersion?: string | null;
}

// RED stub (plan 05.1-07 task 1): signatures only.
export function normalizeRateLimitsReply(
  _raw: unknown,
  options: NormalizeOptions,
): CodexUsageSnapshot {
  return {
    kind: "unavailable",
    reason: "read-failed",
    version: null,
    observedAt: new Date(options.observedAtMs).toISOString(),
  };
}

export function normalizeRolloutRateLimits(
  _raw: unknown,
  options: NormalizeOptions,
): CodexUsageSnapshot {
  return normalizeRateLimitsReply(_raw, options);
}
