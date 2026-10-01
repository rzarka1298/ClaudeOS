import type { LaunchAction, ProjectId } from "@ccc/domain";
import type { ReadonlySignal } from "@preact/signals";
import type { VNode } from "preact";
import { useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import { connectionState, lastEvent } from "../connection-state.js";
import { motionMode } from "../motion.js";
import type { FolderPick, PickFolderOptions } from "../projects/folder-picker.js";
import type { ProjectsActions } from "../projects/projects-actions.js";
import { nowTick } from "../widgets/clock.js";
import type { QuickActionDescriptor, WidgetState } from "../widgets/contract.js";
import { resolvedLayout } from "../widgets/layout.js";
import { dispatchQuickAction } from "../widgets/quick-actions.js";
import type { WidgetId } from "../widgets/registry.js";
import { widgetStateFor } from "../widgets/widget-data.js";
import { DESTINATIONS, type DestinationId, nextDestination } from "./destinations.js";
import { Overview } from "./overview.js";
import { ProjectsView } from "./projects-view.js";

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
   * Requests a launch for the given project (`null` for `claude-desktop`,
   * D-06) and action. The view host wires this to the service client; the
   * default is a no-op so this component never imports
   * `@ccc/service-api-client` itself (D-24).
   */
  requestLaunch?: (projectId: ProjectId | null, action: LaunchAction) => void;
  /** Opens the Claude Code quick switcher, prefilled. The default is a no-op. */
  openSwitcher?: (prefill: string) => void;
  /**
   * Opens one of the two fixed System Settings panes (RR-16) through the
   * service. Absent, the launch error buttons that need it are omitted —
   * their next-step line already names the path.
   */
  openSystemSettings?: (pane: "automation" | "privacy-security") => void;
  /**
   * The Projects destination's bound service actions (register, remove,
   * rename, pin, set-GitHub-link, refresh). The view host wires this to
   * `createProjectsActions(client)`; the default resolves `failed` for
   * everything so Shell renders — and its Projects destination behaves
   * honestly — with no host at all (D-24's "components never import the
   * client" seam).
   */
  projectsActions?: ProjectsActions;
  /**
   * Opens Electron's native folder dialog (D-03). The default resolves
   * `unavailable`, which is a real, expected outcome the Projects
   * destination already falls back from — not a special case for the
   * no-host default.
   */
  pickFolder?: (options: PickFolderOptions) => Promise<FolderPick>;
}

function noNotify(_message: string): void {}
function noRequestLaunch(_projectId: ProjectId | null, _action: LaunchAction): void {}
function noOpenSwitcher(_prefill: string): void {}

const FAILED_OUTCOME = Promise.resolve({ kind: "failed" as const });
const noProjectsActions: ProjectsActions = {
  register: () => FAILED_OUTCOME,
  remove: () => FAILED_OUTCOME,
  rename: () => FAILED_OUTCOME,
  pin: () => FAILED_OUTCOME,
  setGithubLink: () => FAILED_OUTCOME,
  refresh: () => FAILED_OUTCOME,
};
function noPickFolder(_options: PickFolderOptions): Promise<FolderPick> {
  return Promise.resolve({ kind: "unavailable" });
}

/**
 * Per-destination content beyond Overview (PR-12). A destination absent from
 * this map falls back to its own description paragraph — the same fallback
 * every destination used before this map existed — so
 * plans 04-08 and 04-12 (`projects`, `settings`) and Phase 5 (`agent-runs`)
 * each add one line here without touching any other destination's rendering.
 */
export interface DestinationViewProps {
  readonly stateFor: (id: WidgetId) => ReadonlySignal<WidgetState<unknown>>;
  readonly connection: ConnectionState;
  readonly now: number;
  readonly onQuickAction: (descriptor: QuickActionDescriptor) => void;
  readonly onNavigate: (destination: DestinationId) => void;
  readonly projectsActions: ProjectsActions;
  readonly pickFolder: (options: PickFolderOptions) => Promise<FolderPick>;
  readonly openSystemSettings?: ((pane: "automation" | "privacy-security") => void) | undefined;
}

const DESTINATION_VIEWS: Partial<Record<DestinationId, (props: DestinationViewProps) => VNode>> = {
  overview: ({ stateFor, connection, now, onQuickAction, onNavigate }) => (
    <Overview
      layout={resolvedLayout.value}
      stateFor={stateFor}
      connection={connection}
      now={now}
      onQuickAction={onQuickAction}
      onNavigate={onNavigate}
    />
  ),
  projects: ({
    connection,
    now,
    onQuickAction,
    onNavigate,
    projectsActions,
    pickFolder,
    openSystemSettings,
  }) => (
    <ProjectsView
      actions={projectsActions}
      pickFolder={pickFolder}
      connection={connection}
      now={now}
      onQuickAction={onQuickAction}
      onNavigate={onNavigate}
      openSystemSettings={openSystemSettings}
    />
  ),
};

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
  requestLaunch = noRequestLaunch,
  openSwitcher = noOpenSwitcher,
  projectsActions = noProjectsActions,
  pickFolder = noPickFolder,
  openSystemSettings,
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
   */
  function focusDestination(id: DestinationId): void {
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
    dispatchQuickAction(descriptor, {
      navigate: focusDestination,
      notify,
      requestLaunch,
      openSwitcher,
    });
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
        {(() => {
          const DestinationView = DESTINATION_VIEWS[active.id];
          return DestinationView ? (
            <DestinationView
              stateFor={stateFor}
              connection={status}
              now={nowTick.value}
              onQuickAction={handleQuickAction}
              onNavigate={focusDestination}
              projectsActions={projectsActions}
              pickFolder={pickFolder}
              openSystemSettings={openSystemSettings}
            />
          ) : (
            <p>{active.description}</p>
          );
        })()}
      </div>
    </div>
  );
}
