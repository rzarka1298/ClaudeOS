import type { CodexRecognitionVerdict } from "@ccc/collectors";
import {
  type CodexTokenActivity,
  type CodexTokenCounters,
  type CodexTokenSummary,
  USAGE_RANGES,
  type UsageRangeKind,
} from "@ccc/domain";
import {
  type AnalysisToggle,
  listToggleLog,
  queryCodexCoverage,
  queryCodexTokenTotals,
} from "@ccc/operational-store";
import type Database from "better-sqlite3";
import { freshnessAt, localDayOf, type RangeBounds, rangeBounds } from "../claude/usage-summary.js";

/**
 * The Codex token summary builder (plan 05.1-23, D-24, CODEX-10). Pure over the
 * store and the shared analysis toggle log: three ranges (today, last 7 days,
 * this month), counters only, labelled apart from plan usage, with no cost,
 * price or billing member. The time zone and clock are arguments.
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

const SOURCE = "codex-session-logs" as const;

const ZERO: CodexTokenCounters = {
  input: 0,
  cachedInput: 0,
  cacheWrite: 0,
  output: 0,
  reasoningOutput: 0,
  total: 0,
};

function rangeActivity(
  inputs: CodexTokenSummaryInputs,
  kind: UsageRangeKind,
  bounds: RangeBounds,
  toggles: readonly AnalysisToggle[],
): CodexTokenActivity {
  const { db, now, timeZone } = inputs;
  if (!inputs.analysisOn) return { kind: "unavailable", reason: "analysis-off", version: null };
  const horizon = inputs.horizonDay ?? null;
  const dayOf = (iso: string) => localDayOf(iso, timeZone);
  const days = queryCodexCoverage(db, bounds.firstDay, bounds.lastDay, horizon, toggles, dayOf);
  const totals = queryCodexTokenTotals(db, { start: bounds.start, end: bounds.queryEnd });
  const lastScanAt = inputs.lastScanAt ?? null;
  return {
    kind: "available",
    range: kind,
    bounds: { start: bounds.start, end: bounds.end },
    totals: totals?.counters ?? ZERO,
    observedAt: lastScanAt ?? now.toISOString(),
    source: SOURCE,
    // Before this process's first scan the counters are what an earlier one left.
    freshness: lastScanAt === null ? "cached" : freshnessAt(lastScanAt, now),
    partiality: { partial: days.some((d) => d.status !== "covered") },
    coverage: {
      horizonDate: horizon !== null && bounds.firstDay < horizon ? horizon : null,
      uncoveredDays: days.filter((d) => d.status === "before-horizon" || d.status === "not-scanned")
        .length,
      analysisOffDays: days.filter((d) => d.status === "analysis-off").length,
    },
  };
}

export function buildCodexTokenSummary(inputs: CodexTokenSummaryInputs): CodexTokenSummary {
  const toggles = listToggleLog(inputs.db);
  const [today, last7, month] = USAGE_RANGES.map((kind) =>
    rangeActivity(inputs, kind, rangeBounds(kind, inputs.now, inputs.timeZone), toggles),
  );
  if (today === undefined || last7 === undefined || month === undefined) {
    throw new Error("USAGE_RANGES must name three ranges");
  }
  return {
    ranges: { today, "last-7-days": last7, "this-month": month },
    firstScanPending: inputs.firstScanPending,
    observedAt: inputs.now.toISOString(),
  };
}
