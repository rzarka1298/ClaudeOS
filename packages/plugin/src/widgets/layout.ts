import type { SizeHint } from "@ccc/domain";
import type { WIDGETS, WidgetId } from "./registry.js";

/** RED skeleton (plan 03-07 Task 1): the types are final, the resolver is not written yet. */

export interface LayoutEntry {
  readonly widgetId: WidgetId;
  readonly size?: SizeHint;
}

export interface ResolvedLayoutEntry {
  readonly widgetId: WidgetId;
  readonly size: SizeHint;
}

export type LayoutSkipReason = "unknown-widget" | "feature-off" | "duplicate";

export interface LayoutResolution {
  readonly entries: readonly ResolvedLayoutEntry[];
  readonly skipped: readonly { readonly widgetId: string; readonly reason: LayoutSkipReason }[];
}

export const DEFAULT_LAYOUT: readonly LayoutEntry[] = [];

export function composeLayout(
  _defaultLayout: readonly LayoutEntry[],
  _override: { readonly entries: readonly { widgetId: string; size?: SizeHint }[] } | undefined,
  _registry: typeof WIDGETS,
  _enabledFlags: ReadonlySet<string>,
): LayoutResolution {
  throw new Error("composeLayout is not implemented yet (widgets/layout.ts)");
}
