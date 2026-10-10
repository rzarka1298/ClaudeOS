import type { VNode } from "preact";
import { useState } from "preact/hooks";
import { codexActionStatus } from "../view/codex-action-status.js";
import { ENABLE_ANALYSIS_DESCRIPTOR, FRESHNESS_LABEL } from "./claude-usage.js";
import { CODEX_COPY, CODEX_ROW_COPY, codexChangedBody, moreSessionsLine } from "./codex-format.js";
import type { CodexSessionRow, CodexSessionRows } from "./codex-session-rows.js";
import type { QuickActionDescriptor, SizeHint } from "./contract.js";
import { ListBody } from "./list-body.js";
import { formatAbsoluteTime } from "./relative-time.js";
import { SourceDisclosure } from "./source-disclosure.js";
export interface CodexSessionsProps {
  readonly rows: CodexSessionRows;
  readonly size: SizeHint;
  readonly onQuickAction?: ((descriptor: QuickActionDescriptor) => void) | undefined;
}
export function CodexAnalysisPill({
  name,
  onQuickAction,
}: {
  readonly name: string;
  readonly onQuickAction?: ((descriptor: QuickActionDescriptor) => void) | undefined;
}): VNode {
  const [failed, setFailed] = useState(false);
  function enable(): void {
    if (onQuickAction === undefined) return;
    setFailed(false);
    try {
      const outcome: unknown = onQuickAction(ENABLE_ANALYSIS_DESCRIPTOR);
      if (outcome instanceof Promise) outcome.catch(() => setFailed(true));
    } catch {
      setFailed(true);
    }
  }
  return (
    <>
      <div role="status" className="ccc-list-meta">
        {failed && (
          <>
            <p className="ccc-state-body">
              <span className="ccc-error-glyph" aria-hidden="true">
                ▲
              </span>{" "}
              {CODEX_COPY.analysisFailure}
            </p>
            <p className="ccc-list-meta">{CODEX_COPY.analysisRetry}</p>
          </>
        )}
      </div>
      <button
        type="button"
        className="ccc-quick-action"
        aria-label={name}
        aria-disabled={onQuickAction === undefined ? "true" : undefined}
        onClick={enable}
      >
        {CODEX_COPY.analysisButton}
      </button>
    </>
  );
}
export function CodexRowList({
  rows,
  size,
  onQuickAction,
}: {
  readonly rows: readonly CodexSessionRow[];
  readonly size: SizeHint;
  readonly onQuickAction?: ((descriptor: QuickActionDescriptor) => void) | undefined;
}): VNode | null {
  return (
    <ListBody
      rows={rows}
      size={size}
      keyOf={(row) => row.key}
      renderPrimary={(row) => row.primary}
      renderMeta={() => ""}
      renderMetaSegments={(row) => row.segments}
      moreDestination="agent-runs"
      renderActions={(row) => (
        <div className="ccc-card-actions">
          <button
            type="button"
            className="ccc-row-action"
            aria-label={CODEX_ROW_COPY.openTranscriptName.replace("{name}", row.primary)}
            aria-disabled={!row.hasTranscript || onQuickAction === undefined ? "true" : undefined}
            onClick={() => {
              if (row.hasTranscript) onQuickAction?.(row.openTranscript);
            }}
          >
            {row.openTranscript.label}
          </button>
          {row.followLog !== null && (
            <button
              type="button"
              className="ccc-row-action"
              aria-label={CODEX_ROW_COPY.followLogName.replace("{name}", row.primary)}
              aria-disabled={onQuickAction === undefined ? "true" : undefined}
              onClick={() => {
                if (row.followLog !== null) onQuickAction?.(row.followLog);
              }}
            >
              {row.followLog.label}
            </button>
          )}
          {!row.hasTranscript && (
            <p className="ccc-list-meta">{CODEX_ROW_COPY.transcriptMissing}</p>
          )}
        </div>
      )}
    />
  );
}
export function CodexSessionsSection({ rows, size, onQuickAction }: CodexSessionsProps): VNode {
  const available = rows.kind === "available";
  const changed = rows.kind === "unavailable" && rows.reason === "format-changed";
  return (
    <section className="ccc-usage-section" data-codex-section="recent-sessions">
      <h4>{CODEX_COPY.recentSessionsHeading}</h4>
      {available ? (
        <>
          {rows.recent.length === 0 ? (
            <p className="ccc-state-body">{CODEX_COPY.noRecentSessions}</p>
          ) : (
            <CodexRowList rows={rows.recent} size={size} onQuickAction={onQuickAction} />
          )}
          {rows.overflow > 0 && <p className="ccc-list-meta">{moreSessionsLine(rows.overflow)}</p>}
          {rows.unknownNote && <p className="ccc-list-meta">{CODEX_COPY.unknownSessionNote}</p>}
          {rows.analysisNote && (
            <>
              <p className="ccc-list-meta">{CODEX_COPY.analysisOffNote}</p>
              <CodexAnalysisPill
                name={CODEX_COPY.analysisSessionsAriaLabel}
                onQuickAction={onQuickAction}
              />
            </>
          )}
          {rows.hookNote && <p className="ccc-list-meta">{CODEX_COPY.hookNotInstalledNote}</p>}
        </>
      ) : changed ? (
        <>
          <p className="ccc-state-body">{CODEX_COPY.sessionsUnavailable}</p>
          <p className="ccc-list-meta">
            {codexChangedBody(CODEX_COPY.sessionsShapeChanged, rows.version)}
          </p>
        </>
      ) : (
        <>
          <p className="ccc-state-body">{CODEX_COPY.noSessions}</p>
          <p className="ccc-list-meta">{CODEX_COPY.startSession}</p>
          <p className="ccc-list-meta">{CODEX_COPY.analysisOffNote}</p>
          <CodexAnalysisPill
            name={CODEX_COPY.analysisSessionsAriaLabel}
            onQuickAction={onQuickAction}
          />
        </>
      )}
      <p role="status" className="ccc-list-meta">
        {available ? (codexActionStatus.value?.text ?? "") : ""}
      </p>
      <SourceDisclosure
        srSuffix={CODEX_ROW_COPY.sessionsSourceSuffix}
        disabled={!available}
        rows={
          available
            ? [
                {
                  numberLabel: CODEX_ROW_COPY.sessionsCount.replace(
                    "{count}",
                    new Intl.NumberFormat("en").format(rows.count),
                  ),
                  source: CODEX_COPY.sessionsSource,
                  range: CODEX_ROW_COPY.sessionsRange,
                  observed: formatAbsoluteTime(rows.observedAt),
                  freshness: FRESHNESS_LABEL[rows.freshness],
                },
              ]
            : []
        }
      />
    </section>
  );
}
