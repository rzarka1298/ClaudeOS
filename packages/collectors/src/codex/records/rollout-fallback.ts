import type { CodexUsageSnapshot } from "@ccc/domain";
import { normalizeRolloutRateLimits } from "../usage/rate-limits.js";
import type { RolloutFact, RolloutLimitWindow, RolloutRateLimits } from "./rollout.js";

/**
 * The pure half of the rollout rate-limit fallback (plan 05.1-33, OQ-3, owner
 * decision 2026-10-10, CODEX-08, CODEX-09).
 *
 * When the live `account/rateLimits/read` is unavailable, the plan-usage bar
 * may show the newest `rate_limits` figure Codex wrote into a rollout. That
 * figure is DISPLAY ONLY: it is built through the existing rollout
 * normaliser, so its source is `rollout-fallback` and the guard never allows
 * from it. Nothing here reads a clock, a file or the environment: the caller
 * injects "now" and the already-parsed facts.
 *
 * The parsed fact is already an allowlist (plan type, credits, spend control
 * and every unknown key were dropped by the rollout parser); the normaliser
 * then keeps only percent, window minutes, reset time and a validated limit
 * label, and validates the result against the strict domain schema.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rollout figures older than this are not looked at (the session window of D-15's neighbours). */
export const ROLLOUT_FALLBACK_WINDOW_MS = 31 * DAY_MS;

/**
 * A figure stamped slightly in the future (clock adjustment between the write
 * and now) still counts; one stamped further ahead cannot be aged honestly and
 * is ignored.
 */
const CLOCK_SKEW_TOLERANCE_MS = 5_000;

export interface NewestRolloutRateLimits {
  readonly limits: RolloutRateLimits;
  /** The record's own timestamp, exactly as parsed. */
  readonly time: string;
  readonly observedAtMs: number;
}

/**
 * The newest rate-limits fact by the record's own timestamp (a later fact in
 * file order wins a tie). Facts without a parseable time, older than the
 * window or stamped beyond the skew tolerance are ignored. Null when none.
 */
export function newestRolloutRateLimits(
  facts: readonly RolloutFact[],
  options: { readonly nowMs: number },
): NewestRolloutRateLimits | null {
  const minMs = options.nowMs - ROLLOUT_FALLBACK_WINDOW_MS;
  const maxMs = options.nowMs + CLOCK_SKEW_TOLERANCE_MS;
  let best: NewestRolloutRateLimits | null = null;
  for (const fact of facts) {
    if (fact.kind !== "rate-limits" || fact.time === null) continue;
    const observedAtMs = Date.parse(fact.time);
    if (!Number.isFinite(observedAtMs) || observedAtMs < minMs || observedAtMs > maxMs) continue;
    if (best === null || observedAtMs >= best.observedAtMs) {
      best = { limits: fact.limits, time: fact.time, observedAtMs };
    }
  }
  return best;
}

function rawWindow(window: RolloutLimitWindow | null): Record<string, unknown> | null {
  return window === null
    ? null
    : {
        used_percent: window.usedPercent,
        window_minutes: window.windowMinutes,
        resets_at: window.resetsAt,
      };
}

/**
 * The display-only snapshot for a figure found by {@link newestRolloutRateLimits}:
 * source `rollout-fallback`, observed at the record's own time, ordinary usage
 * null (a rollout never says). Null when there is no figure or it cannot be
 * normalised; never an invented number.
 */
export function rolloutFallbackSnapshot(
  newest: NewestRolloutRateLimits | null,
  nowMs: number,
): CodexUsageSnapshot | null {
  if (newest === null) return null;
  const snapshot = normalizeRolloutRateLimits(
    {
      limit_id: newest.limits.limitId,
      rate_limit_reached_type: newest.limits.reachedType,
      primary: rawWindow(newest.limits.primary),
      secondary: rawWindow(newest.limits.secondary),
    },
    { observedAtMs: newest.observedAtMs, nowMs },
  );
  return snapshot.kind === "available" ? snapshot : null;
}
