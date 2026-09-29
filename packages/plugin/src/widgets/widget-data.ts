import { type ReadonlySignal, signal } from "@preact/signals";
import { projectShortcutsState } from "../projects/projects-state.js";
import type { WidgetState } from "./contract.js";
import type { WidgetId } from "./registry.js";
import { serviceHealthState } from "./service-health.js";

/**
 * One signal per widget (research Pattern 8, PERF-02/PERF-03).
 *
 * The Overview renders SYNCHRONOUSLY from whatever each signal currently
 * holds; no widget component awaits anything, so one slow or never-resolving
 * source can never delay a sibling card's first paint or block navigation.
 * That is the same structural move Phase 1 made for PERF-01 — paint first,
 * attach the client after — applied one level down.
 *
 * In this phase six of these signals hold CONSTANTS, which is what makes
 * `D-17` structural rather than a review rule: a panel says
 * `permission-required` or `unavailable` because there is nothing else it
 * could say, not because someone remembered not to fake it. The phase that
 * gives a panel a route replaces its constant here with a client-fed signal
 * and changes nothing else.
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

/** A constant state as a signal, so every widget is read through one shape. */
function constantState(state: WidgetState<never>): ReadonlySignal<WidgetState<unknown>> {
  return signal<WidgetState<unknown>>(state);
}

const WIDGET_STATES: Readonly<Record<WidgetId, ReadonlySignal<WidgetState<unknown>>>> = {
  // The phase's one real widget: a `computed` over the live connection signals.
  "service-health": serviceHealthState,
  // The only two panels that will sit behind a real OAuth capability gate.
  today: constantState(permissionRequiredState("google", "Google Calendar and Gmail")),
  "github-discoveries": constantState(permissionRequiredState("github", "GitHub")),
  // The five with no connector to click: `unavailable`, not a plausible lie
  // that reads as "one click away" (ADR-0023 rejected alternative).
  "active-sessions": constantState(UNAVAILABLE_STATE),
  // Plan 04-07: a service-fed signal (D-35), replacing the constant above.
  "project-shortcuts": projectShortcutsState,
  "claude-usage": constantState(UNAVAILABLE_STATE),
  "tech-intel": constantState(UNAVAILABLE_STATE),
  "quick-actions": constantState(UNAVAILABLE_STATE),
};

/**
 * The seam plan 03-07's Overview reads synchronously, and the one plan 03-07's
 * PERF-03 test replaces per widget.
 */
export function widgetStateFor(id: WidgetId): ReadonlySignal<WidgetState<unknown>> {
  return WIDGET_STATES[id];
}
