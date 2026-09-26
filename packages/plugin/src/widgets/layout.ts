import type { LayoutOverride, SizeHint } from "@ccc/domain";
import { computed, signal } from "@preact/signals";
import { ENABLED_FLAGS } from "./feature-flags.js";
import { isWidgetId, WIDGETS, type WidgetId } from "./registry.js";

/**
 * The Overview's layout: a typed default in code, an optional validated JSON
 * override, and ONE pure function that resolves either against the registry
 * (UI-07, D-10, D-12, D-13; ADR-0023 "Layout rules").
 *
 * **The override is the complete list.** When an owner writes a layout file,
 * its entries are the whole ordered Overview — a widget the file leaves out is
 * not rendered. Merging default entries back in would make it impossible to
 * hide a card by editing the file, which is the one thing an owner who writes a
 * layout file most plainly means.
 *
 * **Resolution is lookup-only, and that is a security property (T-03-02).**
 * An override's `widgetId` is an untrusted string from a user-editable file.
 * {@link composeLayout} resolves it ONLY through {@link isWidgetId} — an
 * own-property check against the in-code {@link WIDGETS} registry — so a layout
 * file can select a registered widget and nothing else: it cannot name a
 * module, load code, or construct a component from a string.
 *
 * **The grid never sees a skipped entry (D-13).** An unknown id, a widget whose
 * feature flag is off, and a second occurrence of an id already placed each go
 * to `skipped` with a reason and never to `entries`. The Overview renders
 * `entries` only, so there is no broken slot, placeholder tile or error card for
 * a missing widget; the skip is recorded in diagnostics instead.
 */

export interface LayoutEntry {
  readonly widgetId: WidgetId;
  readonly size?: SizeHint;
}

export interface ResolvedLayoutEntry {
  readonly widgetId: WidgetId;
  readonly size: SizeHint;
}

export type LayoutSkipReason = "unknown-widget" | "feature-off" | "duplicate";

export interface SkippedLayoutEntry {
  readonly widgetId: string;
  readonly reason: LayoutSkipReason;
}

export interface LayoutResolution {
  readonly entries: readonly ResolvedLayoutEntry[];
  readonly skipped: readonly SkippedLayoutEntry[];
}

/**
 * Service health first — the one card backed by real data in this phase —
 * then the seven PRD §7.1 panels in PRD order (ADR-0023 "DEFAULT_LAYOUT
 * order"). Each size is that definition's `preferredSize`, stated here so the
 * default reads as a layout rather than as a derivation.
 */
export const DEFAULT_LAYOUT: readonly LayoutEntry[] = [
  { widgetId: "service-health", size: "medium" },
  { widgetId: "today", size: "wide" },
  { widgetId: "active-sessions", size: "tall" },
  { widgetId: "project-shortcuts", size: "medium" },
  { widgetId: "claude-usage", size: "wide" },
  { widgetId: "tech-intel", size: "tall" },
  { widgetId: "github-discoveries", size: "medium" },
  { widgetId: "quick-actions", size: "small" },
];

/**
 * Resolves a layout against the registry. Pure: no signal reads, no I/O, and
 * the same inputs always give the same resolution.
 */
export function composeLayout(
  defaultLayout: readonly LayoutEntry[],
  override: LayoutOverride | undefined,
  registry: typeof WIDGETS,
  enabledFlags: ReadonlySet<string>,
): LayoutResolution {
  const source: readonly { readonly widgetId: string; readonly size?: SizeHint | undefined }[] =
    override === undefined ? defaultLayout : override.entries;
  const entries: ResolvedLayoutEntry[] = [];
  const skipped: SkippedLayoutEntry[] = [];
  const placed = new Set<WidgetId>();

  for (const entry of source) {
    const { widgetId } = entry;
    if (!isWidgetId(widgetId)) {
      skipped.push({ widgetId, reason: "unknown-widget" });
      continue;
    }
    const definition = registry[widgetId];
    if (!enabledFlags.has(definition.featureFlag)) {
      skipped.push({ widgetId, reason: "feature-off" });
      continue;
    }
    if (placed.has(widgetId)) {
      skipped.push({ widgetId, reason: "duplicate" });
      continue;
    }
    placed.add(widgetId);
    entries.push({ widgetId, size: entry.size ?? definition.preferredSize });
  }

  return { entries, skipped };
}

/**
 * The owner's validated override, or `undefined` for the in-code default.
 * Plan 03-08's file watcher is the writer; nothing here reads a file.
 */
export const layoutOverride = signal<LayoutOverride | undefined>(undefined);

/** What the Overview renders: the current override (or default), resolved. */
export const resolvedLayout = computed<LayoutResolution>(() =>
  composeLayout(DEFAULT_LAYOUT, layoutOverride.value, WIDGETS, ENABLED_FLAGS),
);

/** RED skeleton (plan 03-07 Task 2). */
export function setLayoutOverride(next: LayoutOverride | undefined): LayoutResolution {
  layoutOverride.value = next;
  // Not written yet: skipped entries are not recorded.
  return resolvedLayout.value;
}
