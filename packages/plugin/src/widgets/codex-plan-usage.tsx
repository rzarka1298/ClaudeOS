import { CODEX_LIMIT_LABEL_PATTERN, type CodexUsageSnapshot } from "@ccc/domain/codex-usage.js";
import type { VNode } from "preact";
import { useId } from "preact/hooks";
import { FRESHNESS_LABEL } from "./claude-usage.js";
import {
  CODEX_COPY,
  codexWindowLine,
  formatCodexWindowLabel,
  reserveState,
  unavailableUsageBody,
} from "./codex-format.js";
import { FRESHNESS_GLYPH } from "./footer.js";
import { formatAbsoluteTime } from "./relative-time.js";
import { SourceDisclosure } from "./source-disclosure.js";
import { formatPercentUsed } from "./usage-format.js";

export function CodexPlanUsageSection({
  usage,
  nowMs,
}: {
  readonly usage: CodexUsageSnapshot | null;
  readonly nowMs: number;
}): VNode {
  const id = useId();
  const rows =
    usage?.kind === "available"
      ? usage.windows.map((window) => ({
          numberLabel: `Codex ${formatCodexWindowLabel(window.windowMinutes)}: ${formatPercentUsed(window.usedPercent)}`,
          source: usage.source === "app-server" ? CODEX_COPY.usageSource : CODEX_COPY.tokenSource,
          range: formatCodexWindowLabel(window.windowMinutes),
          observed: formatAbsoluteTime(usage.observedAt),
          freshness: FRESHNESS_LABEL[usage.freshness],
        }))
      : [];
  return (
    <section className="ccc-usage-section" data-testid="codex-plan-usage">
      <h4>{CODEX_COPY.planUsageHeading}</h4>
      {usage?.kind !== "available" ? (
        <>
          <p className="ccc-state-body">{CODEX_COPY.usageUnavailable}</p>
          {/* The numeric-free unavailable floor wins over printing a version number. */}
          <p className="ccc-list-meta">
            {usage === null ? CODEX_COPY.usageNotRead : unavailableUsageBody(usage.reason)}
          </p>
        </>
      ) : (
        <>
          {usage.windows.map((window, index) => {
            const labelId = `${id}-window-${index}`;
            const stateId = `${id}-reserve-${index}`;
            const line = codexWindowLine(window, nowMs);
            const over = reserveState(window.usedPercent) === "over";
            return (
              <div className="ccc-usage-row" key={labelId}>
                <p className="ccc-list-meta" id={labelId}>
                  {formatCodexWindowLabel(window.windowMinutes)}
                </p>
                {window.limitLabel !== null &&
                  CODEX_LIMIT_LABEL_PATTERN.test(window.limitLabel) && (
                    <p className="ccc-list-meta">{`Limit: ${window.limitLabel}`}</p>
                  )}
                <p className="ccc-state-heading">{line.text}</p>
                {!line.outdated && (
                  <>
                    <span className="ccc-reserve-meter-wrap">
                      <meter
                        className="ccc-usage-meter ccc-reserve-meter"
                        min={0}
                        max={100}
                        value={window.usedPercent}
                        aria-labelledby={labelId}
                        aria-valuetext={formatPercentUsed(window.usedPercent)}
                        aria-describedby={stateId}
                      />
                      <span className="ccc-reserve-tick" aria-hidden="true" />
                    </span>
                    <div className="ccc-reserve-legend">
                      <p className="ccc-list-meta" id={stateId}>
                        <span aria-hidden="true">{over ? "▲" : "✓"}</span>{" "}
                        {over ? (
                          <span className="ccc-state-heading ccc-list-meta">
                            {CODEX_COPY.reserveOver}
                          </span>
                        ) : (
                          <span>{CODEX_COPY.reserveUnder}</span>
                        )}
                      </p>
                      <p className="ccc-list-meta ccc-reserve-legend">
                        <span aria-hidden="true">│</span>
                        <span>{CODEX_COPY.reserveLegend}</span>
                      </p>
                    </div>
                  </>
                )}
              </div>
            );
          })}
          {usage.source === "rollout-fallback" && (
            <p className="ccc-list-meta">
              {CODEX_COPY.fallbackSource}{" "}
              <span className="ccc-badge" data-badge={usage.freshness}>
                <span className="ccc-badge-glyph" aria-hidden="true">
                  {FRESHNESS_GLYPH[usage.freshness]}
                </span>
                <span className="ccc-badge-label">{FRESHNESS_LABEL[usage.freshness]}</span>
              </span>
            </p>
          )}
        </>
      )}
      <SourceDisclosure srSuffix="for plan usage" rows={rows} disabled={rows.length === 0} />
    </section>
  );
}
