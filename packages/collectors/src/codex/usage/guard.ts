import {
  CODEX_RESERVE_PERCENT,
  CODEX_USAGE_LIVE_MAX_AGE_MS,
  CODEX_USAGE_STALE_MAX_AGE_MS,
  type CodexHeadroom,
  type CodexHeadroomReason,
  CodexHeadroomSchema,
  type CodexUsageSnapshot,
  type CodexUsageWindow,
  type Freshness,
} from "@ccc/domain";

/**
 * The Codex usage guard and the read-only headroom signal (plan 05.1-07,
 * D-22, D-23, CODEX-11, CODEX-12). Pure: the clock and the paused-run count
 * are inputs. The semantics mirror `scripts/codex/codex.mjs` (the wrapper the
 * agents use); the black-box parity test in `@ccc/test-fixtures` proves it.
 */

/** The wrapper's exit codes. */
export const GUARD_EXIT = {
  OK: 0,
  RESERVE: 10,
  NOT_ALLOWED: 11,
  UNAVAILABLE: 12,
  PENDING_RESUME: 13,
} as const;
export type GuardExitCode = (typeof GUARD_EXIT)[keyof typeof GUARD_EXIT];
export type GuardStatus = "ok" | "low" | "exhausted" | "unavailable";

export interface GuardInput {
  readonly snapshot: CodexUsageSnapshot | null;
  readonly nowMs: number;
  readonly pausedRunCount?: number;
}

export interface GuardVerdict {
  readonly allowed: boolean;
  readonly exitCode: GuardExitCode;
  readonly status: GuardStatus;
  readonly reason: CodexHeadroomReason | null;
  readonly freshness: Freshness;
  readonly usedPercent: number | null;
  readonly resetsAt: string | null;
  /** The wrapper's `allowed`: the boolean member, forced false by a reached type, else null. */
  readonly ordinaryUsageAllowed: boolean | null;
}

export interface HeadroomInput {
  readonly snapshot: CodexUsageSnapshot | null;
  readonly nowMs: number;
  readonly pausedRuns?: { readonly count: number; readonly earliestResetAt: string | null };
}

/**
 * A read stamped slightly in the future (clock adjustment between the read and
 * now) still counts as live; one stamped further ahead is not trusted.
 */
const CLOCK_SKEW_TOLERANCE_MS = 5_000;

/**
 * Live up to the live max age, stale up to the stale max age, unavailable
 * beyond (Assumption A11 as interpreted: "older than 2 minutes refuses with
 * numbers kept for display, older than 10 minutes becomes unavailable too-old").
 */
export function ageFreshness(observedAtMs: number, nowMs: number): Freshness {
  const age = nowMs - observedAtMs;
  if (!Number.isFinite(age) || age < -CLOCK_SKEW_TOLERANCE_MS) return "unavailable";
  if (age <= CODEX_USAGE_LIVE_MAX_AGE_MS) return "live";
  if (age <= CODEX_USAGE_STALE_MAX_AGE_MS) return "stale";
  return "unavailable";
}

function worstOf(windows: readonly CodexUsageWindow[]): CodexUsageWindow | null {
  let worst: CodexUsageWindow | null = null;
  for (const window of windows) {
    if (worst === null || window.usedPercent > worst.usedPercent) worst = window;
  }
  return worst;
}

/** A usable paused-run count: a finite number of at least one, else zero. */
function pausedCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 0;
}

/**
 * Re-stamps freshness from the snapshot's age. Past the stale max age the
 * snapshot becomes an unavailable `too-old` one, so no number survives.
 */
function applyMaxAge(
  snapshot: CodexUsageSnapshot | null,
  nowMs: number,
): CodexUsageSnapshot | null {
  if (snapshot === null || snapshot.kind === "unavailable") return snapshot;
  const freshness = ageFreshness(Date.parse(snapshot.observedAt), nowMs);
  if (freshness === "unavailable") {
    return {
      kind: "unavailable",
      reason: "too-old",
      version: snapshot.codexVersion ?? null,
      observedAt: snapshot.observedAt,
    };
  }
  return { ...snapshot, freshness };
}

interface Evaluation {
  readonly verdict: GuardVerdict;
  /** The snapshot after the max-age rule; null when nothing was ever read. */
  readonly effective: CodexUsageSnapshot | null;
  readonly paused: number;
}

