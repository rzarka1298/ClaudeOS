import { reportFreshness } from "@ccc/domain/research.js";
import type { ResearchErrorCode, ResearchListRow } from "@ccc/domain/research-routes.js";
import type { VNode } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { FRESHNESS_GLYPH } from "../widgets/footer.js";
import { formatRelativeTime } from "../widgets/relative-time.js";
import { UntrustedText } from "./approval-text.js";
import {
  DISCONNECTED_REASON,
  EMPTY_ALL_FAILED,
  EMPTY_NEVER_RUN,
  EMPTY_REPORTS_HEADING,
  LOAD_ERROR_HEADING,
  LOAD_ERROR_HELP,
  LOADING_REPORTS,
  OPEN_NOTE_LABEL,
  partialRowTail,
  REFRESH_REPORTS_LABEL,
  refreshFailedLine,
  SHOW_MORE_LABEL,
  UNREADABLE_META,
  UNREADABLE_TITLE,
} from "./research-copy.js";
import { formatRunTime, itemsText, sourcesText } from "./research-format.js";

/**
 * The report list (plan 07-11; UI-SPEC R3, RSRCH-01, RSRCH-05, D-16): newest
 * first, each row a button with the engine-templated title clamped to two lines,
 * the relative generation time, the freshness and partial badges, the source
 * count and the item count. Props-driven: the loaded rows and the facts about
 * the load, and six functions. Freshness is derived here from `generatedAt` and
 * the shell's minute clock with the shared domain constant, so one constant
 * serves the view, the footer and the vault.
 *
 * Titles and file names are untrusted text and render as text nodes only
 * (`UntrustedText`). An unreadable report is listed with its file name and an
 * `Open note` action and can never be selected into the reader. `Open note`
 * stays enabled while the service is away (vault actions are local); `Show 25
 * more` needs the service and is `aria-disabled` with the standard reason.
 */
export interface ReportListProps {
  readonly rows: readonly ResearchListRow[];
  /** True once a load has succeeded at least once. */
  readonly loaded: boolean;
  /** The closed code of the last failed load, or null. */
  readonly failure: ResearchErrorCode | null;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly selectedNoteId: string | null;
  readonly connected: boolean;
  /** True when runs exist but none has produced a report (the empty variant). */
  readonly allRunsFailed: boolean;
  /** When the rows were last good, for the refresh-failure line. */
  readonly loadedAt: string | null;
  readonly now: number;
  readonly zone: string;
  /** The index of the row to focus after "Show 25 more"; null otherwise. */
  readonly focusRequest: number | null;
  readonly onFocusHandled: () => void;
  readonly onSelect: (noteId: string) => void;
  readonly onOpenNote: (path: string) => void;
  readonly onShowMore: () => void;
  readonly onRefresh: () => void;
}

type ReadableRow = Extract<ResearchListRow, { readable: true }>;
type UnreadableRow = Extract<ResearchListRow, { readable: false }>;

function ErrorGlyph(): VNode {
  return (
    <span className="ccc-error-glyph" aria-hidden="true">
      ▲
    </span>
  );
}

function RowTime(props: {
  readonly iso: string;
  readonly now: number;
  readonly zone: string;
}): VNode {
  const describedBy = useId();
  const absolute = formatRunTime(props.iso, props.now, props.zone);
  return (
    <>
      <time
        dateTime={props.iso}
        title={absolute}
        aria-describedby={describedBy}
        className="ccc-research-time"
      >
        {formatRelativeTime(props.iso, props.now)}
      </time>
      <span id={describedBy} className="ccc-visually-hidden">
        {absolute}
      </span>
    </>
  );
}

function sourceCountText(row: ReadableRow): string {
  return row.partial && row.sourceTotal !== row.sourceCount
    ? `${row.sourceCount} of ${row.sourceTotal} sources`
    : sourcesText(row.sourceCount);
}

/** Arrow keys, Home and End move between the row buttons of the list the key was pressed in. */
function moveBetweenRows(event: KeyboardEvent): void {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const current = event.currentTarget;
  if (!(current instanceof HTMLElement)) return;
  const list = current.closest("ul");
  if (list === null) return;
  const buttons = [...list.querySelectorAll<HTMLElement>("button.ccc-report-row-button")];
  const index = buttons.indexOf(current);
  if (index < 0) return;
  let target = index;
  if (event.key === "ArrowDown") target = Math.min(buttons.length - 1, index + 1);
  else if (event.key === "ArrowUp") target = Math.max(0, index - 1);
  else if (event.key === "Home") target = 0;
  else target = buttons.length - 1;
  event.preventDefault();
  buttons[target]?.focus();
}

function ReadableRowItem(props: {
  readonly row: ReadableRow;
  readonly selected: boolean;
  readonly now: number;
  readonly zone: string;
  readonly onSelect: (noteId: string) => void;
}): VNode {
  const { row } = props;
  const freshness = reportFreshness(row.generatedAt, props.now);
  const freshnessLabel = freshness === "stale" ? "Stale" : "Cached";
  return (
    <li className="ccc-report-row" data-selected={props.selected ? "true" : undefined}>
      <button
        type="button"
        className="ccc-report-row-button"
        aria-current={props.selected ? "true" : undefined}
        onClick={() => props.onSelect(row.noteId)}
        onKeyDown={moveBetweenRows}
      >
        <span className="ccc-clamp-2" title={row.title}>
          <UntrustedText text={row.title} />
        </span>
        <span className="ccc-report-row-meta">
          <RowTime iso={row.generatedAt} now={props.now} zone={props.zone} />
          {" · "}
          <span className="ccc-badge" data-badge={freshness}>
            <span className="ccc-badge-glyph" aria-hidden="true">
              {FRESHNESS_GLYPH[freshness]}
            </span>
            <span className="ccc-visually-hidden">Freshness: </span>
            <span className="ccc-badge-label">{freshnessLabel}</span>
          </span>
          {row.partial ? (
            <>
              {" · "}
              <span className="ccc-badge" data-badge="partial">
                <span className="ccc-badge-glyph" aria-hidden="true">
                  ◈
                </span>
                <span className="ccc-badge-label">Partial</span>
                <span className="ccc-visually-hidden">
                  {` — ${partialRowTail(row.unavailableCount)}`}
                </span>
              </span>
            </>
          ) : null}
          {` · ${sourceCountText(row)} · ${itemsText(row.itemCount)}`}
        </span>
      </button>
    </li>
  );
}

