import type { SessionUsage } from "@ccc/domain/usage.js";
import type { ReadonlySignal } from "@preact/signals";
import type { VNode } from "preact";
import { useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import { connectionState, lastEvent } from "../connection-state.js";
import { motionMode } from "../motion.js";
import { nowTick } from "../widgets/clock.js";
import type { QuickActionDescriptor, WidgetState } from "../widgets/contract.js";
import type { LayoutResolution } from "../widgets/layout.js";
import { resolvedLayout } from "../widgets/layout.js";
import { dispatchQuickAction } from "../widgets/quick-actions.js";
import type { WidgetId } from "../widgets/registry.js";
import { widgetStateFor } from "../widgets/widget-data.js";
import { AgentRuns } from "./agent-runs.js";
import { detailFocusRequested, selectedRunId } from "./agent-runs-state.js";
import { DESTINATIONS, type DestinationId, nextDestination } from "./destinations.js";
import { Overview } from "./overview.js";

/**
 * Everything any registered destination view could need. A destination that
 * needs less simply ignores the rest — `AgentRuns` today only reads `now`
 * and `onQuickAction`, `Overview` reads all six.
 */
interface DestinationViewProps {
  readonly layout: LayoutResolution;
  readonly stateFor: (id: WidgetId) => ReadonlySignal<WidgetState<unknown>>;
  readonly connection: ConnectionState;
  readonly now: number;
  readonly onQuickAction: (descriptor: QuickActionDescriptor) => void;
  readonly onNavigate: (id: DestinationId, selection?: { readonly runId: string }) => void;
  readonly loadSessionUsage: ((runId: string) => Promise<SessionUsage>) | undefined;
}

/**
 * The destination-id-to-component lookup (04-PATTERNS line 825, PATTERNS
 * "shell recommendation"): the executor's base check for whether this
 * lookup already existed in Phase 4's shell.tsx found only the original
 * Overview-else-description ternary, so this plan converts it. A
 * destination absent from this record falls back to its
 * `DESTINATIONS`-declared `description` paragraph unchanged (every
 * destination besides Overview and Agent runs, still "Filled in a later
 * phase.").
 */
const DESTINATION_VIEWS: Partial<Record<DestinationId, (props: DestinationViewProps) => VNode>> = {
  overview: ({ layout, stateFor, connection, now, onQuickAction, onNavigate }) => (
    <Overview
      layout={layout}
      stateFor={stateFor}
      connection={connection}
      now={now}
      onQuickAction={onQuickAction}
      onNavigate={onNavigate}
    />
  ),
  "agent-runs": ({ now, onQuickAction, loadSessionUsage }) => (
    <AgentRuns now={now} onQuickAction={onQuickAction} loadSessionUsage={loadSessionUsage} />
  ),
};

export interface ShellProps {
  /** The destination selected before this render — usually the last-saved one (PLUG-05). */
  initialDestination?: DestinationId;
  /** Called whenever the user selects a different destination, so the host can persist it. */
  onDestinationChange?: (id: DestinationId) => void;
  /**
   * Each widget's state signal. Defaults to {@link widgetStateFor} — the one
   * production seam. This prop is the injection point the PERF-02/PERF-03
   * tests use; production never passes fixture data through it (D-17).
   */
  stateFor?: (id: WidgetId) => ReadonlySignal<WidgetState<unknown>>;
  /**
   * Shows a transient message to the owner. The view host passes Obsidian's
   * `Notice`; the default is a no-op so this component imports nothing from
   * `obsidian` and stays renderable anywhere (C-11).
   */
  notify?: (message: string) => void;
  /**
   * Loads one Run's own token activity and cost for the Agent runs detail
   * pane (05-07's `getSessionUsage`, built from the view's authenticated
   * client). Absent means the pane's per-session usage section stays empty
   * — never a constructed client living inside `agent-runs-detail.tsx`.
   */
  loadSessionUsage?: (runId: string) => Promise<SessionUsage>;
}

function noNotify(_message: string): void {}

function connectionStatusText(state: ConnectionState): string {
  switch (state.kind) {
    case "live":
      return "Live";
    case "disconnected":
      return `Disconnected — ${state.reason}`;
    default:
      return "Connecting…";
  }
}

/**
 * The structural command-center shell (PLUG-01, PLUG-02, PLUG-04, PERF-01).
 * Renders synchronously from {@link connectionState}'s current signal value
 * and never awaits a client — see `command-center-view.ts` for where the
 * connection probe actually happens, always after this component's first
 * paint.
 *
 * Every visual value comes from the one `--ccc-*` token block in
 * `styles.css` (ADR-0023, UI-03); this component contributes class names and
 * `data-*` attributes and nothing else — no inline style, no colour, no
 * duration. `data-motion` is the single channel by which the resolved
 * reduced-motion mode reaches CSS (D-19): the component reads the already
 * resolved signal and never checks the OS preference itself.
 */
export function Shell({
  initialDestination,
  onDestinationChange,
  stateFor = widgetStateFor,
  notify = noNotify,
  loadSessionUsage,
}: ShellProps) {
  const [activeId, setActiveId] = useState<DestinationId>(initialDestination ?? "overview");
  const tabRefs = useRef<Partial<Record<DestinationId, HTMLButtonElement>>>({});

  function select(id: DestinationId): void {
    setActiveId(id);
    onDestinationChange?.(id);
  }

  /**
   * `select()` plus moving keyboard focus to the destination's tab. Used by
   * every navigation that starts INSIDE the Overview — a `+{n} more` control
   * or a connect action — because the control the owner just activated is
   * unmounted with the grid; without this, focus would fall back to the
   * document body and a keyboard user would lose their place (A11Y-01).
   *
   * The optional `selection` is the S1 hero row's `{ runId }` channel
   * (UI-SPEC S1 "Primary line", R-06): it sets `agent-runs-state.ts`'s
   * `selectedRunId` signal before switching tabs, so Agent runs mounts with
   * that Run already selected, and raises `detailFocusRequested`. The tab
   * itself still receives focus here; `AgentRuns`'s own mount effect then
   * moves it on to the detail heading (UI-SPEC "Activating a hero row …
   * focus on the detail heading") only because that flag is set — a plain
   * tab switch never does — since this function has no reference into that
   * destination's DOM.
   */
  function focusDestination(id: DestinationId, selection?: { readonly runId: string }): void {
    if (selection?.runId !== undefined) {
      selectedRunId.value = selection.runId;
      detailFocusRequested.value = true;
    }
    select(id);
    tabRefs.current[id]?.focus();
  }

  /**
   * Every widget quick action lands here, and only here: the frame emits a
   * descriptor, and {@link dispatchQuickAction} — the single choke point
   * Phase 6's approval check is inserted into — resolves it against a context
   * whose navigation is this tablist's own `select()` (C-11, APPR-01, T-03-13).
   */
  function handleQuickAction(descriptor: QuickActionDescriptor): void {
    dispatchQuickAction(descriptor, { navigate: focusDestination, notify });
  }

  function handleNavKeyDown(event: KeyboardEvent): void {
    let direction: "next" | "previous" | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") direction = "next";
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") direction = "previous";
    if (!direction) return;
    event.preventDefault();
    focusDestination(nextDestination(activeId, direction));
  }

  const active = DESTINATIONS.find((d) => d.id === activeId) ?? DESTINATIONS[0];
  const status = connectionState.value;
  const event = lastEvent.value;

  return (
    <div className="ccc-command-center" data-motion={motionMode.value}>
      {/* Decorative atmosphere (D-20): CSS-only gradients plus a fixed set of
          twinkle points whose positions and delays live entirely in
          `styles.css`. Announced to nobody, and static under reduced motion. */}
      <div className="ccc-twinkle" aria-hidden="true">
        <span className="ccc-twinkle-point" key={0} />
        <span className="ccc-twinkle-point" key={1} />
        <span className="ccc-twinkle-point" key={2} />
        <span className="ccc-twinkle-point" key={3} />
        <span className="ccc-twinkle-point" key={4} />
        <span className="ccc-twinkle-point" key={5} />
        <span className="ccc-twinkle-point" key={6} />
        <span className="ccc-twinkle-point" key={7} />
        <span className="ccc-twinkle-point" key={8} />
        <span className="ccc-twinkle-point" key={9} />
        <span className="ccc-twinkle-point" key={10} />
        <span className="ccc-twinkle-point" key={11} />
      </div>
      <div className="ccc-connection-status" data-state={status.kind}>
        <span className="ccc-status-dot" aria-hidden="true" />
        <span className="ccc-status-text">{connectionStatusText(status)}</span>
        {event && (
          <span className="ccc-last-event-text">
            {`Last event: ${event.type} at ${event.occurredAt}`}
          </span>
        )}
      </div>
      <div
        role="tablist"
        aria-label="Command center destinations"
        className="ccc-nav"
        onKeyDown={handleNavKeyDown}
      >
        {DESTINATIONS.map((destination) => {
          const selected = destination.id === activeId;
          return (
            <button
              key={destination.id}
              type="button"
              role="tab"
              id={`ccc-tab-${destination.id}`}
              aria-selected={selected}
              aria-controls={`ccc-panel-${destination.id}`}
              tabIndex={selected ? 0 : -1}
              className="ccc-nav-item"
              ref={(el) => {
                if (el) tabRefs.current[destination.id] = el;
              }}
              onClick={() => select(destination.id)}
            >
              {destination.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`ccc-panel-${active.id}`}
        aria-labelledby={`ccc-tab-${active.id}`}
        className="ccc-content"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the WAI-ARIA tabs pattern requires the tabpanel to be focusable (A11Y-01) — Biome doesn't know role="tabpanel" makes this interactive.
        tabIndex={0}
      >
        <h2>{active.label}</h2>
        {DESTINATION_VIEWS[active.id]?.({
          layout: resolvedLayout.value,
          stateFor,
          connection: status,
          now: nowTick.value,
          onQuickAction: handleQuickAction,
          onNavigate: focusDestination,
          loadSessionUsage,
        }) ?? <p>{active.description}</p>}
      </div>
    </div>
  );
}
