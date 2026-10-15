import { reportFreshness } from "@ccc/domain/research.js";
import type { ResearchListRow } from "@ccc/domain/research-routes.js";
import { RUN_STATE_DISPLAY } from "@ccc/domain/session.js";
import type { ComponentChildren, VNode } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import { researchConfigured, researchPorts } from "../research/api.js";
import {
  loadResearch,
  pressPending,
  refreshList,
  refreshStatus,
  reportRows,
  reportsFailure,
  reportsLoaded,
  researchStatus,
  resetResearchState,
  runInProgress,
  selectedNoteId,
  selectReport,
  statusFailure,
  statusLine,
} from "../research/state.js";
import { FRESHNESS_GLYPH, WidgetFooter } from "../widgets/footer.js";
import type { FooterModel } from "../widgets/presentation.js";
import { formatRelativeTime } from "../widgets/relative-time.js";
import { UntrustedText } from "./approval-text.js";
import {
  DISCONNECTED_REASON,
  NO_TOPIC_LABEL,
  REPORT_PLACEHOLDER,
  REPORTS_HEADING,
  RESEARCH_HEADING,
  RUN_IN_PROGRESS_REASON,
  RUN_NOW_LABEL,
  RUN_NOW_NAME,
  STAGE_TEXT,
  STRIP_SOURCE_LABEL,
} from "./research-copy.js";
import { countOf, itemsText, sourcesText } from "./research-format.js";

/**
 * The Research destination (plan 07-11; UI-SPEC R1 to R3): the glass frame, Run
 * now, the provenance strip, the one polite status line and the list-and-reader
 * grid. It reads the research state signals and the port holder and hands the
 * pieces their props; it never imports `obsidian` or the service client, and
 * its body executes nothing itself: Run now calls the `requestRunNow` host port
 * and nothing else.
 *
 * The reader (R4, plan 07-13) plugs in through the `reader` slot. Every string
 * the service derived from a source or a model is rendered as a text node.
 */

/** The longest topic label shown (UI-SPEC "Display caps"). */
const TOPIC_LABEL_MAX = 80;

export interface ResearchReaderSlotProps {
  readonly noteId: string;
  /** Closes the reader and returns to the list (the one-column layout's Back to reports). */
  readonly onBack: () => void;
}

export interface ResearchDestinationProps {
  readonly connection: ConnectionState;
  readonly now: number;
  /** The owner's IANA zone; defaults to the runtime's own. */
  readonly zone?: string | undefined;
  /** The report reader (plan 07-13). Absent, the grid shows the placeholder. */
  readonly reader?: ((props: ResearchReaderSlotProps) => ComponentChildren) | undefined;
}

type ReadableRow = Extract<ResearchListRow, { readable: true }>;

function newestReadable(rows: readonly ResearchListRow[]): ReadableRow | null {
  for (const row of rows) if (row.readable) return row;
  return null;
}

function footerModel(connected: boolean, newest: ReadableRow | null, now: number): FooterModel {
  if (!connected) {
    return {
      observedAt: newest?.generatedAt ?? null,
      freshness: "unavailable",
      partiality: null,
      sources: [{ label: STRIP_SOURCE_LABEL, status: "disconnected" }],
    };
  }
  if (newest === null) {
    return {
      observedAt: null,
      freshness: "unavailable",
      partiality: null,
      sources: [{ label: STRIP_SOURCE_LABEL, status: "no-source" }],
    };
  }
  return {
    observedAt: newest.generatedAt,
    freshness: reportFreshness(newest.generatedAt, now),
    partiality: null,
    sources: [{ label: STRIP_SOURCE_LABEL, status: "ok" }],
  };
}

function PartialBadge(props: { readonly unavailable: number }): VNode {
  const noun = props.unavailable === 1 ? "source" : "sources";
  return (
    <span className="ccc-badge" data-badge="partial">
      <span className="ccc-badge-glyph" aria-hidden="true">
        ◈
      </span>
      <span className="ccc-badge-label">Partial</span>
      <span className="ccc-visually-hidden">{` — ${props.unavailable} ${noun} didn't respond`}</span>
    </span>
  );
}

function CurrentRun(props: { readonly now: number }): VNode | null {
  const inFlight = researchStatus.value?.inFlight ?? null;
  if (inFlight === null) return null;
  const display = RUN_STATE_DISPLAY.running;
  const stage = inFlight.stage === null ? null : STAGE_TEXT[inFlight.stage];
  return (
    <dl className="ccc-detail-fields ccc-research-status-row">
      <dt>Current run</dt>
      <dd>
        <span aria-hidden="true">{display.glyph}</span> <span>{display.label}</span>
        {stage === null ? null : ` · ${stage}`}
        {` · started ${formatRelativeTime(inFlight.startedAt, props.now)}`}
      </dd>
    </dl>
  );
}

