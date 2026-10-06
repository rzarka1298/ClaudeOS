// Deep submodule imports, not the `@ccc/domain` barrel (05-06 deviation,
// Rule 3, mirrored in `active-sessions.tsx`/`session-signals.ts`): the
// barrel's `export *` chain pulls in `path-containment.ts`
// (`node:fs`/`node:path`), which the visual harness's browser-platform
// bundle cannot resolve.
import { isSessionListed, isTerminalRunState, type SessionView } from "@ccc/domain/session.js";
import { signal } from "@preact/signals";
import { orderSessionRows } from "../widgets/session-signals.js";

/**
 * The Agent runs destination's own view state (UI-SPEC S3 "Sessions table",
 * D-52). Grouping is a PURE function of the full session map, never of
 * `session-signals.ts`'s hero-windowed `ActiveSessionsData` — the hero only
 * ever carries a 60-minute terminal window (R-07), while every group here
 * (`Active`, `Recent`, `Unclassified`) needs the full history within its own
 * rule (R-08).
 */

/** The Run this destination's detail pane shows, or `null` when none is
 * selected. Survives destination switches by construction (D-52, R-06): a
 * signal, not component state, so switching away and back to Agent runs
 * keeps the selection exactly as `session-signals.ts`'s `sessionsById` keeps
 * the session map. */
export const selectedRunId = signal<string | null>(null);

/**
 * Set by the S1 hero row's `focusDestination("agent-runs", { runId })`
 * hand-off, and consumed once by `AgentRuns`' mount effect: the only mount
 * that moves focus to the detail heading (UI-SPEC S1 "Activating a hero row
 * … focus on the detail heading"). A plain mount — arrowing the tablist onto
 * Agent runs with a selection left over from last time — leaves focus on the
 * tab, so the tablist's own arrow-key navigation is never hijacked (05
 * wave 4 review, focus trap).
 */
export const detailFocusRequested = signal(false);

/** `Recent` and `Unclassified` page by 25, then `Show 25 more` (UI-SPEC
 * "Sessions table" volume column). */
export const RECENT_PAGE_SIZE = 25;

/** A terminal Run older than this is outside `Recent`/`Unclassified` (UI-SPEC
 * "Sessions table" row, R-08). */
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface GroupedSessions {
  /** Every non-terminal Run, attributed or not, in the same order as the S1
   * hero rows (R-08, "same order as the S1 rows"). */
  readonly active: readonly SessionView[];
  /** Terminal Runs attributed to a project, ended within the last 7 days,
   * most-recent-end first. */
  readonly recent: readonly SessionView[];
  /** Terminal Runs with no project attribution, ended within the last 7
   * days, most-recent-end first. */
  readonly unclassified: readonly SessionView[];
}

function endedWithinWindow(session: SessionView, nowMs: number): boolean {
  if (session.endedAt === null) return false;
  return nowMs - Date.parse(session.endedAt) <= RECENT_WINDOW_MS;
}

function byMostRecentEnd(a: SessionView, b: SessionView): number {
  // Both are filtered to a non-null `endedAt` before this comparator runs.
  return Date.parse(b.endedAt ?? "") - Date.parse(a.endedAt ?? "");
}

/**
 * Splits every known Run into exactly one of the three groups (UI-SPEC
 * "Sessions table" table, R-08). `active` reuses {@link orderSessionRows}'s
 * relative ordering (waiting-for-approval → running → starting → queued →
 * unknown, each by most recent activity) rather than a second ordering
 * rule, then narrows it to the non-terminal subset — `orderSessionRows`
 * already includes every non-terminal Run regardless of its window, so no
 * information is lost by filtering after.
 */
export function groupSessions(sessions: readonly SessionView[], nowMs: number): GroupedSessions {
  const active = orderSessionRows(sessions, nowMs).filter(
    (session) => !isTerminalRunState(session.state),
  );

  const recentWindow = sessions.filter(
    (session) =>
      isSessionListed(session) &&
      isTerminalRunState(session.state) &&
      endedWithinWindow(session, nowMs),
  );
  const recent = recentWindow.filter((session) => session.projectId !== null).sort(byMostRecentEnd);
  const unclassified = recentWindow
    .filter((session) => session.projectId === null)
    .sort(byMostRecentEnd);

  return { active, recent, unclassified };
}
