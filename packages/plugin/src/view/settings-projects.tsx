import type { VNode } from "preact";
import { useId } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import type { FolderPick, PickFolderOptions } from "../projects/folder-picker.js";
import type { ProjectsActions, ScanActions } from "../projects/projects-actions.js";
import { scanState } from "../projects/scan-state.js";
import { requestDestination } from "./navigation-request.js";
import { RegisterFlow } from "./register-flow.js";
import { AddScanFolderFlow, ScanFolders } from "./scan-folders.js";
import { SERVICE_AWAY_REASON } from "./settings-controls.js";
import { useScanState } from "./use-scan-state.js";

/**
 * The Projects section of the Settings destination (plan 08-11 Task 2; 08-UI-SPEC S2 Projects,
 * G2, D-15, D-16).
 *
 * The same register flow, Add a scan folder and scan list the Projects destination uses (the
 * components are shared, so the Phase 4 UAT items stay valid there), loaded by the same
 * scan-state hook. What this section adds is the frame around them: an outcome in the
 * destination's one status line, a link to the Projects destination, and the service-away
 * treatment. Projects, scan folders and display paths stay service-owned and in memory: nothing
 * here is written to `data.json` (D-16).
 */

export const PROJECTS_SECTION_DESCRIPTION =
  "Register project folders and choose folders to scan for projects.";
export const PROJECT_REGISTERED_NOTICE = "Project registered.";
/** The S1 note shown under a service-owned section's description while the service is away. */
export const SERVICE_OWNED_AWAY_NOTE =
  "Projects, launchers and paths are managed by the companion service, which isn't running. They are read-only until it is back.";
/** The existing Projects-destination line for a list that could not be read. */
const SCAN_LOAD_ERROR =
  "▲ Couldn't load projects. Check the service in Settings → Diagnostics, then refresh.";
/** R-F1: a destination is a view, named in lower case after a lower-case word. */
export const GO_TO_PROJECTS_VIEW = "Go to the projects view";

export interface ProjectsSettingsProps {
  readonly connection: ConnectionState;
  readonly now: number;
  readonly projectsActions: ProjectsActions;
  readonly scanActions: ScanActions;
  readonly pickFolder: (options: PickFolderOptions) => Promise<FolderPick>;
  /** Posts an outcome to the destination's status line. */
  readonly notify: (message: string) => void;
}

export function ProjectsSettings({
  connection,
  now,
  projectsActions,
  scanActions,
  pickFolder,
  notify,
}: ProjectsSettingsProps): VNode {
  const reasonId = useId();
  const away = connection.kind === "disconnected";
  const phase = useScanState(scanActions, connection);
  const state = scanState.value;

  // What the scan list can say. A state in hand is always shown (a reconnect re-reads behind
  // it); with none, an unfinished read is loading and a failed or unreachable one is an error:
  // never "no scan folders", which would claim an answer nobody gave.
  const unanswered = state === undefined;
  const loading = unanswered && !away && phase !== "failed";
  const failed = unanswered && (away || phase === "failed");

  return (
    <section className="ccc-settings-section ccc-projects-section">
      <h3 tabIndex={-1} className="ccc-settings-section-title">
        Projects
      </h3>
      <p>{PROJECTS_SECTION_DESCRIPTION}</p>
      {away && (
        <>
          <p className="ccc-list-meta">{SERVICE_OWNED_AWAY_NOTE}</p>
          {/* Undimmed, separate from the dimmed controls, and what each of them is described by. */}
          <p id={reasonId} className="ccc-field-help">
            {SERVICE_AWAY_REASON}
          </p>
        </>
      )}
      <RegisterFlow
        actions={projectsActions}
        pickFolder={pickFolder}
        onRegistered={() => notify(PROJECT_REGISTERED_NOTICE)}
        // The flow's own status already says which project it is; nothing to add up here.
        onDuplicate={() => {}}
        unavailable={away ? { reasonId } : undefined}
      />
      <AddScanFolderFlow
        actions={scanActions}
        pickFolder={pickFolder}
        unavailable={away ? { reasonId } : undefined}
      />
      {loading && (
        <div aria-busy="true">
          <span className="ccc-visually-hidden">Loading projects</span>
          <p className="ccc-skeleton-line" />
          <p className="ccc-skeleton-line" />
          <p className="ccc-skeleton-line" />
        </div>
      )}
      {failed && <p className="ccc-state-body">{SCAN_LOAD_ERROR}</p>}
      {!loading && !failed && <ScanFolders state={state} actions={scanActions} now={now} />}
      <button
        type="button"
        className="ccc-list-more"
        data-variant="tertiary"
        onClick={() => requestDestination("projects")}
      >
        {GO_TO_PROJECTS_VIEW}
      </button>
    </section>
  );
}
