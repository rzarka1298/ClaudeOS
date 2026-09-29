import { RUN_STATE_DISPLAY, type SessionView, sessionDisplayName } from "@ccc/domain";
import type { VNode } from "preact";
import type { HeroMetric, WidgetBodyProps, WidgetDefinition } from "./contract.js";
import { ListBody } from "./list-body.js";
import { formatRelativeTime } from "./relative-time.js";

/**
 * The Active Claude sessions hero card (UI-SPEC S1, D-50). Moved out of
 * `panels.tsx`'s Phase 3 placeholder section 2; `panels.tsx` now only
 * re-exports {@link activeSessionsWidget} and {@link ActiveSessionsData} so
 * `registry.ts` needs no change.
 */

/**
 * The hero's ready payload: every row `session-signals.ts`'s
 * `activeSessionsStateFor` has already filtered to the visible window and
 * ordered (UI-SPEC "Row list"). `nowMs` is the frame's own clock tick, so the
 * body's relative-time and duration text never reads `Date.now()` directly.
 */
export interface ActiveSessionsData {
  readonly sessions: readonly SessionView[];
  readonly nowMs: number;
}

/**
 * The hero head's numeral, caption, meter and screen-reader text (UI-SPEC
 * "Metric derivation"). Zero `running`/`waiting-for-approval` sessions omits
 * the meter (`share: null`) — the empty presentation renders this same
 * function over an empty row list, which is what gives it `0` rather than a
 * bespoke empty-only string (UI Considerations E1).
 */
export function activeSessionsMetric(data: ActiveSessionsData): HeroMetric {
  let runningOrWaiting = 0;
  let waiting = 0;
  let unknown = 0;
  for (const session of data.sessions) {
    if (session.state === "running" || session.state === "waiting-for-approval") {
      runningOrWaiting += 1;
    }
    if (session.state === "waiting-for-approval") waiting += 1;
    if (session.state === "stale") unknown += 1;
  }
  return {
    value: runningOrWaiting,
    caption: `${waiting} waiting for approval · ${unknown} unknown`,
    share: runningOrWaiting === 0 ? null : { value: waiting, max: runningOrWaiting },
    srLabel: `${runningOrWaiting} active sessions, running or waiting for approval`,
  };
}

/**
 * `{s} s` under a minute, `{m} min` under an hour, else `{h} h {m} min`
 * (UI-SPEC "Number and time formatting"). Task 2 extracts this into its own
 * `duration.ts` module (05-13 reuses it); Task 1 keeps it local to the one
 * caller it has so far.
 */
function formatDurationMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours} h ${minutes} min`;
}

/**
 * A row's elapsed text. A `stale` Run's duration is bounded by its last known
 * activity, never by `now` — inventing elapsed time past the last evidence
 * would be exactly the guess the data-integrity rule forbids (R-22), so it
 * reads `At least {duration}`.
 */
function elapsedText(row: SessionView, nowMs: number): string {
  if (row.state === "stale") {
    const lastKnownMs = Date.parse(row.lastActivityAt ?? row.startedAt);
    const startedMs = Date.parse(row.startedAt);
    return `At least ${formatDurationMs(Math.max(0, lastKnownMs - startedMs))}`;
  }
  const endMs = row.endedAt !== null ? Date.parse(row.endedAt) : nowMs;
  return formatDurationMs(Math.max(0, endMs - Date.parse(row.startedAt)));
}

/** `{glyph} {label} · {model, when reported} · {elapsed} · active {relative}` (UI-SPEC "Row list"). */
function rowMeta(row: SessionView, nowMs: number): string {
  const display = RUN_STATE_DISPLAY[row.state];
  const parts = [`${display.glyph} ${display.label}`];
  if (row.model !== null && row.model.trim().length > 0) parts.push(row.model);
  parts.push(elapsedText(row, nowMs));
  parts.push(`active ${formatRelativeTime(row.lastActivityAt ?? row.startedAt, nowMs)}`);
  return parts.join(" · ");
}

function ActiveSessionsBody({
  data,
  size,
  onNavigate,
}: WidgetBodyProps<ActiveSessionsData>): VNode | null {
  return (
    <ListBody<SessionView>
      rows={data.sessions}
      size={size}
      keyOf={(row) => row.runId}
      renderPrimary={(row) => `${row.projectName ?? "Unclassified"} · ${sessionDisplayName(row)}`}
      renderMeta={(row) => rowMeta(row, data.nowMs)}
      moreDestination="agent-runs"
      onMore={onNavigate}
    />
  );
}

export const activeSessionsWidget: WidgetDefinition<ActiveSessionsData> = {
  id: "active-sessions",
  title: "Active Claude sessions",
  description: "Running, waiting, completed and failed sessions.",
  dataKeys: [{ key: "sessions.active", transport: "service", sourceLabel: "Claude Code hooks" }],
  refresh: { kind: "event-driven" },
  minSize: "medium",
  preferredSize: "tall",
  featureFlag: "widget.active-sessions",
  quickActions: [],
  renderBody: ActiveSessionsBody,
  renderEmpty: () => null,
  variant: { kind: "hero", metric: activeSessionsMetric },
};
