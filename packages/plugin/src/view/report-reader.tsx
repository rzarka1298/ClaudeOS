import {
  REPORT_ITEM_KIND_DISPLAY,
  REPORT_ITEM_KINDS,
  REPORT_STALE_AFTER_MS,
  reportFreshness,
  SOURCE_FAILURE_DISPLAY,
} from "@ccc/domain/research.js";
import type { ResearchReportHeader } from "@ccc/domain/research-routes.js";
import { RUN_STATE_DISPLAY } from "@ccc/domain/session.js";
import { type ComponentChildren, Fragment, type VNode } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { researchPorts } from "../research/api.js";
import {
  closeReader,
  openReader,
  type ReaderState,
  readerState,
  retryReader,
} from "../research/reader-state.js";
import { refreshList, setStatusLine } from "../research/state.js";
import { FRESHNESS_GLYPH } from "../widgets/footer.js";
import { formatRelativeTime } from "../widgets/relative-time.js";
import { UntrustedText } from "./approval-text.js";
import { ReportFinding } from "./report-finding.js";
import { ReportSources } from "./report-sources.js";
import {
  ADDRESS_COPIED,
  ADDRESS_COPY_FAILED,
  AI_LINE_LEAD,
  AI_LINE_TAIL,
  BACK_TO_REPORTS_LABEL,
  EXTRACTIVE_SUMMARISER_TEXT,
  kindCountsText,
  LOAD_ERROR_HELP,
  LOAD_REST_ERROR,
  LOAD_REST_LABEL,
  NO_FINDINGS,
  NOT_FOUND_BODY,
  NOT_FOUND_HEADING,
  NOT_RECORDED,
  OPEN_NOTE_FAILED,
  OPEN_NOTE_LABEL,
  OPEN_RUN_NOTE_FAILED,
  OPEN_RUN_NOTE_LABEL,
  partialIntro,
  READER_ERROR,
  READER_FINDINGS_HEADING,
  READER_LEGEND_HEADING,
  READER_LOADING,
  READER_RUN_HEADING,
  READER_SOURCES_HEADING,
  READER_UNAVAILABLE_HEADING,
  RUN_FIELD_LABELS,
  SECTION_NOT_LOADED_OFFLINE,
  SOURCE_NOT_LOADED,
  staleLine,
  TEXT_SHORTENED,
  TRUNCATED_ITEMS,
  TRY_AGAIN_LABEL,
  UNAVAILABLE_LABEL_MAX,
  UNREADABLE_BODY,
  UNREADABLE_HEADING,
} from "./research-copy.js";
import { capText, formatRunTime, itemsText } from "./research-format.js";

/**
 * The report reader (plan 07-13; UI-SPEC R4, RSRCH-03/04/05/10, D-23): one article that renders
 * only the service-built, paged view model. It reads the reader state (`research/reader-state.ts`),
 * which loads the findings pages and the sources page in order, and renders every string that came
 * from a source or a model through `UntrustedText` as a text node. It never parses Markdown, never
 * builds a link, an image or a frame, and never writes an inline style.
 *
 * Block order is fixed (UI-SPEC R4): Back to reports (one column only), the title, the meta line,
 * kind counts, the AI line, the actions, the stale line, the unavailable sources notice, how to
 * read the report, the findings, the sources, the run record. Partiality comes before the findings
 * so the owner reads the gap before the content.
 *
 * Focus moves to the title once it renders; a citation moves focus to the cited source's heading
 * (an instant scroll, never smooth) and that entry offers the way back to the citation. The host
 * ports (copy, open) are reached through the port holder; both are local actions that stay enabled
 * while the service is away.
 */

export interface ReportReaderProps {
  readonly noteId: string;
  /** Closes the reader and returns to the list. */
  readonly onBack: () => void;
  readonly now: number;
  readonly zone: string;
  /** True when the list sits above the reader (one column): Back to reports and Escape apply. */
  readonly stacked?: boolean | undefined;
  /** False while the companion service is away; last-good content stays readable. */
  readonly connected?: boolean | undefined;
}

