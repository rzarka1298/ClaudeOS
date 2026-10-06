import {
  TASK_PRIORITY_DISPLAY,
  TASK_STATUS_DISPLAY,
  type TaskFilter,
  type TaskRow,
} from "@ccc/domain/tasks.js";
import type { VNode } from "preact";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  ACCEPT_LABEL,
  acceptName,
  DISCONNECTED_REASON,
  DISMISS_LABEL,
  dismissName,
  MARK_DONE_LABEL,
  markDoneName,
  showingLine,
} from "./tasks-copy.js";

/**
 * The presentational task list (UI-SPEC S3 "List rows"): a `ul` of rows, each
 * with a status and priority meta line, a title button and at most one pill
 * group of row actions. Everything arrives by props: the rows, the connection
 * flag and the two functions a press may call. The list imports no signal,
 * service client, connector, executor or `obsidian`, and a row action's handler
 * calls only the injected {@link TaskListProps.onAction} for that row
 * (TASK-08, T-06-24). That is what lets the global destination and a project
 * panel share this component and no state (TASK-07).
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

/** The acted-on row, remembered until focus has left a control that no longer exists. */
interface PendingMove {
  readonly id: string;
  /** The ids in list order when the pill was pressed. */
  readonly order: readonly string[];
  readonly pill: HTMLElement | null;
  readonly rowsAtPress: readonly TaskRow[];
}

function focusIsLost(pill: HTMLElement | null): boolean {
  const doc = pill?.ownerDocument ?? document;
  const active = doc.activeElement;
  return active === null || active === doc.body || active === pill || !active.isConnected;
}

export function TaskList(props: TaskListProps): VNode {
  const { rows, total, selectedId, connected } = props;
  const reasonId = useId();
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  const titleButtons = useRef(new Map<string, HTMLButtonElement>());
  const heading = useRef<HTMLHeadingElement | null>(null);
  const pending = useRef<PendingMove | null>(null);

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

  return (
    <div className="ccc-task-list-region" data-filter={props.filter}>
      <h3 className="ccc-task-list-heading" tabIndex={-1} ref={heading}>
        {showingLine(rows.length, total)}
      </h3>
      {!connected && (
        <p id={reasonId} className="ccc-list-meta ccc-task-list-reason">
          {DISCONNECTED_REASON}
        </p>
      )}
      <ul className="ccc-task-list">
        {rows.map((row) => {
          const status = TASK_STATUS_DISPLAY[row.status];
          const priority = row.priority === undefined ? null : TASK_PRIORITY_DISPLAY[row.priority];
          const actions = rowActionsFor(row.status);
          const busy = busyIds.has(row.id);
          const selected = row.id === selectedId;
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
                    {status.glyph}
                  </span>{" "}
                  <span>{status.label}</span>
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
            </li>
          );
        })}
      </ul>
    </div>
  );
}
