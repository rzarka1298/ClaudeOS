import { codexWidget } from "./codex.js";
import type { WidgetDefinition } from "./contract.js";
import {
  activeSessionsWidget,
  claudeUsageWidget,
  githubDiscoveriesWidget,
  projectShortcutsWidget,
  quickActionsWidget,
  techIntelWidget,
  todayWidget,
} from "./panels.js";
import { serviceHealthWidget } from "./service-health.js";

/**
 * The one registry of widgets (UI-04).
 *
 * The `as const satisfies` shape is copied deliberately from
 * `view/destinations.ts`: `satisfies` keeps every entry checked against the
 * full {@link WidgetDefinition} contract while `as const` preserves the key
 * literals, so {@link WidgetId} is a literal union that plan 03-07's layout
 * schema can reference exactly as `DestinationId` is referenced today. A
 * second list of widget ids anywhere — an enum, a layout default, a
 * diagnostics table — would be a place for the two to disagree.
 *
 * {@link AnyWidgetDefinition} is `WidgetDefinition<never>`, and nothing is
 * erased. `WidgetDefinition`'s renderers are plain function signatures (see
 * `contract.ts`), so a definition is contravariant in its payload and
 * `never` makes it the supertype of every registered widget: `satisfies`
 * checks every contract field, each entry keeps its precise data type, and
 * an erased definition can be neither called with a payload directly nor
 * passed off as a typed one (`contract.types.test.tsx`). The one place an
 * erased definition meets its widget's unvalidated state is `WidgetFrame`,
 * which says so in its own props type.
 */
export type AnyWidgetDefinition = WidgetDefinition<never>;

export const WIDGETS = {
  "service-health": serviceHealthWidget,
  today: todayWidget,
  "active-sessions": activeSessionsWidget,
  "project-shortcuts": projectShortcutsWidget,
  "claude-usage": claudeUsageWidget,
  codex: codexWidget,
  "tech-intel": techIntelWidget,
  "github-discoveries": githubDiscoveriesWidget,
  "quick-actions": quickActionsWidget,
} as const satisfies Record<string, AnyWidgetDefinition>;

export type WidgetId = keyof typeof WIDGETS;

/** Every registered id, in declaration order. */
export const WIDGET_IDS = Object.keys(WIDGETS) as readonly WidgetId[];

/**
 * The seven PRD §7.1 panels in the PRD's own desktop ordering, without
 * `service-health` — which is not a PRD panel but this phase's one real
 * widget. Plan 03-07's default layout reads this rather than re-typing the
 * order.
 */
export const PRD_PANEL_ORDER = [
  "today",
  "active-sessions",
  "project-shortcuts",
  "claude-usage",
  "codex",
  "tech-intel",
  "github-discoveries",
  "quick-actions",
] as const satisfies readonly WidgetId[];

/** Narrows an unknown string — a persisted layout entry, a diagnostics id. */
export function isWidgetId(value: string): value is WidgetId {
  return Object.hasOwn(WIDGETS, value);
}