interface CiteOrigin {
  readonly sourceNumber: number;
  readonly itemIndex: number;
}

const FRESHNESS_LABEL = {
  live: "Live",
  cached: "Cached",
  stale: "Stale",
  unavailable: "Unavailable",
} as const;

const STALE_HOURS = Math.round(REPORT_STALE_AFTER_MS / 3_600_000);

function readerFor(noteId: string): ReaderState | null {
  const state = readerState.value;
  return state !== null && state.noteId === noteId ? state : null;
}

/** Opens a vault-relative note through the host port; `failed` is said once if it will not open. */
function openVaultNote(path: string, failed: string): void {
  void Promise.resolve(researchPorts().openNote(path)).then(
    (opened) => {
      if (!opened) setStatusLine(failed);
    },
    () => setStatusLine(failed),
  );
}

function copyAddress(address: string): void {
  void Promise.resolve(researchPorts().copyText(address)).then(
    (copied) => setStatusLine(copied ? ADDRESS_COPIED : ADDRESS_COPY_FAILED),
    () => setStatusLine(ADDRESS_COPY_FAILED),
  );
}

function ErrorGlyph(): VNode {
  return (
    <span className="ccc-error-glyph" aria-hidden="true">
      ▲
    </span>
  );
}

function Skeleton(): VNode {
  return <span className="ccc-skeleton-line" aria-hidden="true" />;
}

function Shortened(): VNode {
  return <span className="ccc-field-help">{` ${TEXT_SHORTENED}`}</span>;
}

function Segments(props: { readonly parts: readonly ComponentChildren[] }): VNode {
  const nodes: ComponentChildren[] = [];
  props.parts.forEach((part, index) => {
    if (index > 0) nodes.push(" · ");
    nodes.push(part);
  });
  return <>{nodes}</>;
}

function PartialBadge(): VNode {
  return (
    <span className="ccc-badge" data-badge="partial">
      <span className="ccc-badge-glyph" aria-hidden="true">
        ◈
      </span>
      <span className="ccc-badge-label">Partial</span>
    </span>
  );
}

function Summariser(props: { readonly id: string }): VNode {
  return props.id === "extractive" ? (
    <span>{EXTRACTIVE_SUMMARISER_TEXT}</span>
  ) : (
    <span className="ccc-mono">{props.id}</span>
  );
}

/** A failed or never-loaded section: the offline sentence, or the load error with its retry. */
function SectionGap(props: {
  readonly connected: boolean;
  readonly failed: boolean;
  readonly loading: boolean;
  readonly onRetry: () => void;
}): VNode | null {
  if (!props.connected) {
    return props.failed || props.loading ? (
      <p className="ccc-field-help">{SECTION_NOT_LOADED_OFFLINE}</p>
    ) : null;
  }
  if (props.failed) {
    return (
      <div className="ccc-report-load-error">
        <p>
          <ErrorGlyph />
          {LOAD_REST_ERROR}
        </p>
        <button
          type="button"
          className="ccc-connect-button"
          data-variant="tertiary"
          onClick={props.onRetry}
        >
          {LOAD_REST_LABEL}
        </button>
      </div>
    );
  }
  return props.loading ? <Skeleton /> : null;
}

function Header(props: {
  readonly header: ResearchReportHeader;
  readonly now: number;
  readonly zone: string;
}): VNode {
  const { header, now, zone } = props;
  const freshness = reportFreshness(header.generatedAt, now);
  const total =
    header.kindCounts["source-fact"] +
    header.kindCounts["unverified-claim"] +
    header.kindCounts.inference;
  return (
    <>
      <p className="ccc-report-meta">
        <Segments
          parts={[
            <span key="generated">
              {"Generated "}
              <time dateTime={header.generatedAt}>
                {formatRunTime(header.generatedAt, now, zone)}
              </time>
              {` (${formatRelativeTime(header.generatedAt, now)})`}
            </span>,
            <span key="freshness" className="ccc-badge" data-badge={freshness}>
              <span className="ccc-badge-glyph" aria-hidden="true">
                {FRESHNESS_GLYPH[freshness]}
              </span>
              <span className="ccc-visually-hidden">Freshness: </span>
              <span className="ccc-badge-label">{FRESHNESS_LABEL[freshness]}</span>
            </span>,
            header.partial ? <PartialBadge key="partial" /> : null,
            `${header.sourceCount} of ${header.sourceTotal} ${header.sourceTotal === 1 ? "source" : "sources"}`,
            itemsText(total),
          ].filter((part) => part !== null)}
        />
      </p>
      <p className="ccc-report-counts">{kindCountsText(header.kindCounts)}</p>
      <p className="ccc-report-ai">
        {AI_LINE_LEAD}
        <Summariser id={header.summariser} />
        {AI_LINE_TAIL}
      </p>
    </>
  );
}

