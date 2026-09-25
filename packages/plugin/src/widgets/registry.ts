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
 * {@link AnyWidgetDefinition} — not `WidgetDefinition<never>` — is the bound,
 * for a concrete variance reason worth recording: `ComponentType<P>` includes
 * `ComponentClass<P>`, whose `defaultProps?: Partial<P>` puts `P` in an
 * INVARIANT position under `exactOptionalPropertyTypes`, so no single concrete
 * argument (`never`, `unknown`) is a supertype of every widget's data type.
 * Erasing ONLY the body's payload keeps every other contract field — id,
 * title, dataKeys, refresh, sizes, featureFlag, quickActions — fully checked
 * by `satisfies`, and each definition keeps its precise data type at its own
 * declaration site, which is where a body's props actually get checked.
 */
// The lone `any` in this package, and it is load-bearing: see the note above.
// It cannot be suppressed for `@typescript-eslint/no-explicit-any` either —
// `eslint-comments/no-restricted-disable` forbids disabling that rule — so the
// one remaining lint WARNING is the honest record of this variance limit. The
// durable fix is to narrow `WidgetDefinition`'s two renderer fields from
// `ComponentType<P>` to a plain function-component signature (this package
// ships no class component), which removes the invariant `defaultProps` and
// makes `WidgetDefinition<never>` a real supertype; that edit belongs to a
// plan that owns `contract.ts`.
// biome-ignore lint/suspicious/noExplicitAny: the erased body payload described above.
type ErasedPayload = any;

export type AnyWidgetDefinition = WidgetDefinition<ErasedPayload>;

export const WIDGETS = {
  "service-health": serviceHealthWidget,
  today: todayWidget,
  "active-sessions": activeSessionsWidget,
  "project-shortcuts": projectShortcutsWidget,
  "claude-usage": claudeUsageWidget,
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
  "tech-intel",
  "github-discoveries",
  "quick-actions",
] as const satisfies readonly WidgetId[];

/** Narrows an unknown string — a persisted layout entry, a diagnostics id. */
export function isWidgetId(value: string): value is WidgetId {
  return Object.hasOwn(WIDGETS, value);
}
