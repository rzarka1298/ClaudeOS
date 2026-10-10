import type { CodexTokenActivity, CodexTokenSummary } from "@ccc/domain/codex-sessions.js";
import type { UsageRangeKind } from "@ccc/domain/usage.js";
import type { VNode } from "preact";
import { useState } from "preact/hooks";
import { FRESHNESS_LABEL, RangeSelector } from "./claude-usage.js";
import {
  CODEX_COPY,
  CODEX_COUNTER_LABELS,
  CODEX_ROW_COPY,
  codexChangedBody,
  formatTokenBreakdown,
} from "./codex-format.js";
import { CodexAnalysisPill } from "./codex-sessions.js";
import type { QuickActionDescriptor } from "./contract.js";
import { formatAbsoluteTime } from "./relative-time.js";
import { SourceDisclosure } from "./source-disclosure.js";
import {
  formatCalendarDate,
  formatCompactTokens,
  formatExactTokens,
  formatRangeBounds,
} from "./usage-format.js";
export interface CodexTokenActivityProps {
  readonly summary: CodexTokenSummary | null;
  readonly analysisOn: boolean;
  readonly nowMs: number;
  readonly onQuickAction?: ((descriptor: QuickActionDescriptor) => void) | undefined;
}
function partialText(
  activity: Extract<CodexTokenActivity, { kind: "available" }>,
  nowMs: number,
): string {
  const lines: string[] = [];
  if (activity.coverage.analysisOffDays > 0) lines.push(CODEX_COPY.tokenAnalysisPartial);
  if (activity.coverage.horizonDate !== null)
    lines.push(
      CODEX_COPY.tokenCoveragePartial.replace(
        "{date}",
        formatCalendarDate(activity.coverage.horizonDate, nowMs),
      ),
    );
  return lines.join(" ");
}
export function CodexTokenActivitySection({
  summary,
  analysisOn,
  nowMs,
  onQuickAction,
}: CodexTokenActivityProps): VNode {
  const [range, setRange] = useState<UsageRangeKind>("today");
  const activity: CodexTokenActivity = !analysisOn
    ? { kind: "unavailable", reason: "analysis-off", version: null }
    : summary?.firstScanPending
      ? { kind: "unavailable", reason: "first-scan-pending", version: null }
      : (summary?.ranges[range] ?? { kind: "unavailable", reason: "no-coverage", version: null });
  const available = activity.kind === "available";
  const busy = activity.kind === "unavailable" && activity.reason === "first-scan-pending";
  const partial =
    available && activity.partiality.partial ? partialText(activity, nowMs) : undefined;
  const sourceRows = available
    ? (Object.keys(CODEX_COUNTER_LABELS) as (keyof typeof CODEX_COUNTER_LABELS)[]).map((key) => ({
        numberLabel: `${CODEX_COUNTER_LABELS[key]}: ${formatExactTokens(activity.totals[key])} tokens`,
        source: CODEX_COPY.tokenSource,
        range: formatRangeBounds(activity.bounds, range, nowMs),
        observed: formatAbsoluteTime(activity.observedAt),
        freshness: FRESHNESS_LABEL[activity.freshness],
        partial,
      }))
    : [];
  return (
    <section
      className="ccc-usage-section"
      data-codex-section="token-activity"
      aria-busy={busy ? "true" : undefined}
    >
      <h4>{CODEX_COPY.tokenActivityHeading}</h4>
      <p className="ccc-list-meta">{CODEX_COPY.tokenExplanation}</p>
      {analysisOn && !busy && summary !== null && (
        <RangeSelector
          value={range}
          ariaLabel={CODEX_COPY.tokenRangeAriaLabel}
          onChange={(next) => {
            if (onQuickAction !== undefined) setRange(next);
          }}
        />
      )}
      {available ? (
        <>
          <p className="ccc-state-heading">{`${formatCompactTokens(activity.totals.total)} tokens`}</p>
          <p className="ccc-list-meta">{formatRangeBounds(activity.bounds, range, nowMs)}</p>
          <p className="ccc-list-meta">{formatTokenBreakdown(activity.totals)}</p>
          {activity.partiality.partial && (
            <p className="ccc-list-meta">
              <span className="ccc-badge" data-badge="partial">
                <span className="ccc-badge-glyph" aria-hidden="true">
                  ◈
                </span>
                <span className="ccc-badge-label">{CODEX_ROW_COPY.partial}</span>
              </span>{" "}
              {partial}
            </p>
          )}
        </>
      ) : activity.reason === "analysis-off" ? (
        <>
          <p className="ccc-state-body">{CODEX_COPY.analysisHeading}</p>
          <p className="ccc-list-meta">{CODEX_COPY.analysisBody}</p>
          <CodexAnalysisPill
            name={CODEX_COPY.analysisTokenAriaLabel}
            onQuickAction={onQuickAction}
          />
        </>
      ) : activity.reason === "format-changed" ? (
        <>
          <p className="ccc-state-body">{CODEX_COPY.tokenUnavailable}</p>
          <p className="ccc-list-meta">
            {codexChangedBody(CODEX_COPY.tokenShapeChanged, activity.version)}
          </p>
        </>
      ) : (
        <p className="ccc-state-body">
          {busy ? CODEX_COPY.tokenFirstScan : CODEX_COPY.noTokenCoverage}
        </p>
      )}
      {available && <p className="ccc-list-meta">{CODEX_COPY.tokenSourceNote}</p>}
      <SourceDisclosure
        srSuffix={CODEX_ROW_COPY.tokenSourceSuffix}
        rows={sourceRows}
        disabled={!available}
      />
    </section>
  );
}
