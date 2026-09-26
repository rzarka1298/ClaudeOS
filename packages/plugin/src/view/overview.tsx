import type { SizeHint } from "@ccc/domain";
import type { ReadonlySignal } from "@preact/signals";
import type { VNode } from "preact";
import { useId } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import type { QuickActionDescriptor, WidgetState } from "../widgets/contract.js";
import { WidgetFrame } from "../widgets/frame.js";
import type { LayoutResolution } from "../widgets/layout.js";
import { type AnyWidgetDefinition, WIDGETS, type WidgetId } from "../widgets/registry.js";
import type { DestinationId } from "./destinations.js";

export interface OverviewProps {
  /** The resolved layout — entries only; skipped entries never reach the grid (D-13). */
  readonly layout: LayoutResolution;
  /** Each widget's state signal. Production passes `widgetStateFor`; tests inject. */
  readonly stateFor: (id: WidgetId) => ReadonlySignal<WidgetState<unknown>>;
  readonly connection: ConnectionState;
  readonly now: number;
  readonly onQuickAction?: (descriptor: QuickActionDescriptor) => void;
  /** Selects and focuses a destination — the `+{n} more` channel into each body. */
  readonly onNavigate?: ((destination: DestinationId) => void) | undefined;
}

/**
 * The Overview grid (UI-07, D-12, UI-SPEC E3).
 *
 * One ordered list of cards with size hints, auto-placed by the CSS grid in
 * `styles.css` — no coordinates, no breakpoint layouts, the same markup for a
 * narrow side pane and a full window.
 *
 * Every card reads its OWN signal synchronously during render, and nothing in
 * this tree awaits anything (PERF-02, PERF-03; research Pattern 8): first
 * paint shows whatever each signal holds right now, so a slow or never-
 * resolving source leaves its own card `loading` and delays no sibling and no
 * destination switch.
 */
export function Overview({
  layout,
  stateFor,
  connection,
  now,
  onQuickAction,
  onNavigate,
}: OverviewProps): VNode {
  const emptyTitleId = `${useId()}-title`;
  if (layout.entries.length === 0) {
    return (
      <div className="ccc-overview-grid">
        <section
          className="ccc-card ccc-layout-empty"
          data-presentation="empty"
          data-size="small"
          aria-labelledby={emptyTitleId}
        >
          <header className="ccc-card-header">
            <h3 id={emptyTitleId}>Nothing here yet</h3>
          </header>
          <div className="ccc-card-body">
            <p className="ccc-state-body">
              The Overview layout has no widgets to show. Check the layout file in the plugin data
              folder.
            </p>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="ccc-overview-grid">
      {layout.entries.map((entry) => (
        <OverviewCard
          key={entry.widgetId}
          definition={WIDGETS[entry.widgetId]}
          // The SIGNAL is handed down, never its value: reading `.value` here
          // would subscribe the whole grid to every widget.
          state={stateFor(entry.widgetId)}
          size={entry.size}
          connection={connection}
          now={now}
          onNavigate={onNavigate}
          onQuickAction={onQuickAction}
        />
      ))}
    </div>
  );
}

interface OverviewCardProps {
  readonly definition: AnyWidgetDefinition;
  readonly state: ReadonlySignal<WidgetState<unknown>>;
  readonly size: SizeHint;
  readonly connection: ConnectionState;
  readonly now: number;
  readonly onQuickAction?: ((descriptor: QuickActionDescriptor) => void) | undefined;
  readonly onNavigate?: ((destination: DestinationId) => void) | undefined;
}

/**
 * One grid cell, and the ONLY place its widget's signal is read. Because the
 * `.value` read happens in this component's render, @preact/signals
 * subscribes this card alone: a widget's update re-renders its own card and
 * no sibling, and never the grid (per-card isolation, research Pattern 8).
 */
function OverviewCard({
  definition,
  state,
  size,
  connection,
  now,
  onQuickAction,
  onNavigate,
}: OverviewCardProps): VNode {
  return (
    <WidgetFrame
      definition={definition}
      state={state.value}
      size={size}
      connection={connection}
      now={now}
      onNavigate={onNavigate}
      {...(onQuickAction === undefined ? {} : { onQuickAction })}
    />
  );
}
