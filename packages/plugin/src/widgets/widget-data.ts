import { type ReadonlySignal, signal } from "@preact/signals";
import { techIntelState, todayState } from "../overview/overview-feeds.js";
import { projectShortcutsState, quickActionsState } from "../projects/projects-state.js";
import { codexState } from "./codex-signals.js";
import type { WidgetState } from "./contract.js";
import type { WidgetId } from "./registry.js";
import { serviceHealthState } from "./service-health.js";
import { activeSessionsState } from "./session-signals.js";
import { claudeUsageState } from "./usage-signals.js";

/**
 * One signal per widget (research Pattern 8, PERF-02/PERF-03).
 *
 * The Overview renders SYNCHRONOUSLY from whatever each signal currently
 * holds; no widget component awaits anything, so one slow or never-resolving
 * source can never delay a sibling card's first paint or block navigation.
 * That is the same structural move Phase 1 made for PERF-01 — paint first,
 * attach the client after — applied one level down.
 *
 * Two of these signals still hold CONSTANTS (`github-discoveries`, and
 * `tech-intel` until plan 08-17), recorded in {@link CONSTANT_STATE_WIDGET_IDS}.
 * That is what makes `D-17` structural rather than a review rule: a panel says
 * `permission-required` or `unavailable` because there is nothing else it
 * could say, not because someone remembered not to fake it. The phase that
 * gives a panel a route replaces its constant here with a client-fed signal
 * and changes nothing else; `today` was the last to move (plan 08-14).
 */

/** No route exists for this widget in this build (ADR-0023). */
export const UNAVAILABLE_STATE: WidgetState<never> = { kind: "unavailable" };

/** A capability gate the owner can act on, naming the source in the owner's words. */
export function permissionRequiredState(
  capability: string,
  sourceLabel: string,
): WidgetState<never> {
  return { kind: "permission-required", capability, sourceLabel };
}

/**
 * The widgets whose state is a CONSTANT in this build, recorded as they are
 * built (plan 08-14, research B 2.8). A structural test asserts the Overview
 * slice widgets are never in it, so "no widget on the Overview reads a fixture
 * or a mock in a production build" (D-22) is checked, not remembered.
 */
const constantIds = new Set<WidgetId>();
export const CONSTANT_STATE_WIDGET_IDS: ReadonlySet<WidgetId> = constantIds;

/** A constant state as a signal, so every widget is read through one shape. */
function constantState(
  id: WidgetId,
  state: WidgetState<never>,
): ReadonlySignal<WidgetState<unknown>> {
  constantIds.add(id);
  return signal<WidgetState<unknown>>(state);
}

const WIDGET_STATES: Readonly<Record<WidgetId, ReadonlySignal<WidgetState<unknown>>>> = {
  // The phase's one real widget: a `computed` over the live connection signals.
  "service-health": serviceHealthState,
  // Plan 08-14: a computed over the Overview feeds (`overview/overview-feeds.ts`),
  // service-fed and always partial. Calendar and Gmail are named as not part of
  // this version; they are not a capability gate any more.
  today: todayState,
  // The one panel that still sits behind a capability gate.
  "github-discoveries": constantState(
    "github-discoveries",
    permissionRequiredState("github", "GitHub"),
  ),
  // The two panels this phase gives a route: a computed over the live
  // session/usage signals (`session-signals.ts`, `usage-signals.ts`),
  // following the same "replace the constant with a client-fed signal,
  // change nothing else" move as `service-health` above (this file's own
  // docblock).
  "active-sessions": activeSessionsState,
  "claude-usage": claudeUsageState,
  codex: codexState,
  // Plan 04-07: a service-fed signal (D-35), replacing a constant.
  "project-shortcuts": projectShortcutsState,
  // Plan 08-17: a computed over the report-list feed (`overview/overview-feeds.ts`),
  // service-fed; freshness is `cached` or `stale`, never `live` (UI-SPEC R-14).
  "tech-intel": techIntelState,
  "quick-actions": quickActionsState,
};

/**
 * The seam plan 03-07's Overview reads synchronously, and the one plan 03-07's
 * PERF-03 test replaces per widget.
 */
export function widgetStateFor(id: WidgetId): ReadonlySignal<WidgetState<unknown>> {
  return WIDGET_STATES[id];
}