function ReportRows(props: {
  readonly rows: readonly ResearchListRow[];
  readonly now: number;
}): VNode {
  return (
    <ul className="ccc-report-list">
      {props.rows.map((row) => {
        if (!row.readable) return null;
        const freshness = reportFreshness(row.generatedAt, props.now);
        const label = freshness === "stale" ? "Stale" : "Cached";
        const sources =
          row.partial && row.sourceTotal !== row.sourceCount
            ? `${row.sourceCount} of ${row.sourceTotal} sources`
            : sourcesText(row.sourceCount);
        return (
          <li className="ccc-report-row" key={row.noteId}>
            <button
              type="button"
              className="ccc-report-row-button"
              aria-current={selectedNoteId.value === row.noteId ? "true" : undefined}
              onClick={() => selectReport(row.noteId)}
            >
              <span className="ccc-clamp-2" title={row.title}>
                <UntrustedText text={row.title} />
              </span>
              <span className="ccc-report-row-meta">
                {formatRelativeTime(row.generatedAt, props.now)}
                {" · "}
                <span className="ccc-badge" data-badge={freshness}>
                  <span className="ccc-badge-glyph" aria-hidden="true">
                    {FRESHNESS_GLYPH[freshness]}
                  </span>
                  <span className="ccc-badge-label">{label}</span>
                </span>
                {` · ${sources} · ${itemsText(row.itemCount)}`}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ResearchDestination(props: ResearchDestinationProps): VNode {
  const headingId = useId();
  const reasonId = useId();
  const reportsId = useId();
  const connected = props.connection.kind !== "disconnected";
  const status = researchStatus.value;
  const rows = reportRows.value;
  const newest = newestReadable(rows);
  const pending = pressPending.value;
  const awaitingRun = runInProgress();
  // An unconfigured port, or a service that answered "disconnected", reads as the service being away.
  const serviceAway =
    !connected ||
    !researchConfigured() ||
    statusFailure.value === "service-disconnected" ||
    reportsFailure.value === "service-disconnected";
  const disabled = serviceAway || pending || awaitingRun;
  const reason = serviceAway
    ? DISCONNECTED_REASON
    : pending || !awaitingRun
      ? null
      : RUN_IN_PROGRESS_REASON;
  const selected = selectedNoteId.value;

  useEffect(() => {
    void loadResearch();
    return () => {
      resetResearchState();
    };
  }, []);

  // Coming back from a drop asks once more.
  const previousKind = useRef(props.connection.kind);
  useEffect(() => {
    if (previousKind.current !== "live" && props.connection.kind === "live") {
      void refreshStatus();
      void refreshList();
    }
    previousKind.current = props.connection.kind;
  }, [props.connection.kind]);

  const topic = status?.topicLabel ?? null;
  const configured = status?.configuredSources ?? null;
  const subline = [
    topic === null ? NO_TOPIC_LABEL : topic.slice(0, TOPIC_LABEL_MAX),
    configured === null ? null : `${countOf(configured.length, "source", "sources")} configured`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <section
      className="ccc-research"
      aria-labelledby={headingId}
      aria-busy={reportsLoaded.value || reportsFailure.value !== null ? undefined : "true"}
      data-dimmed={serviceAway ? "true" : undefined}
    >
      <div className="ccc-research-header">
        <h2 id={headingId} tabIndex={-1}>
          {RESEARCH_HEADING}
        </h2>
        <div className="ccc-research-run">
          <button
            type="button"
            className="ccc-connect-button"
            data-variant="primary"
            aria-label={RUN_NOW_NAME}
            aria-busy={pending ? "true" : undefined}
            aria-disabled={disabled ? "true" : undefined}
            aria-describedby={reason === null ? undefined : reasonId}
            onClick={() => {
              if (!disabled) researchPorts().requestRunNow();
            }}
          >
            {RUN_NOW_LABEL}
          </button>
          {reason === null ? null : (
            <span id={reasonId} className="ccc-research-reason">
              {reason}
            </span>
          )}
        </div>
      </div>
      <p className="ccc-research-subline">
        <UntrustedText text={subline} />
      </p>
      <div className="ccc-research-strip">
        <WidgetFooter
          model={footerModel(!serviceAway, newest, props.now)}
          panelTitle="research"
          now={props.now}
          dimmed={serviceAway}
        />
        {newest !== null && newest.partial && newest.unavailableCount > 0 ? (
          <PartialBadge unavailable={newest.unavailableCount} />
        ) : null}
      </div>
      <p className="ccc-research-status" role="status">
        {statusLine.value}
      </p>
      <CurrentRun now={props.now} />
      <section aria-labelledby={reportsId}>
        <h3 id={reportsId} className="ccc-section-label">
          {REPORTS_HEADING}
        </h3>
        <div
          className="ccc-research-layout"
          data-reader-open={selected === null ? "false" : "true"}
        >
          <div className="ccc-research-list-cell">
            <ReportRows rows={rows} now={props.now} />
          </div>
          <div className="ccc-research-reader-cell">
            {selected !== null && props.reader !== undefined ? (
              props.reader({ noteId: selected, onBack: () => selectReport(null) })
            ) : (
              <p className="ccc-research-placeholder">{REPORT_PLACEHOLDER}</p>
            )}
          </div>
        </div>
      </section>
    </section>
  );
}
