import {
  CODEX_RESERVE_PERCENT,
  CODEX_USAGE_LIVE_MAX_AGE_MS,
  CODEX_USAGE_STALE_MAX_AGE_MS,
  type CodexHeadroom,
  type CodexHeadroomReason,
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

/** Live up to the live max age, stale up to the stale max age, unavailable beyond. */
export function ageFreshness(observedAtMs: number, nowMs: number): Freshness {
  const age = nowMs - observedAtMs;
  if (!Number.isFinite(age)) return "unavailable";
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

export function evaluateGuard(input: GuardInput): GuardVerdict {
  const { snapshot } = input;
  if (snapshot === null || snapshot.kind === "unavailable") {
    return {
      allowed: false,
      exitCode: GUARD_EXIT.UNAVAILABLE,
      status: "unavailable",
      reason: "usage-unavailable",
      freshness: "unavailable",
      usedPercent: null,
      resetsAt: null,
      ordinaryUsageAllowed: null,
    };
  }
  const worst = worstOf(snapshot.windows);
  const usedPercent = worst === null ? 0 : worst.usedPercent;
  const ordinary =
    snapshot.ordinaryUsageAllowed === true && snapshot.rateLimitReached
      ? false
      : snapshot.ordinaryUsageAllowed;
  const atReserve = usedPercent >= CODEX_RESERVE_PERCENT;
  let exitCode: GuardExitCode = GUARD_EXIT.OK;
  if (ordinary === false) exitCode = GUARD_EXIT.NOT_ALLOWED;
  else if (atReserve) exitCode = GUARD_EXIT.RESERVE;
  return {
    allowed: exitCode === GUARD_EXIT.OK,
    exitCode,
    status: atReserve ? "low" : "ok",
    reason: atReserve || snapshot.rateLimitReached ? "reserve-line" : null,
    freshness: snapshot.freshness,
    usedPercent,
    resetsAt: worst?.resetsAt ?? null,
    ordinaryUsageAllowed: ordinary,
  };
}

export function buildCodexHeadroom(input: HeadroomInput): CodexHeadroom {
  const verdict = evaluateGuard(input);
  const snapshot = input.snapshot;
  const worst = snapshot?.kind === "available" ? worstOf(snapshot.windows) : null;
  return {
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
    source: snapshot?.kind === "available" ? snapshot.source : null,
    observedAt: snapshot?.observedAt ?? null,
    freshness: verdict.freshness,
    pausedRuns: input.pausedRuns ?? { count: 0, earliestResetAt: null },
  };
}
