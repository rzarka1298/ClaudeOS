import type { ProjectId } from "@ccc/domain";
import type { SessionUsage } from "@ccc/domain/usage.js";
import type { ReadonlySignal } from "@preact/signals";
import type { VNode } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  approvalDetailFocusRequested,
  pendingApprovalCount,
  selectedProposalId,
} from "../approvals/signals.js";
import type { ConnectionState } from "../connection-state.js";
import { connectionState, lastEvent } from "../connection-state.js";
import { motionMode } from "../motion.js";
import type { FolderPick, PickFolderOptions } from "../projects/folder-picker.js";
import type { ProjectLaunchActionId } from "../projects/launch-status.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import type { ProjectsActions, ScanActions } from "../projects/projects-actions.js";
import { projectsSnapshot } from "../projects/projects-state.js";
import { globalTasksContext } from "../tasks/contexts.js";
import { nowTick } from "../widgets/clock.js";
import type {
  NavigationSelection,
  QuickActionDescriptor,
  WidgetState,
} from "../widgets/contract.js";
import { resolvedLayout } from "../widgets/layout.js";
import { dispatchQuickAction } from "../widgets/quick-actions.js";
import type { WidgetId } from "../widgets/registry.js";
import { claudeIntegration, sessionsById } from "../widgets/session-signals.js";
import { widgetStateFor } from "../widgets/widget-data.js";
import { type WidgetHost, WidgetHostContext } from "../widgets/widget-host.js";
import { AgentRuns } from "./agent-runs.js";
import { detailFocusRequested, selectedRunId } from "./agent-runs-state.js";
import { DestinationTabs } from "./destination-tabs.js";
import { DESTINATIONS, type DestinationId, nextDestination } from "./destinations.js";
import { launchersFocusRequested } from "./launchers-focus.js";
import { createLaunchersSession, type LaunchersSession } from "./launchers-settings.js";
import { navigationRequest, taskFormRequested } from "./navigation-request.js";
import { Overview } from "./overview.js";
import { ProjectsView } from "./projects-view.js";
import {
  runSessionAction,
  type SessionActionDeps,
  type SessionActionHost,
} from "./session-action-runner.js";
import { SettingsDestination } from "./settings-destination.js";
import { TasksDestination } from "./tasks.js";
import { taskDetailFocusRequested } from "./tasks-view-state.js";

/**
 * The runner's signal-derived members, added to the host-supplied pieces
 * (05-17). `listProjects` is `null` (unknown, never "zero projects") until
 * the Projects snapshot has arrived.
 */
function sessionActionDeps(host: SessionActionHost): SessionActionDeps {
  return {
    ...host,
    getSession: (runId) => sessionsById.value.get(runId) ?? null,
    listProjects: () => {
      const snapshot = projectsSnapshot.value;
      if (snapshot === undefined) return null;
      return snapshot.projects.map((view) => ({
        id: view.projectId,
        name: view.displayName,
        pinned: view.pinned,
      }));
    },
    cleanupPeriodDays: () => claudeIntegration.value?.cleanupPeriodDays ?? null,
  };
}

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
  requestLaunch?: RequestLaunchHandler;
  /**
   * Opens the Claude Code quick switcher, prefilled. Absent (until plan
   * 04-14 wires one), S8's `Start a Claude Code session` renders unavailable
   * and its activation posts the unavailable Notice.
   */
  openSwitcher?: ((prefill: string) => void) | undefined;
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
   * The scan folder and suggestion actions behind S5 (plan 04-13). The view
   * host wires this to `createScanActions(client)`; absent, the Projects
   * destination's own default resolves `failed` for everything.
   */
  scanActions?: ScanActions;
  /**
   * Opens Electron's native folder dialog (D-03). The default resolves
   * `unavailable`, which is a real, expected outcome the Projects
   * destination already falls back from — not a special case for the
   * no-host default.
   */
  pickFolder?: (options: PickFolderOptions) => Promise<FolderPick>;
  /**
   * The Launchers section's bound service actions (detect, read, save,
   * Test, mark tested, System Settings). The view host wires this to
   * `createLaunchersActions(client)`; the default resolves `failed` for
   * everything (and a Test as `spawn-failed`), so the Settings destination
   * renders honestly with no host at all. Nothing calls it until the owner
   * opens Settings (D-30).
   */
  launchersActions?: LaunchersActions;
  /**
   * Loads one Run's own token activity and cost for the Agent runs detail
   * pane (05-07's `getSessionUsage`, built from the view's authenticated
   * client). Absent means the pane's per-session usage section stays empty
   * — never a constructed client living inside `agent-runs-detail.tsx`.
   */
  loadSessionUsage?: (runId: string) => Promise<SessionUsage>;
  /**
   * The client-bound pieces of the Phase 5 session-action runner. The view
   * host builds them from its authenticated client and Obsidian's modal
   * seam; absent, every `session:*` control answers unavailable.
   */
  sessionActions?: SessionActionHost;
}

