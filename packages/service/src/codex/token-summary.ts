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
  /**
   * A counted rollout's latest rescan ended truncated, oversized or refused. Applied
   * conservatively to every range (no per-day attribution): the kept counters are
   * still shown, but the range is partial.
   */
  readonly sourceIncomplete?: boolean;
}

const SOURCE = "codex-session-logs" as const;

/** A toggle log that reads "on" for every day: what a scan covered, whatever the toggle said. */
const ALWAYS_ON: readonly AnalysisToggle[] = [{ at: "1970-01-01T00:00:00.000Z", enabled: true }];

const ZERO: CodexTokenCounters = {
  input: 0,
  cachedInput: 0,
  cacheWrite: 0,
  output: 0,
  reasoningOutput: 0,
  total: 0,
};

/** Why a range is unavailable before coverage is looked at, or null. Order: off, format, pending. */
function blocked(inputs: CodexTokenSummaryInputs): CodexTokenActivity | null {
  if (!inputs.analysisOn) return { kind: "unavailable", reason: "analysis-off", version: null };
  if (inputs.recognition.kind === "unavailable") {
    return { kind: "unavailable", reason: "format-changed", version: inputs.recognition.version };
  }
  if (inputs.firstScanPending) {
    return { kind: "unavailable", reason: "first-scan-pending", version: null };
  }
  return null;
}

function rangeActivity(
  inputs: CodexTokenSummaryInputs,
  kind: UsageRangeKind,
  bounds: RangeBounds,
  toggles: readonly AnalysisToggle[],
): CodexTokenActivity {
  const stopped = blocked(inputs);
  if (stopped !== null) return stopped;
  const { db, now, timeZone } = inputs;
  const horizon = inputs.horizonDay ?? null;
  const dayOf = (iso: string) => localDayOf(iso, timeZone);
  const days = queryCodexCoverage(db, bounds.firstDay, bounds.lastDay, horizon, toggles, dayOf);
  const scanned = queryCodexCoverage(
    db,
    bounds.firstDay,
    bounds.lastDay,
    horizon,
    ALWAYS_ON,
    dayOf,
  );
  const totals = queryCodexTokenTotals(db, { start: bounds.start, end: bounds.queryEnd });
  // Not one covered day and not one counted row: nothing says what this range held (no zero).
  if (scanned.every((d) => d.status !== "covered") && totals === null) {
    return { kind: "unavailable", reason: "no-coverage", version: null };
  }
  const lastScanAt = inputs.lastScanAt ?? null;
  const countOf = (status: string) => days.filter((d) => d.status === status).length;
  const analysisOffDays = countOf("analysis-off");
  const beforeHorizon = countOf("before-horizon");
  const notScanned = countOf("not-scanned");
  const missingSources = [
    ...(analysisOffDays > 0 ? ["analysis-off"] : []),
    ...(beforeHorizon > 0 ? ["log-retention"] : []),
    ...(notScanned > 0 ? ["not-scanned"] : []),
    ...(inputs.sourceIncomplete === true ? ["source-incomplete"] : []),
  ];
  return {
    kind: "available",
    range: kind,
    bounds: { start: bounds.start, end: bounds.end },
    totals: totals?.counters ?? ZERO,
    observedAt: lastScanAt ?? now.toISOString(),
    source: SOURCE,
    // Before this process's first scan the counters are what an earlier one left.
    freshness: lastScanAt === null ? "cached" : freshnessAt(lastScanAt, now),
    partiality: missingSources.length > 0 ? { partial: true, missingSources } : { partial: false },
    coverage: {
      horizonDate: horizon !== null && bounds.firstDay < horizon ? horizon : null,
      uncoveredDays: beforeHorizon + notScanned,
      analysisOffDays,
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
