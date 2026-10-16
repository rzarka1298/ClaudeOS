import { reportFreshness } from "@ccc/domain/research.js";
import type { ResearchListRow } from "@ccc/domain/research-routes.js";
import { resolvedZone } from "@ccc/domain/task-time.js";
import type { ComponentChildren, VNode } from "preact";
import { useEffect, useId, useMemo, useRef } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import { researchConfigured, researchPorts } from "../research/api.js";
import {
  claimRunNowPress,
  clearFocusRequest,
  focusRequest,
  loadMoreReports,
  loadResearch,
  pressPending,
  refreshList,
  refreshStatus,
  releaseRunNowClaim,
  reportRows,
  reportsCursor,
  reportsFailure,
  reportsGeneration,
  reportsLoaded,
  reportsLoadingMore,
  researchStatus,
  resetResearchState,
  runInProgress,
  selectedNoteId,
  selectReport,
  setStatusLine,
  statusFailure,
  statusLine,
} from "../research/state.js";
import { WidgetFooter } from "../widgets/footer.js";
import type { FooterModel } from "../widgets/presentation.js";
import { UntrustedText } from "./approval-text.js";
import { ReportList } from "./report-list.js";
import { ReportReader } from "./report-reader.js";
import {
  DISCONNECTED_REASON,
  NO_TOPIC_LABEL,
  OPEN_NOTE_FAILED,
  REPORT_PLACEHOLDER,
  REPORTS_HEADING,
  RESEARCH_HEADING,
  RUN_IN_PROGRESS_REASON,
  RUN_NOW_LABEL,
  RUN_NOW_NAME,
  STRIP_SOURCE_LABEL,
} from "./research-copy.js";
import { countOf } from "./research-format.js";
import { ResearchStatusSection } from "./research-status.js";

/**
 * The Research destination (plan 07-11; UI-SPEC R1 to R3): the glass frame, Run
 * now, the provenance strip, the one polite status line and the list-and-reader
 * grid. It reads the research state signals and the port holder and hands the
 * pieces their props; it never imports `obsidian` or the service client, and
 * its body executes nothing itself: Run now calls the `requestRunNow` host port
 * and nothing else.
 *
 * The reader (R4, plan 07-13) is the default occupant of the reader cell; the `reader` slot
 * replaces it (the tests of the grid use that). Every string
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
  /** Replaces the report reader (plan 07-13). Absent, the grid shows the real reader. */
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

/** Opens a vault-relative note through the host port; a note that will not open is said so once. */
function openNote(path: string): void {
  void Promise.resolve(researchPorts().openNote(path)).then((opened) => {
    if (!opened) setStatusLine(OPEN_NOTE_FAILED);
  });
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
  const blocked = serviceAway || pending || awaitingRun;
  const reason = serviceAway
    ? DISCONNECTED_REASON
    : pending || !awaitingRun
      ? null
      : RUN_IN_PROGRESS_REASON;
  const selected = selectedNoteId.value;
  const zone = props.zone ?? resolvedZone();
  const generation = reportsGeneration.value;
  const nowRef = useRef(props.now);
  nowRef.current = props.now;
  const loadedAt = useRef<string | null>(null);
  useMemo(() => {
    if (generation > 0) loadedAt.current = new Date(nowRef.current).toISOString();
  }, [generation]);
  const allRunsFailed =
    rows.length === 0 && status?.lastFailure != null && status.lastSuccess === null;

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
            aria-disabled={blocked ? "true" : undefined}
            aria-describedby={reason === null ? undefined : reasonId}
            onClick={() => {
              // Claimed in the click, before the host port is asked, so an async port cannot let a
              // second activation start a second press.
              if (serviceAway || !claimRunNowPress()) return;
              try {
                const asked: unknown = researchPorts().requestRunNow();
                if (asked instanceof Promise) asked.then(releaseRunNowClaim, releaseRunNowClaim);
              } catch {
                releaseRunNowClaim();
              }
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
          dimmed={false}
        />
        {newest?.partial && newest.unavailableCount > 0 ? (
          <PartialBadge unavailable={newest.unavailableCount} />
        ) : null}
      </div>
      <p className="ccc-research-status" role="status">
        {statusLine.value}
      </p>
      <ResearchStatusSection
        status={status}
        loadFailed={status === null && statusFailure.value !== null}
        now={props.now}
        zone={zone}
        onOpenReport={selectReport}
      />
      <section aria-labelledby={reportsId}>
        <h3 id={reportsId} className="ccc-section-label">
          {REPORTS_HEADING}
        </h3>
        <div
          className="ccc-research-layout"
          data-reader-open={selected === null ? "false" : "true"}
        >
          <div className="ccc-research-list-cell">
            <ReportList
              rows={rows}
              loaded={reportsLoaded.value}
              failure={reportsFailure.value}
              hasMore={reportsCursor.value !== null}
              loadingMore={reportsLoadingMore.value}
              selectedNoteId={selected}
              connected={!serviceAway}
              allRunsFailed={allRunsFailed}
              loadedAt={loadedAt.current}
              now={props.now}
              zone={zone}
              focusRequest={focusRequest.value}
              onFocusHandled={clearFocusRequest}
              onSelect={selectReport}
              onOpenNote={openNote}
              onShowMore={() => {
                void loadMoreReports();
              }}
              onRefresh={() => {
                void refreshStatus();
                void refreshList();
              }}
            />
          </div>
          <div className="ccc-research-reader-cell">
            {selected === null ? (
              <p className="ccc-research-placeholder">{REPORT_PLACEHOLDER}</p>
            ) : props.reader !== undefined ? (
              props.reader({ noteId: selected, onBack: () => selectReport(null) })
            ) : (
              <ReportReader
                noteId={selected}
                onBack={() => selectReport(null)}
                now={props.now}
                zone={zone}
              />
            )}
          </div>
        </div>
      </section>
    </section>
  );
}
