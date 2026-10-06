import {
  TASK_PAGE_SIZE,
  TASK_PRIORITY_DISPLAY,
  TASK_STATUS_DISPLAY,
  type TaskFilter,
  type TaskRow,
} from "@ccc/domain/tasks.js";
import type { ComponentChildren, VNode } from "preact";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  ACCEPT_LABEL,
  acceptName,
  blockedWords,
  CREATE_TASK_LABEL,
  DISCONNECTED_HEADING,
  DISCONNECTED_REASON,
  DISMISS_LABEL,
  dismissName,
  EMPTY_ALL_BODY,
  EMPTY_ALL_HEADING,
  EMPTY_ALL_PROMPT,
  ERROR_HEADING,
  ERROR_HINT,
  FILTER_EMPTY,
  LOADING_LABEL,
  lastValuesLine,
  MARK_DONE_LABEL,
  markDoneName,
  moreLoadedStatus,
  NOTES_EDITABLE_LINE,
  projectEmpty,
  REBUILDING_LINE,
  showingLine,
  showMoreLabel,
  tagOverflow,
} from "./tasks-copy.js";
import { formatTaskDatePhrase } from "./tasks-format.js";

/**
 * The presentational task list (UI-SPEC S3 "List rows", "Destination states"):
 * a `ul` of rows, each with a status and priority meta line, a title button, a
 * date, project and tag line, an optional blocked line and at most one pill
 * group of row actions, then cursor pagination and every destination state.
 *
 * Everything arrives by props: the rows, the connection, staleness and error
 * facts, the owner's clock and zone, and the functions a press may call. The
 * list imports no signal, service client, connector, executor or `obsidian`,
 * reads no clock, and a row action's handler calls only the injected
 * {@link TaskListProps.onAction} for that row (TASK-08, T-06-24). That is what
 * lets the global destination and a project panel share this component and no
 * state (TASK-07).
 *
 * Task titles, project names and tags are untrusted (they may come from email or
 * research processors): they are Preact text children only, with the full text in
 * a `title` attribute, never markup or a link (T-06-25).
 */

/** What a row pill asks for. The host decides what each one writes. */
export type TaskRowAction = "mark-done" | "accept" | "dismiss";

export interface TaskListProps {
  readonly filter: TaskFilter;
  readonly rows: readonly TaskRow[];
  /** The full number of tasks the filter matches, not the page length. */
  readonly total: number;
  readonly selectedId: string | null;
  /** False while the companion service is away: every action is then aria-disabled. */
  readonly connected: boolean;
  /** The owner's clock and zone, so no phrase reads the machine's (UI-SPEC "Number and time formatting"). */
  readonly now: number;
  readonly zone: string;
  /** Project display names by id; untrusted text, rendered as text nodes. */
  readonly projectNames?: Readonly<Record<string, string>> | undefined;
  /** `loading` shows the skeleton, `error` the load failure; default `ready`. */
  readonly status?: "loading" | "ready" | "error" | undefined;
  /** A new page is on its way: the previous rows stay visible, marked busy, with no spinner. */
  readonly busy?: boolean | undefined;
  readonly stale?: boolean | undefined;
  readonly rebuilding?: boolean | undefined;
  /** The Project filter with no project chosen. */
  readonly chooseProject?: boolean | undefined;
  /** The chosen project's display name, for its empty line. */
  readonly projectName?: string | null | undefined;
  /** The whole index is empty: every filter then shows the first-run state. */
  readonly noTasksAtAll?: boolean | undefined;
  /** How long ago the last good values arrived, for the disconnected line. */
  readonly lastReceived?: string | null | undefined;
  readonly hasMore?: boolean | undefined;
  onLoadMore?(): void;
  onCreate?(): void;
  /** The status line of the section: the only live region this list talks to. */
  announce?(text: string): void;
  onSelect(id: string): void;
  /** Resolves when the action is done; a rejection frees the pills and keeps focus where it was. */
  onAction(action: TaskRowAction, row: TaskRow): Promise<void>;
}

/** The pills a row offers, by status: one for an open task, two for a proposed one, none when finished. */
export function rowActionsFor(status: TaskRow["status"]): readonly TaskRowAction[] {
  if (status === "done" || status === "cancelled") return [];
  if (status === "proposed") return ["accept", "dismiss"];
  return ["mark-done"];
}

