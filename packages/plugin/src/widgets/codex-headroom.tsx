import { CODEX_USAGE_LIVE_MAX_AGE_MS } from "@ccc/domain/codex-usage.js";
import type { Freshness } from "@ccc/domain/freshness.js";
import type { VNode } from "preact";
import { FRESHNESS_LABEL, WINDOW_LABEL } from "./claude-usage.js";
import {
  CODEX_COPY,
  formatCodexWindowLabel,
  headroomReasonLine,
  pausedRunsLine,
  verdictLabel,
} from "./codex-format.js";
import type { CodexCardData } from "./codex-signals.js";
import { FRESHNESS_GLYPH } from "./footer.js";
import { formatAbsoluteTime } from "./relative-time.js";
import { SourceDisclosure, type SourceDisclosureRow } from "./source-disclosure.js";
import { formatPercentUsed } from "./usage-format.js";

function Observation({
  source,
  observedAt,
  freshness,
}: {
  readonly source: string;
  readonly observedAt: string;
  readonly freshness: Freshness;
}): VNode {
  return (
    <p className="ccc-list-meta">
      {`Source: ${source} · Observed ${formatAbsoluteTime(observedAt)} · `}
      <span aria-hidden="true">{FRESHNESS_GLYPH[freshness]}</span> {FRESHNESS_LABEL[freshness]}
    </p>
  );
}

/** Read-only capacity facts, in the fixed Claude then Codex order. */
export function CodexHeadroomSection({ data }: { readonly data: CodexCardData }): VNode {
  const signal = data.headroom;
  const claude = signal?.claude;
  const pushed = signal?.codex;
  const tooOld =
    pushed?.observedAt != null &&
    data.nowMs - Date.parse(pushed.observedAt) > CODEX_USAGE_LIVE_MAX_AGE_MS;
  const fallback = data.usage?.kind === "available" && data.usage.source === "rollout-fallback";
  const codex =
    pushed === undefined
      ? undefined
      : tooOld
        ? {
            ...pushed,
            verdict: "refuse" as const,
            reason: "usage-unavailable" as const,
            worstWindow: null,
            freshness: "stale" as const,
          }
        : fallback && pushed.verdict === "allow"
          ? {
              ...pushed,
              verdict: "refuse" as const,
              reason: "no-live-read" as const,
              worstWindow: null,
            }
          : pushed;
  const rows: SourceDisclosureRow[] = [];
  if (claude?.kind === "available")
    rows.push({
      numberLabel: `Claude ${WINDOW_LABEL[claude.window]}: ${formatPercentUsed(claude.usedPercent)}`,
      source: "Claude Code status line",
      range: WINDOW_LABEL[claude.window],
      observed: formatAbsoluteTime(claude.observedAt),
      freshness: FRESHNESS_LABEL[claude.freshness],
    });
  if (codex?.verdict === "allow" && codex.worstWindow !== null && codex.observedAt !== null)
    rows.push({
      numberLabel: `Codex ${formatCodexWindowLabel(codex.worstWindow.windowMinutes)}: ${formatPercentUsed(codex.worstWindow.usedPercent)}`,
      source: codex.source === "rollout-fallback" ? CODEX_COPY.tokenSource : CODEX_COPY.usageSource,
      range: formatCodexWindowLabel(codex.worstWindow.windowMinutes),
      observed: formatAbsoluteTime(codex.observedAt),
      freshness: FRESHNESS_LABEL[codex.freshness],
    });
  const paused = codex
    ? pausedRunsLine(codex.pausedRuns.count, codex.pausedRuns.earliestResetAt, data.nowMs)
    : null;
  return (
    <section className="ccc-usage-section" data-testid="codex-headroom">
      <h4>{CODEX_COPY.headroomHeading}</h4>
      {signal === null ? (
        <>
          <p className="ccc-state-body">{CODEX_COPY.headroomUnavailable}</p>
          <p className="ccc-list-meta">{CODEX_COPY.usageNotRead}</p>
        </>
      ) : (
        <div className="ccc-headroom-strip">
          <div className="ccc-headroom-cell">
            <p className="ccc-list-meta">Claude</p>
            <p className="ccc-state-heading">
              {claude?.kind === "available"
                ? `${formatPercentUsed(claude.usedPercent)} · ${WINDOW_LABEL[claude.window]}`
                : CODEX_COPY.claudeCapacityUnavailable}
            </p>
            {claude?.kind === "available" && (
              <Observation
                source="Claude Code status line"
                observedAt={claude.observedAt}
                freshness={claude.freshness}
              />
            )}
          </div>
          <div className="ccc-headroom-cell">
            <p className="ccc-list-meta">Codex</p>
            <p className="ccc-state-heading">
              <span aria-hidden="true">{codex?.verdict === "allow" ? "✓" : "⊘"}</span>{" "}
              <span>{verdictLabel(codex?.verdict ?? "refuse")}</span>
            </p>
            {codex?.reason ? (
              <p className="ccc-state-body">{headroomReasonLine(codex.reason)}</p>
            ) : (
              codex?.worstWindow && (
                <p className="ccc-state-body">{`${formatPercentUsed(codex.worstWindow.usedPercent)} · ${formatCodexWindowLabel(codex.worstWindow.windowMinutes)}`}</p>
              )
            )}
            {codex?.source && codex.observedAt && (
              <Observation
                source={
                  codex.source === "rollout-fallback"
                    ? CODEX_COPY.tokenSource
                    : CODEX_COPY.usageSource
                }
                observedAt={codex.observedAt}
                freshness={codex.freshness}
              />
            )}
            {paused !== null && (
              <p className="ccc-list-meta">
                <span aria-hidden="true">‖</span> {paused}
              </p>
            )}
          </div>
          <p className="ccc-list-meta">{CODEX_COPY.headroomFooter}</p>
        </div>
      )}
      <SourceDisclosure srSuffix="for headroom" rows={rows} disabled={rows.length === 0} />
    </section>
  );
}
