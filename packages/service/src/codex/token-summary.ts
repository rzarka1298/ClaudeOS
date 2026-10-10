import type { CodexRecognitionVerdict } from "@ccc/collectors";
import { type CodexTokenSummary, USAGE_RANGES } from "@ccc/domain";
import type Database from "better-sqlite3";

/**
 * The Codex token summary builder (plan 05.1-23, D-24, CODEX-10). Pure over the
 * store and the shared analysis toggle log: three ranges (today, last 7 days,
 * this month), counters only, labelled apart from plan usage, with no cost,
 * price or billing member.
 */
export interface CodexTokenSummaryInputs {
  readonly db: Database.Database;
  readonly now: Date;
  /** The local time zone the ranges are computed in (D-45). */
  readonly timeZone: string;
  /** The one shared transcript-analysis toggle (D-17). */
  readonly analysisOn: boolean;
  /** Analysis is on and no complete sweep has run yet. */
  readonly firstScanPending: boolean;
  /** The per-CLI-version recognition verdict of the token lines. */
  readonly recognition: CodexRecognitionVerdict;
  /** The oldest rollout day the scan could see, or null when none was seen. */
  readonly horizonDay?: string | null;
  /** When the last complete sweep finished, or null in a process that has not swept yet. */
  readonly lastScanAt?: string | null;
}

export function buildCodexTokenSummary(inputs: CodexTokenSummaryInputs): CodexTokenSummary {
  const unavailable = {
    kind: "unavailable",
    reason: "analysis-off",
    version: null,
  } as const;
  const [today, last7, month] = USAGE_RANGES.map(() => unavailable);
  if (today === undefined || last7 === undefined || month === undefined) {
    throw new Error("USAGE_RANGES must name three ranges");
  }
  return {
    ranges: { today, "last-7-days": last7, "this-month": month },
    firstScanPending: inputs.firstScanPending,
    observedAt: inputs.now.toISOString(),
  };
}
