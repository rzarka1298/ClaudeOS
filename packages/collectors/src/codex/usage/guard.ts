import type {
  CodexHeadroom,
  CodexHeadroomReason,
  CodexUsageSnapshot,
  Freshness,
} from "@ccc/domain";

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
  readonly ordinaryUsageAllowed: boolean | null;
}

export interface HeadroomInput {
  readonly snapshot: CodexUsageSnapshot | null;
  readonly nowMs: number;
  readonly pausedRuns?: { readonly count: number; readonly earliestResetAt: string | null };
}

// RED stubs (plan 05.1-07 task 1): signatures only.
export function ageFreshness(_observedAtMs: number, _nowMs: number): Freshness {
  return "unavailable";
}

export function evaluateGuard(_input: GuardInput): GuardVerdict {
  return {
    allowed: true,
    exitCode: GUARD_EXIT.OK,
    status: "ok",
    reason: null,
    freshness: "unavailable",
    usedPercent: null,
    resetsAt: null,
    ordinaryUsageAllowed: null,
  };
}

export function buildCodexHeadroom(_input: HeadroomInput): CodexHeadroom {
  return {
    verdict: "allow",
    reason: null,
    worstWindow: null,
    source: null,
    observedAt: null,
    freshness: "unavailable",
    pausedRuns: { count: 0, earliestResetAt: null },
  };
}