function UnreadableRowItem(props: {
  readonly row: UnreadableRow;
  readonly onOpenNote: (path: string) => void;
}): VNode {
  const metaId = useId();
  return (
    <li className="ccc-report-row" data-unreadable="true">
      <p className="ccc-report-title">
        <ErrorGlyph />
        {UNREADABLE_TITLE}
      </p>
      <p className="ccc-report-row-meta" id={metaId}>
        <span className="ccc-mono">
          <UntrustedText text={props.row.fileName} />
        </span>
        {` · ${UNREADABLE_META}`}
      </p>
      <button
        type="button"
        className="ccc-row-action"
        aria-describedby={metaId}
        onClick={() => props.onOpenNote(props.row.notePath)}
      >
        {OPEN_NOTE_LABEL}
      </button>
    </li>
  );
}

export function ReportList(props: ReportListProps): VNode {
  const reasonId = useId();
  const listRef = useRef<HTMLUListElement | null>(null);
  const { focusRequest, onFocusHandled } = props;

  // After "Show 25 more", focus lands on the first newly loaded row, once.
  useEffect(() => {
    if (focusRequest === null) return;
    const buttons = listRef.current?.querySelectorAll<HTMLElement>("button.ccc-report-row-button");
    const target = buttons?.[focusRequest];
    if (target === undefined) return;
    target.focus();
    onFocusHandled();
  }, [focusRequest, props.rows.length, onFocusHandled]);

  const loading = !props.loaded && props.failure === null;
  const firstLoadFailed = !props.loaded && props.failure !== null;
  const refreshFailed =
    props.loaded &&
    props.failure !== null &&
    props.failure !== "service-disconnected" &&
    props.connected;

  let body: VNode;
  if (loading) {
    body = (
      <>
        <span className="ccc-visually-hidden">{LOADING_REPORTS}</span>
        <span className="ccc-skeleton-line" aria-hidden="true" />
        <span className="ccc-skeleton-line" aria-hidden="true" />
        <span className="ccc-skeleton-line" aria-hidden="true" />
      </>
    );
  } else if (firstLoadFailed) {
    body = (
      <div className="ccc-report-list-error">
        <p>
          <ErrorGlyph />
          {LOAD_ERROR_HEADING}
        </p>
        <p className="ccc-field-help">{LOAD_ERROR_HELP}</p>
        <button
          type="button"
          className="ccc-connect-button"
          data-variant="tertiary"
          onClick={props.onRefresh}
        >
          {REFRESH_REPORTS_LABEL}
        </button>
      </div>
    );
  } else {
    body = (
      <>
        {refreshFailed ? (
          <div className="ccc-report-list-error">
            <p>
              <ErrorGlyph />
              {refreshFailedLine(
                props.loadedAt === null ? "earlier" : formatRelativeTime(props.loadedAt, props.now),
              )}
            </p>
            <button
              type="button"
              className="ccc-connect-button"
              data-variant="tertiary"
              onClick={props.onRefresh}
            >
              {REFRESH_REPORTS_LABEL}
            </button>
          </div>
        ) : null}
        {props.rows.length === 0 ? (
          <div className="ccc-report-list-empty">
            <p className="ccc-report-empty-heading">{EMPTY_REPORTS_HEADING}</p>
            <p className="ccc-research-subline">
              {props.allRunsFailed ? EMPTY_ALL_FAILED : EMPTY_NEVER_RUN}
            </p>
          </div>
        ) : (
          <ul className="ccc-report-list" ref={listRef}>
            {props.rows.map((row) =>
              row.readable ? (
                <ReadableRowItem
                  key={row.noteId}
                  row={row}
                  selected={props.selectedNoteId === row.noteId}
                  now={props.now}
                  zone={props.zone}
                  onSelect={props.onSelect}
                />
              ) : (
                <UnreadableRowItem key={row.notePath} row={row} onOpenNote={props.onOpenNote} />
              ),
            )}
          </ul>
        )}
        {props.hasMore ? (
          <>
            <button
              type="button"
              className="ccc-list-more"
              aria-disabled={props.connected ? undefined : "true"}
              aria-describedby={props.connected ? undefined : reasonId}
              aria-busy={props.loadingMore ? "true" : undefined}
              onClick={() => {
                if (props.connected && !props.loadingMore) props.onShowMore();
              }}
            >
              {SHOW_MORE_LABEL}
            </button>
            {props.connected ? null : (
              <span id={reasonId} className="ccc-research-reason">
                {DISCONNECTED_REASON}
              </span>
            )}
          </>
        ) : null}
      </>
    );
  }

  return (
    <div
      className="ccc-report-list-region"
      aria-busy={loading ? "true" : undefined}
      data-dimmed={props.connected ? undefined : "true"}
    >
      {body}
    </div>
  );
}
