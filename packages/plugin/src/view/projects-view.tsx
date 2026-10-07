import type { VNode } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import type { FolderPick, PickFolderOptions } from "../projects/folder-picker.js";
import type { ProjectsActions, ScanActions } from "../projects/projects-actions.js";
import {
  projectRowsFrom,
  projectsReceivedAt,
  projectsSnapshot,
} from "../projects/projects-state.js";
import { applyScanState, scanState } from "../projects/scan-state.js";
import type { QuickActionDescriptor } from "../widgets/contract.js";
import { formatRelativeTime } from "../widgets/relative-time.js";
import type { DestinationId } from "./destinations.js";
import { ProjectCard } from "./project-card.js";
import { ProjectTasksPanel } from "./project-tasks.js";
import { RegisterFlow } from "./register-flow.js";
import { AddScanFolderFlow, ScanFolders } from "./scan-folders.js";
import { launchersNeedSetup, SetupCallout } from "./setup-callout.js";

/**
 * The S3 Projects destination (Task 1: the grid of cards; Task 2: the full
 * S4 register flow via `RegisterFlow`; Task 3: loading/empty/error states,
 * the disconnected banner, and focus restoration after register/remove).
 */
export interface ProjectsViewProps {
  readonly actions: ProjectsActions;
  /** Scan folders and suggestions (S5, plan 04-13); absent in a partial composition. */
  readonly scanActions?: ScanActions | undefined;
  readonly pickFolder: (options: PickFolderOptions) => Promise<FolderPick>;
  readonly connection: ConnectionState;
  readonly now: number;
  readonly onQuickAction?: ((descriptor: QuickActionDescriptor) => void) | undefined;
  readonly onNavigate?: ((destination: DestinationId) => void) | undefined;
  /** Opens one of the two fixed System Settings panes (RR-16) from a launch error's button. */
  readonly openSystemSettings?: ((pane: "automation" | "privacy-security") => void) | undefined;
  /** S9's `Go to {project}` (plan 04-14): focus this card's heading once its row renders. */
  readonly focusProjectId?: string | null | undefined;
  /** Called as soon as the request is taken, so it is honoured once. */
  readonly onProjectFocusTaken?: (() => void) | undefined;
  /** Called when the requested project is not among the loaded projects (wave-7 finding 6). */
  readonly onProjectFocusMissing?: (() => void) | undefined;
}

/**
 * The S3 search hint. `⌘K` is the D-33 view-scoped binding (`Mod+K`)
 * rendered for macOS, the only v1 platform (`isDesktopOnly`, ADR-0001).
 */
const SEARCH_HINT =
  "Search projects and actions: ⌘K while the command center has focus, or from the command palette.";

/** A ref-map key: one entry per project's per-control DOM node this view needs to refocus (currently only its name heading). */
function headingKey(projectId: string): string {
  return `${projectId}:heading`;
}

/** Resolves `failed` for every scan action, so the view renders honestly without a host. */
const FAILED_SCAN = (): Promise<{ kind: "failed" }> => Promise.resolve({ kind: "failed" });
const NO_SCAN_ACTIONS: ScanActions = {
  addScanRoot: FAILED_SCAN,
  removeScanRoot: FAILED_SCAN,
  rescan: FAILED_SCAN,
  listScanState: FAILED_SCAN,
  registerSuggestion: FAILED_SCAN,
  dismissSuggestion: FAILED_SCAN,
  suggestionsPage: FAILED_SCAN,
};

/** A ref-map key for a project's Show tasks button. */
function tasksKey(projectId: string): string {
  return `${projectId}:tasks`;
}