function noNotify(_message: string): void {}
/**
 * Bivariant on purpose: a host or test double that only ever launches the five
 * single actions stays assignable to the widened pair-aware signature.
 */
type RequestLaunchHandler = {
  bivarianceHack(projectId: ProjectId | null, action: ProjectLaunchActionId): void;
}["bivarianceHack"];

function noRequestLaunch(_projectId: ProjectId | null, _action: ProjectLaunchActionId): void {}

const FAILED_OUTCOME = Promise.resolve({ kind: "failed" as const });
const noProjectsActions: ProjectsActions = {
  register: () => FAILED_OUTCOME,
  remove: () => FAILED_OUTCOME,
  rename: () => FAILED_OUTCOME,
  pin: () => FAILED_OUTCOME,
  setGithubLink: () => FAILED_OUTCOME,
  refresh: () => FAILED_OUTCOME,
};
const noLaunchersActions: LaunchersActions = {
  detect: () => FAILED_OUTCOME,
  getConfigs: () => FAILED_OUTCOME,
  save: () => FAILED_OUTCOME,
  test: () => Promise.resolve({ kind: "error", error: "spawn-failed" }),
  markTested: () => FAILED_OUTCOME,
  openSystemSettings: () => FAILED_OUTCOME,
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
  readonly onNavigate: (destination: DestinationId, selection?: NavigationSelection) => void;
  readonly projectsActions: ProjectsActions;
  readonly scanActions?: ScanActions | undefined;
  readonly pickFolder: (options: PickFolderOptions) => Promise<FolderPick>;
  readonly openSystemSettings?: ((pane: "automation" | "privacy-security") => void) | undefined;
  readonly launchersActions: LaunchersActions;
  /** The view's in-memory Launchers state: detection, drafts, in-flight results (RR-25). */
  readonly launchersSession: LaunchersSession;
  /** S9's `Go to {project}`: the card whose heading takes focus once it renders (plan 04-14). */
  readonly focusProjectId?: ProjectId | null | undefined;
  /** Called once the Projects destination has taken the focus request. */
  readonly onProjectFocusTaken?: (() => void) | undefined;
  /**
   * Called when the requested project is not in the loaded projects — it
   * was removed after the switcher listed it. Focus goes to the Projects tab
   * instead of nowhere (wave-7 finding 6).
   */
  readonly onProjectFocusMissing?: (() => void) | undefined;
  /** Loads one Run's own usage for the Agent runs detail pane (05-07). */
  readonly loadSessionUsage?: ((runId: string) => Promise<SessionUsage>) | undefined;
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
    scanActions,
    pickFolder,
    openSystemSettings,
    focusProjectId,
    onProjectFocusTaken,
    onProjectFocusMissing,
  }) => (
    <ProjectsView
      actions={projectsActions}
      scanActions={scanActions}
      pickFolder={pickFolder}
      connection={connection}
      now={now}
      onQuickAction={onQuickAction}
      onNavigate={onNavigate}
      openSystemSettings={openSystemSettings}
      focusProjectId={focusProjectId}
      onProjectFocusTaken={onProjectFocusTaken}
      onProjectFocusMissing={onProjectFocusMissing}
    />
  ),
  tasks: ({ connection, now }) => <TasksDestination connection={connection} now={now} />,
  "agent-runs": ({ now, onQuickAction, loadSessionUsage }) => (
    <AgentRuns now={now} onQuickAction={onQuickAction} loadSessionUsage={loadSessionUsage} />
  ),
  settings: ({ connection, now, launchersActions, launchersSession }) => (
    <SettingsDestination
      launchersActions={launchersActions}
      launchersSession={launchersSession}
      connection={connection}
      now={now}
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
  openSwitcher,
  projectsActions = noProjectsActions,
  scanActions,
  pickFolder = noPickFolder,
  openSystemSettings,
  launchersActions = noLaunchersActions,
  loadSessionUsage,
  sessionActions,
}: ShellProps) {
  const [activeId, setActiveId] = useState<DestinationId>(initialDestination ?? "overview");
  // One per view: leaving Settings keeps detection and drafts in memory (RR-25).
  const [launchersSession] = useState(createLaunchersSession);
  const tabRefs = useRef<Partial<Record<DestinationId, HTMLButtonElement>>>({});
  // S9's `Go to {project}`, held until the Projects destination takes it.
  const [projectFocus, setProjectFocus] = useState<ProjectId | null>(null);

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
   * (UI-SPEC S1 "Primary line", R-06) or an approval request's
   * `{ proposalId }` (D-23): it sets `agent-runs-state.ts`'s `selectedRunId`
   * (or the approvals `selectedProposalId`) signal before switching tabs, so
   * Agent runs mounts with that item already selected, and raises its focus
   * request. The tab
   * itself still receives focus here; `AgentRuns`'s own mount effect then
   * moves it on to the detail heading only because that flag is set — a
   * plain tab switch never does.
   */
  function focusDestination(id: DestinationId, selection?: NavigationSelection): void {
    if (selection !== undefined && "runId" in selection) {
      selectedRunId.value = selection.runId;
      detailFocusRequested.value = true;
    } else if (selection !== undefined && "proposalId" in selection) {
      // D-23: a notification, link or button selects an approval request. The
      // Approvals section consumes the focus request exactly once. A task
      // task selections are handled below.
      selectedProposalId.value = selection.proposalId;
      approvalDetailFocusRequested.value = true;
    } else if (selection !== undefined && "taskId" in selection) {
      // A task selection (the Overview's due-today rows): the Tasks destination
      // selects it in the global context and its pane heading takes focus once.
      globalTasksContext.select(selection.taskId);
      taskDetailFocusRequested.value = true;
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
    dispatchQuickAction(descriptor, {
      navigate: focusDestination,
      notify,
      requestLaunch,
      openSwitcher,
      requestTaskForm: () => {
        taskFormRequested.value = true;
      },
      runSessionAction:
        sessionActions === undefined
          ? undefined
          : (action) => {
              void runSessionAction(action, sessionActionDeps(sessionActions));
            },
      // The host of an approval request (D-06): an enabled approval-required
      // capability (today only `session:terminate`) reaches the runner's own
      // confirm-then-request flow, which asks the service for a request and
      // executes nothing. Absent a runner host the dispatcher answers
      // unavailable. Without this member Force-terminate would never leave the
      // dispatcher, whatever the service's ready signal says.
      requestProposal:
        sessionActions === undefined
          ? undefined
          : (action) => {
              void runSessionAction(action, sessionActionDeps(sessionActions));
            },
    });
  }

  // A navigation request from outside this tree — the S9 switcher or the
  // `Set up launchers` command (plan 04-14) — is consumed once and cleared:
  // a request made before this shell mounted is honoured on mount.
  const request = navigationRequest.value;
  // Read in the same render as the request: `Set up launchers` sets both, and
  // the Launchers section — already mounted when Settings is open or is the
  // initial destination — moves focus to its heading. Focusing the Settings
  // tab here would overwrite that, whichever effect runs first (wave-7
  // finding 1).
  const launchersFocusPending = launchersFocusRequested.value;
  // `select`/`focusDestination` are per-render closures over stable setters;
  // the request value alone decides when this runs.
  useEffect(() => {
    if (request === null) return;
    // Compare-and-clear: with two command-center views open, both see the
    // same request, and only the first to get here takes it (wave-7
    // finding 4).
    if (navigationRequest.peek() !== request) return;
    navigationRequest.value = null;
    if (request.focusProposalId !== undefined) {
      focusDestination(request.destination, { proposalId: request.focusProposalId });
      return;
    }
    if (request.focusApprovalsHeading === true || request.openTaskForm === true) {
      // The section that owns the intent moves focus itself once it renders;
      // focusing the tab here would be overwritten, or would overwrite it.
      select(request.destination);
      return;
    }
    if (request.focusProjectId === undefined) {
      if (request.destination === "settings" && launchersFocusPending) select("settings");
      else focusDestination(request.destination);
      return;
    }
    select(request.destination);
    setProjectFocus(request.focusProjectId);
  }, [request]);

  function handleNavKeyDown(event: KeyboardEvent): void {
    let direction: "next" | "previous" | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") direction = "next";
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") direction = "previous";
    if (!direction) return;
    event.preventDefault();
    focusDestination(nextDestination(activeId, direction));
  }

  // What a widget body may reach of this host (findings 4 and 6): whether a
  // switcher is wired, and the RR-16 System Settings route.
  const switcherAvailable = openSwitcher !== undefined;
  const widgetHost = useMemo<WidgetHost>(
    () => ({ switcherAvailable, openSystemSettings }),
    [switcherAvailable, openSystemSettings],
  );

  const active = DESTINATIONS.find((d) => d.id === activeId) ?? DESTINATIONS[0];
  const pendingCount = pendingApprovalCount.value;
  const status = connectionState.value;
  const event = lastEvent.value;

  return (
    <WidgetHostContext.Provider value={widgetHost}>
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
        <DestinationTabs
          activeId={activeId}
          pendingCount={pendingCount}
          tabRefs={tabRefs}
          onSelect={select}
          onKeyDown={handleNavKeyDown}
        />
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
                scanActions={scanActions}
                pickFolder={pickFolder}
                openSystemSettings={openSystemSettings}
                launchersActions={launchersActions}
                launchersSession={launchersSession}
                focusProjectId={projectFocus}
                onProjectFocusTaken={() => setProjectFocus(null)}
                onProjectFocusMissing={() => tabRefs.current.projects?.focus()}
                loadSessionUsage={loadSessionUsage}
              />
            ) : (
              <p>{active.description}</p>
            );
          })()}
        </div>
      </div>
    </WidgetHostContext.Provider>
  );
}
