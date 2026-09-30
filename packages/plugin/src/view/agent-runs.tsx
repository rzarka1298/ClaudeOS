// Deep submodule imports, not the `@ccc/domain` barrel (05-06 deviation,
// Rule 3, mirrored throughout `widgets/`): the barrel's `export *` chain
// pulls in `path-containment.ts` (`node:fs`/`node:path`), which the visual
// harness's browser-platform bundle cannot resolve.
import {
  NOT_REPORTED,
  RUN_STATE_DISPLAY,
  type SessionView,
  STALE_RUN_EXPLANATION,
  sessionDisplayName,
} from "@ccc/domain/session.js";
import type { VNode } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import { connectionState } from "../connection-state.js";
import { activeSessionsWidget } from "../widgets/active-sessions.js";
import type { QuickActionDescriptor } from "../widgets/contract.js";
import { formatDuration } from "../widgets/duration.js";
import { WidgetFooter } from "../widgets/footer.js";
import type { CardPresentation, FooterModel } from "../widgets/presentation.js";
import { resolveCardPresentation } from "../widgets/presentation.js";
import { formatAbsoluteTime, formatRelativeTime } from "../widgets/relative-time.js";
import { activeSessionsState, sessionsById } from "../widgets/session-signals.js";
import { formatMonthDay, formatTimeOfDay } from "../widgets/usage-format.js";
import { groupSessions, RECENT_PAGE_SIZE, selectedRunId } from "./agent-runs-state.js";

/**
 * The Agent runs destination (UI-SPEC S3, D-52). Replaces the placeholder
 * `<p>{description}</p>` in the `agent-runs` tabpanel.
 *
 * This is a leaf, not a widget: it reads `connectionState`, `sessionsById`
 * and `claudeIntegration` itself (Pattern 8), rather than being handed a
 * `WidgetState` prop, because the destination shows the FULL session
 * history (Active/Recent/Unclassified, R-08) — a superset of the hero's
 * 60-minute-windowed `ActiveSessionsData`. The destination-level banner
 * (setup, telemetry-paused, disconnected, error) is still derived from the
 * SAME {@link activeSessionsState}/{@link resolveCardPresentation} the hero
 * card uses, so the two surfaces can never disagree about whether Claude
 * Code hooks are installed or the transport is down.
 */

const GROUP_HEADING = {
  active: "Active",
  recent: "Recent",
  unclassified: "Unclassified",
} as const;

const GROUP_CAPTION = {
  active: "Active sessions",
  recent: "Recent sessions",
  unclassified: "Unclassified sessions",
} as const;

const GROUP_EMPTY_TEXT = {
  active: "No sessions are running right now.",
  recent: "No sessions ended in the last 7 days.",
  unclassified: "Every recent session belongs to a registered project.",
} as const;

type GroupKey = keyof typeof GROUP_HEADING;

const LAUNCH_SOURCE_LABEL: Readonly<Record<string, string>> = {
  terminal: "Terminal",
  dashboard: "Dashboard",
  external: "External",
};

/** `Mon D, h:mm AM` (UI-SPEC "Sessions table" column 7). Reuses the same two
 * `Intl` formatters `claude-usage.tsx` uses, so the calendar and time-of-day
 * rendering can never disagree between the two surfaces. */
function formatStarted(iso: string, nowMs: number): string {
  return `${formatMonthDay(iso, nowMs)}, ${formatTimeOfDay(iso)}`;
}

/** A row's elapsed text (UI-SPEC "Sessions table" column 8, R-22): a stale
 * Run's duration is bounded by its last known activity, never by `now` —
 * mirrors `active-sessions.tsx`'s private `elapsedText`, duplicated here
 * (not exported there) rather than reaching across widget/view boundary. */
function durationText(session: SessionView, nowMs: number): string {
  if (session.state === "stale") {
    const lastKnownMs = Date.parse(session.lastActivityAt ?? session.startedAt);
    const startedMs = Date.parse(session.startedAt);
    return `At least ${formatDuration(Math.max(0, lastKnownMs - startedMs))}`;
  }
  const endMs = session.endedAt !== null ? Date.parse(session.endedAt) : nowMs;
  return formatDuration(Math.max(0, endMs - Date.parse(session.startedAt)));
}

/** `{glyph} {label}`, with running appending ` · Working`/` · Idle` (UI-SPEC
 * "Sessions table" column 2). */
function stateCellText(session: SessionView): string {
  const display = RUN_STATE_DISPLAY[session.state];
  const base = `${display.glyph} ${display.label}`;
  if (session.state === "running" && session.activity !== null) {
    return `${base} · ${session.activity === "working" ? "Working" : "Idle"}`;
  }
  return base;
}

