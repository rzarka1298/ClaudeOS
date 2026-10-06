// Deep submodule imports, not the `@ccc/domain` barrel (05-06 deviation,
// Rule 3): the barrel's `index.ts` does `export * from` every domain module,
// including `path-containment.ts` (`node:fs`/`node:path`, genuinely
// Node-only). The real plugin bundle is `platform: "node"` and never sees
// this, but the visual-regression harness bundles for an actual browser
// (`platform: "browser"`, D-21) and fails to resolve those built-ins the
// moment anything imports from the barrel. Importing the two specific
// submodules this file needs sidesteps the barrel's `export *` chain
// entirely, and domain's `package.json` "exports" map (`./*.js`) grew a
// wildcard subpath to make this a supported import shape.

import type { RunState } from "@ccc/domain/run.js";
import { RUN_STATE_DISPLAY, type SessionView, sessionDisplayName } from "@ccc/domain/session.js";
import type { VNode } from "preact";
import type {
  HeroMetric,
  QuickActionDescriptor,
  WidgetBodyProps,
  WidgetDefinition,
} from "./contract.js";
import { formatDuration } from "./duration.js";
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
 * A row's elapsed text. A `stale` Run's duration is bounded by its last known
 * activity, never by `now` — inventing elapsed time past the last evidence
 * would be exactly the guess the data-integrity rule forbids (R-22), so it
 * reads `At least {duration}`.
 */
function elapsedText(row: SessionView, nowMs: number): string {
  if (row.state === "stale") {
    const lastKnownMs = Date.parse(row.lastActivityAt ?? row.startedAt);
    const startedMs = Date.parse(row.startedAt);
    return `At least ${formatDuration(Math.max(0, lastKnownMs - startedMs))}`;
  }
  const endMs = row.endedAt !== null ? Date.parse(row.endedAt) : nowMs;
  return formatDuration(Math.max(0, endMs - Date.parse(row.startedAt)));
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

/**
 * Row states whose one action is Focus, and the ones whose one action is
 * Resume (UI-SPEC S1 row action table). `queued` and every state without a
 * Claude session id have no action at all — {@link rowActionDescriptor}
 * checks the session id first, so both rules apply uniformly.
 */
const FOCUSABLE_STATES: ReadonlySet<RunState> = new Set([
  "running",
  "waiting-for-approval",
  "starting",
]);
const RESUMABLE_STATES: ReadonlySet<RunState> = new Set([
  "stale",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * The row's one descriptor, or `null` for no action (UI-SPEC S1 row action
 * table). A descriptor is DATA (C-11): the row emits it to `onQuickAction`
 * and executes nothing itself.
 */
function rowActionDescriptor(row: SessionView): QuickActionDescriptor | null {
  if (row.claudeSessionId === null) return null;
  if (FOCUSABLE_STATES.has(row.state)) {
    return {
      id: `session-focus-${row.runId}`,
      label: "Focus",
      capability: "session:focus",
      target: { runId: row.runId },
    };
  }
  if (RESUMABLE_STATES.has(row.state)) {
    return {
      id: `session-resume-${row.runId}`,
      label: "Resume",
      capability: "session:resume",
      target: { runId: row.runId },
    };
  }
  return null;
}

/** `Focus terminal for {name}` or `Resume {name}` (UI-SPEC S1 row action table). */
function rowActionLabel(row: SessionView): string {
  const name = sessionDisplayName(row);
  return FOCUSABLE_STATES.has(row.state) ? `Focus terminal for ${name}` : `Resume ${name}`;
}

function ActiveSessionsBody({
  data,
  size,
  onNavigate,
  onQuickAction,
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
      renderAction={rowActionDescriptor}
      renderActionLabel={rowActionLabel}
      onAction={onQuickAction}
      onSelectRow={(row) => onNavigate?.("agent-runs", { runId: row.runId })}
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