function evaluate(input: GuardInput): Evaluation {
  const effective = applyMaxAge(input.snapshot, input.nowMs);
  const paused = pausedCount(input.pausedRunCount);
  if (effective === null || effective.kind === "unavailable") {
    return {
      effective,
      paused,
      verdict: {
        allowed: false,
        exitCode: GUARD_EXIT.UNAVAILABLE,
        status: "unavailable",
        reason: paused > 0 ? "paused-run" : "usage-unavailable",
        freshness: "unavailable",
        usedPercent: null,
        resetsAt: null,
        ordinaryUsageAllowed: null,
      },
    };
  }
  const worst = worstOf(effective.windows);
  const usedPercent = worst === null ? 0 : worst.usedPercent;
  const atReserve = usedPercent >= CODEX_RESERVE_PERCENT;
  // The wrapper forces "not allowed" when any limit snapshot carries a reached type.
  const ordinary =
    effective.ordinaryUsageAllowed === true && effective.rateLimitReached
      ? false
      : effective.ordinaryUsageAllowed;
  const fallbackOnly = effective.source === "rollout-fallback";
  // Never gate on a read that is not a trustworthy live one (OQ-3, D-24, T-05.1-27).
  const untrusted = fallbackOnly || effective.freshness === "stale" || ordinary === null;
  let status: GuardStatus = "ok";
  if (untrusted) status = "unavailable";
  else if (ordinary === false || usedPercent >= 100) status = "exhausted";
  else if (atReserve) status = "low";
  let exitCode: GuardExitCode = GUARD_EXIT.OK;
  if (untrusted) exitCode = GUARD_EXIT.UNAVAILABLE;
  else if (ordinary === false) exitCode = GUARD_EXIT.NOT_ALLOWED;
  else if (atReserve) exitCode = GUARD_EXIT.RESERVE;
  else if (paused > 0) exitCode = GUARD_EXIT.PENDING_RESUME;
  // The reason is the first row of the UI-SPEC table that holds, whatever the exit code.
  let reason: CodexHeadroomReason | null = null;
  if (atReserve || effective.rateLimitReached) reason = "reserve-line";
  else if (effective.ordinaryUsageAllowed === false) reason = "usage-not-allowed";
  else if (paused > 0) reason = "paused-run";
  else if (fallbackOnly) reason = "no-live-read";
  else if (untrusted) reason = "usage-unavailable";
  return {
    effective,
    paused,
    verdict: {
      allowed: exitCode === GUARD_EXIT.OK,
      exitCode,
      status,
      reason,
      freshness: effective.freshness,
      usedPercent,
      resetsAt: worst?.resetsAt ?? null,
      ordinaryUsageAllowed: ordinary,
    },
  };
}

/**
 * The guard verdict. It allows only a live, app-server, fully-numeric read that
 * is under the reserve line, says ordinary usage is allowed, and has no paused
 * run waiting. Every other state refuses and says why.
 */
export function evaluateGuard(input: GuardInput): GuardVerdict {
  return evaluate(input).verdict;
}

/** The read-only Codex headroom member (CODEX-11, D-23): a statement, never an instruction. */
export function buildCodexHeadroom(input: HeadroomInput): CodexHeadroom {
  const { verdict, effective, paused } = evaluate({
    snapshot: input.snapshot,
    nowMs: input.nowMs,
    pausedRunCount: input.pausedRuns?.count ?? 0,
  });
  const worst = effective?.kind === "available" ? worstOf(effective.windows) : null;
  const build = (earliestResetAt: string | null): CodexHeadroom => ({
    verdict: verdict.allowed ? "allow" : "refuse",
    reason: verdict.reason,
    worstWindow:
      worst === null
        ? null
        : {
            windowMinutes: worst.windowMinutes,
            usedPercent: worst.usedPercent,
            resetsAt: worst.resetsAt,
          },
    source: effective?.kind === "available" ? effective.source : null,
    observedAt: effective?.observedAt ?? null,
    freshness: verdict.freshness,
    pausedRuns: { count: paused, earliestResetAt },
  });
  const earliest = paused > 0 ? (input.pausedRuns?.earliestResetAt ?? null) : null;
  for (const candidate of [build(earliest), build(null)]) {
    if (CodexHeadroomSchema.safeParse(candidate).success) return candidate;
  }
  return {
    verdict: "refuse",
    reason: "usage-unavailable",
    worstWindow: null,
    source: null,
    observedAt: null,
    freshness: "unavailable",
    pausedRuns: { count: paused, earliestResetAt: null },
  };
}