function modelCellText(session: SessionView): string {
  if (session.model === null || session.model.trim().length === 0) return NOT_REPORTED;
  return session.effort !== null && session.effort.trim().length > 0
    ? `${session.model} · ${session.effort}`
    : session.model;
}

function launchSourceCellText(session: SessionView): string {
  if (session.launchSource === null) return NOT_REPORTED;
  return LAUNCH_SOURCE_LABEL[session.launchSource] ?? NOT_REPORTED;
}

interface SessionsTableProps {
  readonly group: GroupKey;
  readonly rows: readonly SessionView[];
  readonly shown: number;
  readonly onShowMore: () => void;
  readonly nowMs: number;
  readonly selected: string | null;
  readonly onSelect: (runId: string) => void;
}

function SkeletonRows(): VNode {
  return (
    <>
      {[0, 1, 2].map((row) => (
        <div className="ccc-skeleton-line" key={row} />
      ))}
    </>
  );
}

function SessionsTable({
  group,
  rows,
  shown,
  onShowMore,
  nowMs,
  selected,
  onSelect,
}: SessionsTableProps): VNode {
  const visible = rows.slice(0, shown);
  const hidden = rows.length - visible.length;

  if (rows.length === 0) {
    return <p className="ccc-state-body">{GROUP_EMPTY_TEXT[group]}</p>;
  }

  return (
    <>
      <table className="ccc-agent-runs-table">
        <caption className="ccc-visually-hidden">{GROUP_CAPTION[group]}</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">State</th>
            <th scope="col" data-priority="secondary">
              Project
            </th>
            <th scope="col" data-priority="secondary">
              Last activity
            </th>
            <th scope="col" data-priority="tertiary">
              Model
            </th>
            <th scope="col" data-priority="tertiary">
              Launch source
            </th>
            <th scope="col" data-priority="tertiary">
              Started
            </th>
            <th scope="col" data-priority="tertiary">
              Duration
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((session) => {
            const name = sessionDisplayName(session);
            const isSelected = session.runId === selected;
            const lastActivityIso = session.lastActivityAt ?? session.startedAt;
            return (
              <tr key={session.runId} data-selected={isSelected ? "true" : undefined}>
                <th scope="row">
                  <button
                    type="button"
                    className="ccc-session-row-link ccc-clamp-2"
                    title={name}
                    aria-current={isSelected ? "true" : undefined}
                    onClick={() => onSelect(session.runId)}
                  >
                    {name}
                  </button>
                </th>
                <td>{stateCellText(session)}</td>
                <td data-priority="secondary">{session.projectName ?? "Unclassified"}</td>
                <td data-priority="secondary">
                  <time dateTime={lastActivityIso} title={formatAbsoluteTime(lastActivityIso)}>
                    {formatRelativeTime(lastActivityIso, nowMs)}
                  </time>
                </td>
                <td data-priority="tertiary">{modelCellText(session)}</td>
                <td data-priority="tertiary">{launchSourceCellText(session)}</td>
                <td data-priority="tertiary">{formatStarted(session.startedAt, nowMs)}</td>
                <td data-priority="tertiary">{durationText(session, nowMs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {hidden > 0 && (
        <button type="button" className="ccc-list-more" onClick={onShowMore}>
          {`Show ${Math.min(RECENT_PAGE_SIZE, hidden)} more`}
        </button>
      )}
    </>
  );
}

/**
 * Task 1's detail-pane slot (UI-SPEC S3 "Detail pane" heading/state/stale
 * explanation only). Task 2 replaces this with the full `DetailPane`
 * (controls, fields, per-session usage) from `agent-runs-detail.tsx`; the
 * focus/selection mechanics built here (the heading ref, `tabIndex={-1}`)
 * carry over unchanged.
 */
function DetailPaneSlot({
  session,
  headingRef,
}: {
  readonly session: SessionView | null;
  readonly headingRef: { current: HTMLHeadingElement | null };
}): VNode {
  if (session === null) {
    return (
      <div className="ccc-detail-pane">
        <p className="ccc-state-body">Select a session to see its details and controls.</p>
      </div>
    );
  }
  const display = RUN_STATE_DISPLAY[session.state];
  return (
    <div className="ccc-detail-pane">
      <h3
        ref={(el) => {
          headingRef.current = el;
        }}
        tabIndex={-1}
      >
        {sessionDisplayName(session)}
      </h3>
      <p className="ccc-state-body">
        {display.glyph} {display.label}
      </p>
      {session.state === "stale" && <p className="ccc-list-meta">{STALE_RUN_EXPLANATION}</p>}
    </div>
  );
}

/** The banner copy shared with the S1 hero's setup/telemetry states
 * (UI-SPEC "Destination states"). Duplicated from `frame.tsx`'s private
 * `PERMISSION_COPY`/`UNAVAILABLE_COPY` tables: this is a different
 * rendering context (a destination banner, not a card body), so the two
 * copies are independent literals rather than a shared import across the
 * view/widget boundary. */
const SETUP_HEADING = "Claude Code hooks aren't installed";
const SETUP_BODY =
  "Install the optional hook package to see your Claude Code sessions here. Obsidian settings → Claude command center → Claude shows the command to run.";
const SETUP_BUTTON = "Set up Claude hooks";

const TELEMETRY_PAUSED_HEADING = "Session tracking paused";
const VERSION_SHAPE = /^\d{1,6}(?:\.\d{1,6}){0,3}$/;
function claudeCodeVersion(version: string): string {
  return VERSION_SHAPE.test(version) ? `Claude Code ${version}` : "Your Claude Code version";
}

function Banner({
  presentation,
  onSetUpHooks,
  now,
}: {
  readonly presentation: CardPresentation;
  readonly onSetUpHooks: () => void;
  readonly now: number;
}): VNode | null {
  switch (presentation.kind) {
    case "permission-required":
      return (
        <div className="ccc-agent-runs-banner">
          <p className="ccc-state-heading">{SETUP_HEADING}</p>
          <p className="ccc-state-body">{SETUP_BODY}</p>
          <button type="button" className="ccc-connect-button" onClick={onSetUpHooks}>
            {SETUP_BUTTON}
          </button>
        </div>
      );
    case "unavailable": {
      const reason = presentation.reason;
      const version =
        reason !== undefined && "version" in reason && typeof reason.version === "string"
          ? reason.version
          : "";
      const body =
        reason?.code === "session-telemetry-changed"
          ? `${claudeCodeVersion(version)} reports sessions in a format this build doesn't recognise. States below come from process checks only and may be incomplete.`
          : reason?.code === "claude-version-unsupported"
            ? `${claudeCodeVersion(version)} is older than the minimum supported 2.1.214.`
            : null;
      if (body === null) return null;
      return (
        <div className="ccc-agent-runs-banner">
          <p className="ccc-state-heading">{TELEMETRY_PAUSED_HEADING}</p>
          <p className="ccc-state-body">{body}</p>
        </div>
      );
    }
    case "disconnected":
      return (
        <div className="ccc-agent-runs-banner">
          <p className="ccc-state-heading">Service disconnected</p>
          <p className="ccc-state-body">
            {presentation.lastGood?.observedAt == null
              ? "They may be out of date."
              : `Showing the last values received ${formatRelativeTime(presentation.lastGood.observedAt, now)}. They may be out of date.`}
          </p>
        </div>
      );
    default:
      return null;
  }
}

export interface AgentRunsProps {
  readonly now: number;
  readonly onQuickAction?: ((descriptor: QuickActionDescriptor) => void) | undefined;
}

export function AgentRuns({ now, onQuickAction }: AgentRunsProps): VNode {
  const state = activeSessionsState.value;
  const connection: ConnectionState = connectionState.value;
  const presentation: CardPresentation = resolveCardPresentation(
    state,
    connection,
    activeSessionsWidget.dataKeys,
  );

  const allSessions = [...sessionsById.value.values()];
  const groups = groupSessions(allSessions, now);
  const selected = selectedRunId.value;
  const selectedSession = selected === null ? null : (sessionsById.value.get(selected) ?? null);

  const [recentShown, setRecentShown] = useState(RECENT_PAGE_SIZE);
  const [unclassifiedShown, setUnclassifiedShown] = useState(RECENT_PAGE_SIZE);

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (selected !== null) headingRef.current?.focus();
    // Re-runs on every genuine selection change (a table row click, or the
    // hero row's `focusDestination(id, { runId })`) and on this component's
    // own mount — landing back on Agent runs with a stale selection already
    // set re-focuses the detail heading, which is the same "go straight to
    // what's selected" behaviour the mount case and the change case share.
    // `selected` is the one dependency this effect reacts to; `headingRef`
    // is a ref and stable by contract.
  }, [selected]);

  function handleSetUpHooks(): void {
    onQuickAction?.({
      id: "connect-claude-hooks",
      label: "Connect Claude Code hooks",
      capability: "connect:claude-hooks",
    });
  }

  const footerModel: FooterModel =
    presentation.kind === "loading"
      ? { observedAt: null, freshness: null, partiality: null, sources: [] }
      : presentation.kind === "disconnected"
        ? (presentation.lastGood ?? {
            observedAt: null,
            freshness: null,
            partiality: null,
            sources: [],
          })
        : presentation.footer;

  if (presentation.kind === "error") {
    return (
      <div className="ccc-agent-runs">
        <p className="ccc-state-heading">
          <span className="ccc-error-glyph" aria-hidden="true">
            ▲
          </span>
          <span>Couldn't load agent runs.</span>
        </p>
        <p className="ccc-state-body">Check the service in Settings → Diagnostics, then refresh.</p>
      </div>
    );
  }

  if (presentation.kind === "loading") {
    return (
      <div className="ccc-agent-runs" aria-busy="true">
        <span className="ccc-visually-hidden">Loading agent runs</span>
        {(["active", "recent", "unclassified"] as const).map((group) => (
          <section key={group}>
            <h3>{`${GROUP_HEADING[group]} (…)`}</h3>
            <SkeletonRows />
          </section>
        ))}
      </div>
    );
  }

  const totalSessions = sessionsById.value.size;
  const runningCount = allSessions.filter((s) => s.state === "running").length;
  const waitingCount = allSessions.filter((s) => s.state === "waiting-for-approval").length;
  const unknownCount = allSessions.filter((s) => s.state === "stale").length;

  // The setup gate stands alone (UI-SPEC "Destination states": "Tables render
  // stored history if any exists; otherwise the banner stands alone") —
  // `activeSessionsStateFor` only ever resolves `permission-required` while
  // `sessionsById` is empty (session-signals.ts), so there is no history to
  // show beside it and the generic empty pair below would only repeat it.
  if (presentation.kind === "permission-required") {
    return (
      <div className="ccc-agent-runs">
        <p className="ccc-state-body">
          {`${runningCount} active · ${waitingCount} waiting for approval · ${unknownCount} unknown`}
        </p>
        <WidgetFooter model={footerModel} panelTitle="agent runs" now={now} />
        <Banner presentation={presentation} onSetUpHooks={handleSetUpHooks} now={now} />
      </div>
    );
  }

  return (
    <div className="ccc-agent-runs">
      <p className="ccc-state-body">
        {`${runningCount} active · ${waitingCount} waiting for approval · ${unknownCount} unknown`}
      </p>
      <WidgetFooter model={footerModel} panelTitle="agent runs" now={now} />
      <Banner presentation={presentation} onSetUpHooks={handleSetUpHooks} now={now} />
      {totalSessions === 0 ? (
        <>
          <p className="ccc-state-heading">Nothing here yet</p>
          <p className="ccc-state-body">
            Agent runs has no items right now. New items appear as they arrive.
          </p>
          <p className="ccc-state-body">
            Start Claude Code in a terminal or from Projects — sessions appear here within 10
            seconds.
          </p>
        </>
      ) : (
        <div className="ccc-agent-runs-layout">
          <div className="ccc-agent-runs-sessions">
            <section>
              <h3>{`${GROUP_HEADING.active} (${groups.active.length})`}</h3>
              <SessionsTable
                group="active"
                rows={groups.active}
                shown={groups.active.length}
                onShowMore={() => {}}
                nowMs={now}
                selected={selected}
                onSelect={(runId) => {
                  selectedRunId.value = runId;
                }}
              />
            </section>
            <section>
              <h3>{`${GROUP_HEADING.recent} (${groups.recent.length})`}</h3>
              <SessionsTable
                group="recent"
                rows={groups.recent}
                shown={recentShown}
                onShowMore={() => setRecentShown((n) => n + RECENT_PAGE_SIZE)}
                nowMs={now}
                selected={selected}
                onSelect={(runId) => {
                  selectedRunId.value = runId;
                }}
              />
            </section>
            <section>
              <h3>{`${GROUP_HEADING.unclassified} (${groups.unclassified.length})`}</h3>
              <SessionsTable
                group="unclassified"
                rows={groups.unclassified}
                shown={unclassifiedShown}
                onShowMore={() => setUnclassifiedShown((n) => n + RECENT_PAGE_SIZE)}
                nowMs={now}
                selected={selected}
                onSelect={(runId) => {
                  selectedRunId.value = runId;
                }}
              />
            </section>
          </div>
          <DetailPaneSlot session={selectedSession} headingRef={headingRef} />
        </div>
      )}
    </div>
  );
}