const ACTION_LABEL: Readonly<Record<TaskRowAction, string>> = {
  "mark-done": MARK_DONE_LABEL,
  accept: ACCEPT_LABEL,
  dismiss: DISMISS_LABEL,
};

function actionName(action: TaskRowAction, title: string): string {
  switch (action) {
    case "mark-done":
      return markDoneName(title);
    case "accept":
      return acceptName(title);
    case "dismiss":
      return dismissName(title);
  }
}

/** The acted-on row, held until focus has left a control that no longer exists. */
interface PendingMove {
  readonly id: string;
  /** The ids in list order when the pill was pressed. */
  readonly order: readonly string[];
  readonly pill: HTMLElement | null;
  readonly rowsAtPress: readonly TaskRow[];
}

/** The ids on screen when Show more was pressed; the first row that is not among them gets focus. */
interface PendingLoad {
  readonly known: ReadonlySet<string>;
}

function focusIsLost(pill: HTMLElement | null): boolean {
  const doc = pill?.ownerDocument ?? document;
  const active = doc.activeElement;
  return active === null || active === doc.body || active === pill || !active.isConnected;
}

/** `Due today · example-project · #writing #review`: the segments that exist, joined by a middle dot. */
function DetailLine(props: {
  readonly row: TaskRow;
  readonly now: number;
  readonly zone: string;
  readonly projectNames: Readonly<Record<string, string>> | undefined;
}): VNode | null {
  const { row } = props;
  const segments: ComponentChildren[] = [];

  const phrase = formatTaskDatePhrase(row, props.now, props.zone);
  if (phrase !== null) {
    segments.push(
      <span className="ccc-task-date" data-overdue={phrase.overdue ? "true" : undefined}>
        {phrase.text}
      </span>,
    );
  }

  const project = row.projectId === undefined ? undefined : props.projectNames?.[row.projectId];
  if (project !== undefined && project.length > 0) {
    segments.push(<span className="ccc-task-project">{project}</span>);
  }

  const hidden = Math.max(0, row.tagCount - row.tags.length);
  if (row.tags.length > 0 || hidden > 0) {
    segments.push(
      <span className="ccc-task-tags">
        {row.tags.map((tag, index) => (
          <span key={tag}>
            {index > 0 ? " " : null}
            <span className="ccc-task-tag" title={tag}>
              #{tag}
            </span>
          </span>
        ))}
        {hidden > 0 ? (
          <>
            {row.tags.length > 0 ? " " : null}
            <span className="ccc-task-tag-more">{tagOverflow(hidden)}</span>
          </>
        ) : null}
      </span>,
    );
  }

  if (segments.length === 0) return null;
  return (
    <p className="ccc-list-meta ccc-task-row-meta" data-line="details">
      {segments.map((segment, index) => (
        // The segments are positional and never reorder: their count and order are fixed per row.
        <span key={index}>
          {index > 0 ? " · " : null}
          {segment}
        </span>
      ))}
    </p>
  );
}