function Unavailable(props: { readonly header: ResearchReportHeader }): VNode {
  const headingId = useId();
  const { header } = props;
  const count =
    header.unavailableSources.length > 0
      ? header.unavailableSources.length
      : Math.max(0, header.sourceTotal - header.sourceCount);
  return (
    <section className="ccc-banner ccc-report-unavailable" aria-labelledby={headingId}>
      <h4 id={headingId} className="ccc-section-label">
        {READER_UNAVAILABLE_HEADING}
      </h4>
      <p>
        <span aria-hidden="true">◈</span> {partialIntro(count, header.sourceTotal)}
      </p>
      <ul>
        {header.unavailableSources.map((source, position) => {
          const label = capText(source.label, UNAVAILABLE_LABEL_MAX);
          return (
            // The position keeps the key unique even if a label repeats.
            <li key={`${position}|${source.code}`}>
              <span aria-hidden="true">✕</span> <UntrustedText text={label.text} />
              {label.shortened ? <Shortened /> : null}
              {` — ${SOURCE_FAILURE_DISPLAY[source.code]}`}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Legend(): VNode {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h4 id={headingId} className="ccc-section-label">
        {READER_LEGEND_HEADING}
      </h4>
      <dl className="ccc-report-legend">
        {REPORT_ITEM_KINDS.map((kind) => {
          const display = REPORT_ITEM_KIND_DISPLAY[kind];
          return (
            <Fragment key={kind}>
              <dt data-kind={kind}>
                <span aria-hidden="true">{display.glyph}</span> <span>{display.label}</span>
              </dt>
              <dd>{display.meaning}</dd>
            </Fragment>
          );
        })}
      </dl>
    </section>
  );
}

function RunRecord(props: {
  readonly header: ResearchReportHeader;
  readonly now: number;
  readonly zone: string;
}): VNode {
  const headingId = useId();
  const { header, now, zone } = props;
  const outcome = header.runOutcome;
  const runNotePath = header.runNotePath;
  const state =
    outcome === null ? null : RUN_STATE_DISPLAY[outcome === "failure" ? "failed" : "completed"];
  return (
    <section className="ccc-report-run" aria-labelledby={headingId}>
      <h4 id={headingId} className="ccc-section-label">
        {READER_RUN_HEADING}
      </h4>
      <dl className="ccc-detail-fields">
        <dt>{RUN_FIELD_LABELS.run}</dt>
        <dd>
          <span className="ccc-mono">{header.jobRunId}</span>
        </dd>
        <dt>{RUN_FIELD_LABELS.started}</dt>
        <dd>
          {header.runStartedAt === null ? (
            NOT_RECORDED
          ) : (
            <time dateTime={header.runStartedAt}>
              {formatRunTime(header.runStartedAt, now, zone)}
            </time>
          )}
        </dd>
        <dt>{RUN_FIELD_LABELS.finished}</dt>
        <dd>
          {header.runEndedAt === null ? (
            NOT_RECORDED
          ) : (
            <time dateTime={header.runEndedAt}>{formatRunTime(header.runEndedAt, now, zone)}</time>
          )}
        </dd>
        <dt>{RUN_FIELD_LABELS.outcome}</dt>
        <dd>
          {state === null ? (
            NOT_RECORDED
          ) : (
            <Segments
              parts={[
                <span
                  key="state"
                  className="ccc-research-state"
                  data-state={outcome === "failure" ? "failed" : "completed"}
                >
                  <span aria-hidden="true">{state.glyph}</span> <span>{state.label}</span>
                </span>,
                outcome === "partial" ? <PartialBadge key="partial" /> : null,
              ].filter((part) => part !== null)}
            />
          )}
        </dd>
        <dt>{RUN_FIELD_LABELS.summariser}</dt>
        <dd>
          <Summariser id={header.summariser} />
        </dd>
      </dl>
      {runNotePath === null ? null : (
        <button
          type="button"
          className="ccc-connect-button"
          data-variant="tertiary"
          onClick={() => openVaultNote(runNotePath, OPEN_RUN_NOTE_FAILED)}
        >
          {OPEN_RUN_NOTE_LABEL}
        </button>
      )}
    </section>
  );
}

export function ReportReader(props: ReportReaderProps): VNode {
  const titleId = useId();
  const findingsId = useId();
  const sourcesId = useId();
  const rootRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const focusedFor = useRef<string | null>(null);
  const [backTo, setBackTo] = useState<CiteOrigin | null>(null);
  const { noteId } = props;
  const connected = props.connected !== false;
  const stacked = props.stacked === true;

  useEffect(() => {
    focusedFor.current = null;
    setBackTo(null);
    void openReader(noteId);
    return () => {
      closeReader();
    };
  }, [noteId]);

  const state = readerFor(noteId);
  const header = state?.header ?? null;
  const firstFailure = state?.firstFailure ?? null;

  // Focus moves to the title once it renders, and to the heading of a gone report; once per report.
  useEffect(() => {
    if (focusedFor.current === noteId) return;
    if (header !== null || firstFailure === "not-found") {
      focusedFor.current = noteId;
      titleRef.current?.focus();
    }
  }, [header, firstFailure, noteId]);

  // A report that is gone or damaged means the list is stale: ask for it once.
  useEffect(() => {
    if (firstFailure === "not-found" || firstFailure === "unreadable-report") void refreshList();
  }, [firstFailure]);

  function jumpToSource(sourceNumber: number, itemIndex: number): void {
    const target = rootRef.current?.querySelector<HTMLElement>(
      `li.ccc-report-source[data-source="${sourceNumber}"] h5`,
    );
    if (target === null || target === undefined) {
      setStatusLine(SOURCE_NOT_LOADED);
      return;
    }
    target.scrollIntoView({ block: "nearest" });
    target.focus({ preventScroll: true });
    setBackTo({ sourceNumber, itemIndex });
  }

  function backToFinding(itemIndex: number, sourceNumber: number): void {
    rootRef.current
      ?.querySelector<HTMLElement>(`button[data-cite="${itemIndex}-${sourceNumber}"]`)
      ?.focus();
    setBackTo(null);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && stacked) {
      event.preventDefault();
      props.onBack();
    }
  }

  const backButton = stacked ? (
    <button
      type="button"
      className="ccc-connect-button"
      data-variant="tertiary"
      onClick={props.onBack}
    >
      {BACK_TO_REPORTS_LABEL}
    </button>
  ) : null;

  // The report did not open: one fixed message per closed code, never a remote string.
  if (state !== null && header === null && firstFailure !== null) {
    const gone = firstFailure === "not-found";
    const unreadable = firstFailure === "unreadable-report";
    const heading = gone ? NOT_FOUND_HEADING : unreadable ? UNREADABLE_HEADING : READER_ERROR;
    return (
      <article
        className="ccc-report-reader"
        aria-labelledby={titleId}
        data-dimmed={connected ? undefined : "true"}
        ref={rootRef}
        onKeyDown={onKeyDown}
      >
        {backButton}
        <h3 id={titleId} tabIndex={-1} ref={titleRef}>
          {gone || unreadable ? null : <ErrorGlyph />}
          {heading}
        </h3>
        {gone ? <p>{NOT_FOUND_BODY}</p> : null}
        {unreadable ? <p>{UNREADABLE_BODY}</p> : null}
        {gone || unreadable ? null : (
          <>
            <p className="ccc-field-help">{LOAD_ERROR_HELP}</p>
            <button
              type="button"
              className="ccc-connect-button"
              data-variant="tertiary"
              onClick={() => {
                void retryReader();
              }}
            >
              {TRY_AGAIN_LABEL}
            </button>
          </>
        )}
      </article>
    );
  }

  if (state === null || header === null) {
    return (
      <article
        className="ccc-report-reader"
        aria-labelledby={titleId}
        aria-busy="true"
        ref={rootRef}
        onKeyDown={onKeyDown}
      >
        {backButton}
        <span id={titleId} className="ccc-visually-hidden">
          {READER_LOADING}
        </span>
        <Skeleton />
        <div className="ccc-report-skeleton-item">
          <Skeleton />
        </div>
        <div className="ccc-report-skeleton-item">
          <Skeleton />
        </div>
        <div className="ccc-report-skeleton-item">
          <Skeleton />
        </div>
      </article>
    );
  }

  const laterFailed = state.laterFailure !== null;
  const itemsFailed = laterFailed && !state.itemsLoaded;
  const sourcesFailed = laterFailed && state.itemsLoaded;
  const stale = reportFreshness(header.generatedAt, props.now) === "stale";
  const retry = (): void => {
    void retryReader();
  };

  return (
    <article
      className="ccc-report-reader"
      aria-labelledby={titleId}
      data-dimmed={connected ? undefined : "true"}
      ref={rootRef}
      onKeyDown={onKeyDown}
    >
      {backButton}
      <h3 id={titleId} tabIndex={-1} ref={titleRef}>
        <UntrustedText text={header.title} />
      </h3>
      <Header header={header} now={props.now} zone={props.zone} />
      <div className="ccc-report-actions">
        <button
          type="button"
          className="ccc-connect-button"
          data-variant="secondary"
          onClick={() => openVaultNote(header.notePath, OPEN_NOTE_FAILED)}
        >
          {OPEN_NOTE_LABEL}
        </button>
      </div>
      {stale ? <p className="ccc-report-stale">{staleLine(STALE_HOURS)}</p> : null}
      {header.partial ? <Unavailable header={header} /> : null}
      <Legend />
      <section className="ccc-report-findings-section" aria-labelledby={findingsId}>
        <h4 id={findingsId} className="ccc-section-label">
          {READER_FINDINGS_HEADING}
        </h4>
        {state.items.length === 0 ? null : (
          <ol className="ccc-report-items">
            {state.items.map((item) => (
              <ReportFinding key={item.index} item={item} onCite={jumpToSource} />
            ))}
          </ol>
        )}
        {state.itemsLoaded && state.items.length === 0 ? <p>{NO_FINDINGS}</p> : null}
        {state.itemsTruncated ? <p className="ccc-field-help">{TRUNCATED_ITEMS}</p> : null}
        {state.itemsLoaded ? null : (
          <SectionGap
            connected={connected}
            failed={itemsFailed}
            loading={!laterFailed}
            onRetry={retry}
          />
        )}
      </section>
      <section className="ccc-report-sources-section" aria-labelledby={sourcesId}>
        <h4 id={sourcesId} className="ccc-section-label">
          {READER_SOURCES_HEADING}
        </h4>
        {state.sources === null ? null : (
          <ReportSources
            sources={state.sources}
            backTo={backTo}
            onBackToFinding={backToFinding}
            onCopyAddress={copyAddress}
            onOpenSnapshot={(path) => openVaultNote(path, OPEN_NOTE_FAILED)}
            now={props.now}
            zone={props.zone}
          />
        )}
        {state.sourcesTruncated ? <p className="ccc-field-help">{TRUNCATED_ITEMS}</p> : null}
        {state.sources === null ? (
          <SectionGap
            connected={connected}
            failed={sourcesFailed}
            loading={!laterFailed}
            onRetry={retry}
          />
        ) : null}
      </section>
      <RunRecord header={header} now={props.now} zone={props.zone} />
    </article>
  );
}
