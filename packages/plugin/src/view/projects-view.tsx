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
}

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
};

export function ProjectsView({
  actions,
  scanActions = NO_SCAN_ACTIONS,
  pickFolder,
  connection,
  now,
  onQuickAction,
  onNavigate,
  openSystemSettings,
}: ProjectsViewProps): VNode {
  const snapshot = projectsSnapshot.value;
  const rows = snapshot === undefined ? [] : projectRowsFrom(snapshot);
  const displayPathById = new Map<string, string>(
    (snapshot?.projects ?? []).map((view) => [view.projectId, view.displayPath]),
  );

  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  // View-owned, so it outlives the card whose removal it announces (the
  // card and its own status region unmount with the row).
  const [announcement, setAnnouncement] = useState("");
  const registerOpenerRef = useRef<HTMLButtonElement | null>(null);
  const controlRefs = useRef(new Map<string, HTMLElement>());

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
          <h3 className="ccc-state-heading">Registered projects</h3>
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
      <h3 className="ccc-state-heading">Registered projects</h3>
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
              headingRef={(el) => {
                const key = headingKey(row.id);
                if (el) controlRefs.current.set(key, el);
                else controlRefs.current.delete(key);
              }}
            />
          ))}
        </div>
      )}
      <ScanFolders state={scanState.value} actions={scanActions} now={now} />
    </div>
  );
}