export function TaskList(props: TaskListProps): VNode {
  const { rows, total, selectedId, connected, filter } = props;
  const status = props.status ?? "ready";
  const reasonId = useId();
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  const titleButtons = useRef(new Map<string, HTMLButtonElement>());
  const heading = useRef<HTMLHeadingElement | null>(null);
  const pending = useRef<PendingMove | null>(null);
  const loading = useRef<PendingLoad | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // After every commit: if a pressed row left, or its pill vanished with its
  // status, and nothing else holds focus, move focus to the next row's title
  // button, else the previous one, else the list heading. Focus never stays on
  // a removed control, and focus the owner moved elsewhere is never taken back.
  useLayoutEffect(() => {
    const move = pending.current;
    if (move === null) return;
    const removed = !rows.some((row) => row.id === move.id);
    const pillGone = move.pill !== null && !move.pill.isConnected;
    if (!removed && !pillGone) {
      if (rows !== move.rowsAtPress) pending.current = null;
      return;
    }
    pending.current = null;
    if (!focusIsLost(move.pill)) return;
    const present = new Set(rows.map((row) => row.id));
    const at = move.order.indexOf(move.id);
    const after = move.order.slice(at + 1).filter((id) => present.has(id));
    const before = move.order
      .slice(0, Math.max(0, at))
      .filter((id) => present.has(id))
      .reverse();
    const target = [...after, ...before]
      .map((id) => titleButtons.current.get(id))
      .find((button) => button !== undefined);
    (target ?? heading.current)?.focus();
  });

  // After Show more: the page arrived when rows we did not have are appended.
  // Focus goes to the first new title and the section's status line says how
  // many came. A list that was replaced (a chip change) is not a page.
  useLayoutEffect(() => {
    const load = loading.current;
    if (load === null) return;
    const added = rows.filter((row) => !load.known.has(row.id));
    if (added.length === 0) return;
    loading.current = null;
    const first = rows[0];
    if (first === undefined || !load.known.has(first.id)) return;
    const target = added[0];
    if (target !== undefined) titleButtons.current.get(target.id)?.focus();
    props.announce?.(moreLoadedStatus(added.length));
  });

  async function press(
    action: TaskRowAction,
    row: TaskRow,
    pill: HTMLElement | null,
  ): Promise<void> {
    if (!connected || inFlight.current.has(row.id)) return;
    // Busy before any await: a second press of this row is ignored from here on.
    inFlight.current.add(row.id);
    setBusyIds(new Set(inFlight.current));
    const move: PendingMove = {
      id: row.id,
      order: rows.map((item) => item.id),
      pill,
      rowsAtPress: rows,
    };
    pending.current = move;
    try {
      await props.onAction(action, row);
    } catch {
      if (pending.current === move) pending.current = null;
    } finally {
      inFlight.current.delete(row.id);
      if (mounted.current) setBusyIds(new Set(inFlight.current));
    }
  }

  function loadMore(): void {
    if (!connected) return;
    loading.current = { known: new Set(rows.map((row) => row.id)) };
    props.onLoadMore?.();
  }

  function create(): void {
    if (!connected) return;
    props.onCreate?.();
  }

  /** Down and Up move between title buttons, Home and End jump; none of them scrolls smoothly. */
  function handleKeyDown(event: KeyboardEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.classList.contains("ccc-task-title")) return;
    const buttons = rows
      .map((row) => titleButtons.current.get(row.id))
      .filter((button): button is HTMLButtonElement => button !== undefined);
    const index = buttons.indexOf(target as HTMLButtonElement);
    if (index < 0) return;
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = Math.min(index + 1, buttons.length - 1);
        break;
      case "ArrowUp":
        next = Math.max(index - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = buttons.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    buttons[next]?.focus();
  }

  const rowsBusy = props.busy === true || props.rebuilding === true;

  function renderBody(): VNode {
    if (status === "error") {
      return (
        <div className="ccc-task-list-error">
          <p className="ccc-state-heading">
            <span className="ccc-error-glyph" aria-hidden="true">
              ▲
            </span>{" "}
            {ERROR_HEADING}
          </p>
          <p className="ccc-state-body">{ERROR_HINT}</p>
        </div>
      );
    }
    if (status === "loading") {
      return (
        <div className="ccc-task-skeleton" aria-busy="true">
          <div className="ccc-skeleton-line" aria-hidden="true" />
          <div className="ccc-skeleton-line" aria-hidden="true" />
          <div className="ccc-skeleton-line" aria-hidden="true" />
          <span className="ccc-visually-hidden">{LOADING_LABEL}</span>
        </div>
      );
    }
    if (rows.length === 0) return renderEmpty();
    return renderRows();
  }

  function renderEmpty(): VNode {
    const firstRun = props.noTasksAtAll === true || filter === "all";
    let lines: { readonly heading: string; readonly next: string };
    if (firstRun) lines = { heading: EMPTY_ALL_HEADING, next: EMPTY_ALL_BODY };
    else if (filter === "project" && props.chooseProject !== true) {
      lines = projectEmpty(props.projectName ?? "this project");
    } else lines = FILTER_EMPTY[filter];
    const offersCreate =
      firstRun || filter === "today" || (filter === "project" && props.chooseProject !== true);
    return (
      <div
        className="ccc-task-list-empty"
        aria-busy={props.busy === true ? "true" : undefined}
        data-dimmed={connected ? undefined : "true"}
      >
        <h3 className="ccc-state-heading" tabIndex={-1} ref={heading}>
          {lines.heading}
        </h3>
        <p className="ccc-state-body">{lines.next}</p>
        {firstRun && <p className="ccc-state-body">{EMPTY_ALL_PROMPT}</p>}
        {offersCreate && (
          <button
            type="button"
            className="ccc-connect-button ccc-task-create"
            aria-disabled={connected ? undefined : "true"}
            aria-describedby={connected ? undefined : reasonId}
            onClick={create}
          >
            {CREATE_TASK_LABEL}
          </button>
        )}
      </div>
    );
  }

  function renderRows(): VNode {
    const remaining = total - rows.length;
    return (
      <>
        <h3 className="ccc-task-list-heading" tabIndex={-1} ref={heading}>
          {showingLine(rows.length, total)}
        </h3>
        <ul
          className="ccc-task-list"
          aria-busy={rowsBusy ? "true" : undefined}
          data-dimmed={connected ? undefined : "true"}
          onKeyDown={handleKeyDown}
        >
          {rows.map((row) => {
            const display = TASK_STATUS_DISPLAY[row.status];
            const priority =
              row.priority === undefined ? null : TASK_PRIORITY_DISPLAY[row.priority];
            const actions = rowActionsFor(row.status);
            const busy = busyIds.has(row.id);
            const selected = row.id === selectedId;
            const finished = row.status === "done" || row.status === "cancelled";
            return (
              <li
                key={row.id}
                className="ccc-task-row"
                data-task-id={row.id}
                data-status={row.status}
                data-selected={selected ? "true" : undefined}
                data-busy={busy ? "true" : undefined}
              >
                <p className="ccc-list-meta ccc-task-row-meta" data-line="status">
                  <span className="ccc-task-status">
                    <span className="ccc-task-glyph" aria-hidden="true">
                      {display.glyph}
                    </span>{" "}
                    <span>{display.label}</span>
                  </span>
                  {priority !== null && (
                    <>
                      {" · "}
                      <span className="ccc-task-priority">
                        {priority.glyph !== null && (
                          <>
                            <span className="ccc-task-glyph" aria-hidden="true">
                              {priority.glyph}
                            </span>{" "}
                          </>
                        )}
                        <span>{priority.label}</span>
                      </span>
                    </>
                  )}
                </p>
                <button
                  type="button"
                  className="ccc-task-title"
                  title={row.title}
                  aria-current={selected ? "true" : undefined}
                  ref={(element) => {
                    if (element === null) titleButtons.current.delete(row.id);
                    else titleButtons.current.set(row.id, element);
                  }}
                  onClick={() => props.onSelect(row.id)}
                >
                  <span className="ccc-clamp-2">{row.title}</span>
                </button>
                {actions.length > 0 && (
                  <div className="ccc-task-row-actions">
                    {actions.map((action) => (
                      <button
                        key={action}
                        type="button"
                        className="ccc-task-action"
                        data-action={action}
                        aria-label={actionName(action, row.title)}
                        aria-busy={busy ? "true" : undefined}
                        aria-disabled={busy || !connected ? "true" : undefined}
                        aria-describedby={connected ? undefined : reasonId}
                        onClick={(event) => void press(action, row, event.currentTarget)}
                      >
                        {ACTION_LABEL[action]}
                      </button>
                    ))}
                  </div>
                )}
                <DetailLine
                  row={row}
                  now={props.now}
                  zone={props.zone}
                  projectNames={props.projectNames}
                />
                {!finished && row.unmetDependencies > 0 && (
                  <p className="ccc-task-row-blocked" data-line="blocked">
                    <span className="ccc-task-glyph" aria-hidden="true">
                      {TASK_STATUS_DISPLAY.blocked.glyph}
                    </span>{" "}
                    {blockedWords(row.unmetDependencies)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        {props.hasMore === true && (
          <button
            type="button"
            className="ccc-list-more ccc-task-more"
            aria-disabled={connected ? undefined : "true"}
            aria-describedby={connected ? undefined : reasonId}
            onClick={loadMore}
          >
            {showMoreLabel(remaining > 0 ? Math.min(TASK_PAGE_SIZE, remaining) : TASK_PAGE_SIZE)}
          </button>
        )}
      </>
    );
  }

  return (
    <div
      className="ccc-task-list-region"
      data-filter={filter}
      data-stale={props.stale === true ? "true" : undefined}
    >
      {!connected && (
        <div className="ccc-task-list-notice">
          <p className="ccc-state-heading">{DISCONNECTED_HEADING}</p>
          <p className="ccc-state-body">{lastValuesLine(props.lastReceived ?? null)}</p>
          <p id={reasonId} className="ccc-state-body">
            {DISCONNECTED_REASON}
          </p>
          <p className="ccc-state-body">{NOTES_EDITABLE_LINE}</p>
        </div>
      )}
      {props.rebuilding === true && <p className="ccc-list-meta">{REBUILDING_LINE}</p>}
      {renderBody()}
    </div>
  );
}