export function ProjectsView({
  actions,
  scanActions = NO_SCAN_ACTIONS,
  pickFolder,
  connection,
  now,
  onQuickAction,
  onNavigate,
  openSystemSettings,
  focusProjectId,
  onProjectFocusTaken,
  onProjectFocusMissing,
}: ProjectsViewProps): VNode {
  const snapshot = projectsSnapshot.value;
  const rows = snapshot === undefined ? [] : projectRowsFrom(snapshot);
  const displayPathById = new Map<string, string>(
    (snapshot?.projects ?? []).map((view) => [view.projectId, view.displayPath]),
  );

  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  // S9's `Go to {project}`, held until the projects are loaded.
  const [goToFocusId, setGoToFocusId] = useState<string | null>(null);
  // View-owned, so it outlives the card whose removal it announces (the
  // card and its own status region unmount with the row).
  const [announcement, setAnnouncement] = useState("");
  const registerOpenerRef = useRef<HTMLButtonElement | null>(null);
  const controlRefs = useRef(new Map<string, HTMLElement>());
  // The one open project tasks panel (plan 06-22): only one at a time, in memory only.
  const [tasksProjectId, setTasksProjectId] = useState<string | null>(null);

  function closeTasksPanel(projectId: string): void {
    setTasksProjectId(null);
    controlRefs.current.get(tasksKey(projectId))?.focus();
  }

  // The scan state is read once when the destination opens and again each
  // time the service comes back (a restart forgets every suggestion, D-07).
  // Never on a timer: scans themselves run only on the owner's request.
  // `scanActions` is a stable host-built object, not a dependency to track.
  useEffect(() => {
    if (connection.kind !== "live") return;
    let cancelled = false;
    void scanActions.listScanState().then((outcome) => {
      if (!cancelled && outcome.kind === "state") applyScanState(outcome.state);
    });
    return () => {
      cancelled = true;
    };
  }, [connection.kind]);

  // Focus follows a newly registered project, a duplicate, or the next card
  // after a removal onto the dashboard only once its row actually settles in
  // `projectsSnapshot` — a register response carries a `projectId`, not the
  // project's rendered data, which arrives moments later over the event
  // stream (D-11). Focusing before the row exists would move focus to
  // nothing.
  useEffect(() => {
    if (pendingFocusId === null) return;
    if (!rows.some((row) => row.id === pendingFocusId)) return;
    controlRefs.current.get(headingKey(pendingFocusId))?.focus();
    setPendingFocusId(null);
    // `controlRefs` is a stable ref container, not reactive state.
  }, [rows, pendingFocusId]);

  // S9's `Go to {project}` (plan 04-14). Unlike a registration — whose row
  // is still on its way — the switcher listed a project already loaded, so
  // once projects are loaded the row either exists and its heading takes
  // focus, or it was removed meanwhile: then the request is forgotten and
  // the host focuses the Projects tab rather than leaving focus nowhere or
  // stealing it later (wave-7 finding 6).
  // The host's callback is a per-render closure; the id alone decides when this runs.
  useEffect(() => {
    if (focusProjectId === null || focusProjectId === undefined) return;
    setGoToFocusId(focusProjectId);
    onProjectFocusTaken?.();
  }, [focusProjectId]);

  const projectsLoaded = snapshot !== undefined;
  useEffect(() => {
    if (goToFocusId === null || !projectsLoaded) return;
    setGoToFocusId(null);
    if (rows.some((row) => row.id === goToFocusId)) {
      controlRefs.current.get(headingKey(goToFocusId))?.focus();
    } else {
      onProjectFocusMissing?.();
    }
    // `controlRefs` is a stable ref container; `rows` is derived from the
    // same snapshot `projectsLoaded` tracks.
  }, [goToFocusId, projectsLoaded]);

  function handleRemoved(removedId: string, removedName: string): void {
    setAnnouncement(`Removed ${removedName} from projects.`);
    const index = rows.findIndex((row) => row.id === removedId);
    const next = rows[index + 1] ?? (index > 0 ? rows[index - 1] : undefined);
    if (next === undefined) {
      registerOpenerRef.current?.focus();
      return;
    }
    setPendingFocusId(next.id);
  }

  const registerFlow = (
    <>
      <RegisterFlow
        actions={actions}
        pickFolder={pickFolder}
        onRegistered={setPendingFocusId}
        onDuplicate={setPendingFocusId}
        openerRef={registerOpenerRef}
      />
      <AddScanFolderFlow actions={scanActions} pickFolder={pickFolder} />
      <p className="ccc-list-meta">{SEARCH_HINT}</p>
    </>
  );

  if (snapshot === undefined) {
    // Until the first snapshot arrives the view is loading — including the
    // moment between the event stream going live and its first snapshot
    // event. Only a dropped connection with nothing ever received is a load
    // error.
    if (connection.kind !== "disconnected") {
      return (
        <div className="ccc-projects-section">
          {registerFlow}
          <h3 className="ccc-section-label">Registered projects</h3>
          <div aria-busy="true" className="ccc-projects-grid">
            <span className="ccc-visually-hidden">Loading projects</span>
            <div className="ccc-card">
              <p className="ccc-skeleton-line" />
              <p className="ccc-skeleton-line" />
            </div>
            <div className="ccc-card">
              <p className="ccc-skeleton-line" />
              <p className="ccc-skeleton-line" />
            </div>
            <div className="ccc-card">
              <p className="ccc-skeleton-line" />
              <p className="ccc-skeleton-line" />
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="ccc-projects-section">
        {registerFlow}
        <p className="ccc-state-body">
          ▲ Couldn't load projects. Check the service in Settings → Diagnostics, then refresh.
        </p>
      </div>
    );
  }

  return (
    <div className="ccc-projects-section">
      {/* UI-SPEC S3 reading order 1: the S10 callout while no launcher is set up (D-30). */}
      {launchersNeedSetup(snapshot.launchers) && <SetupCallout onNavigate={onNavigate} />}
      {connection.kind === "disconnected" && (
        <div className="ccc-banner">
          <p className="ccc-state-heading">Service disconnected</p>
          <p className="ccc-state-body">
            {`Showing the last projects received ${
              projectsReceivedAt.value === null
                ? "a moment ago"
                : formatRelativeTime(projectsReceivedAt.value, now)
            }. They may be out of date. Launches and changes resume when the service reconnects.`}
          </p>
        </div>
      )}
      {registerFlow}
      <p role="status" className="ccc-state-body">
        {announcement}
      </p>
      <h3 className="ccc-section-label">Registered projects</h3>
      {rows.length === 0 ? (
        <div className="ccc-projects-empty">
          <h4 className="ccc-state-heading">Nothing here yet</h4>
          <p className="ccc-state-body">
            Register a folder to open it in Antigravity, Claude Code, Finder or GitHub from here.
          </p>
        </div>
      ) : (
        <div className="ccc-projects-grid">
          {rows.map((row) => (
            <ProjectCard
              key={row.id}
              row={row}
              displayPath={displayPathById.get(row.id) ?? ""}
              now={now}
              connection={connection}
              actions={actions}
              onRemoved={handleRemoved}
              onQuickAction={onQuickAction}
              terminalLabel={snapshot?.launchers["claude-code"].terminalLabel}
              onNavigate={onNavigate}
              openSystemSettings={openSystemSettings}
              onShowTasks={() => setTasksProjectId(row.id)}
              showTasksRef={(el) => {
                const key = tasksKey(row.id);
                if (el) controlRefs.current.set(key, el);
                else controlRefs.current.delete(key);
              }}
              headingRef={(el) => {
                const key = headingKey(row.id);
                if (el) controlRefs.current.set(key, el);
                else controlRefs.current.delete(key);
              }}
            />
          ))}
        </div>
      )}
      {(() => {
        const open = rows.find((row) => row.id === tasksProjectId);
        return open === undefined ? null : (
          <ProjectTasksPanel
            key={open.id}
            projectId={open.id}
            projectName={open.name}
            connection={connection}
            now={now}
            projects={rows.map((row) => ({ id: row.id, name: row.name }))}
            onClose={() => closeTasksPanel(open.id)}
          />
        );
      })()}
      <ScanFolders state={scanState.value} actions={scanActions} now={now} />
    </div>
  );
}
