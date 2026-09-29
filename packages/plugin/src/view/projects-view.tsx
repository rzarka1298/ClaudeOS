import type { VNode } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import type { FolderPick, PickFolderOptions } from "../projects/folder-picker.js";
import type { ProjectsActions } from "../projects/projects-actions.js";
import { projectRowsFrom, projectsSnapshot } from "../projects/projects-state.js";
import type { QuickActionDescriptor } from "../widgets/contract.js";
import type { DestinationId } from "./destinations.js";
import { ProjectCard } from "./project-card.js";
import { RegisterFlow } from "./register-flow.js";

/**
 * The S3 Projects destination (Task 1: the grid of cards; Task 2: the full
 * S4 register flow via `RegisterFlow`; Task 3 completes the card anatomy and
 * adds the manage toolbar).
 */
export interface ProjectsViewProps {
  readonly actions: ProjectsActions;
  readonly pickFolder: (options: PickFolderOptions) => Promise<FolderPick>;
  readonly connection: ConnectionState;
  readonly now: number;
  readonly onQuickAction?: ((descriptor: QuickActionDescriptor) => void) | undefined;
  readonly onNavigate?: ((destination: DestinationId) => void) | undefined;
}

export function ProjectsView({ actions, pickFolder, now }: ProjectsViewProps): VNode {
  const snapshot = projectsSnapshot.value;
  const rows = snapshot === undefined ? [] : projectRowsFrom(snapshot);
  const displayPathById = new Map<string, string>(
    (snapshot?.projects ?? []).map((view) => [view.projectId, view.displayPath]),
  );

  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const registerOpenerRef = useRef<HTMLButtonElement | null>(null);
  const headingRefs = useRef(new Map<string, HTMLHeadingElement>());

  // Focus follows a newly registered (or duplicate) project onto the
  // dashboard only once its row actually arrives — the register response
  // carries a `projectId`, not the project's rendered data, which arrives
  // moments later over the event stream (D-11). Focusing before the row
  // exists would move focus to nothing.
  useEffect(() => {
    if (pendingFocusId === null) return;
    if (!rows.some((row) => row.id === pendingFocusId)) return;
    headingRefs.current.get(pendingFocusId)?.focus();
    setPendingFocusId(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: `headingRefs` is a stable ref container, not reactive state.
  }, [rows, pendingFocusId]);

  return (
    <div className="ccc-projects-section">
      <RegisterFlow
        actions={actions}
        pickFolder={pickFolder}
        onRegistered={setPendingFocusId}
        onDuplicate={setPendingFocusId}
        openerRef={registerOpenerRef}
      />
      <h3 className="ccc-state-heading">Registered projects</h3>
      {rows.length === 0 ? (
        <p className="ccc-state-body">
          Register a folder to open it in Antigravity, Claude Code, Finder or GitHub from here.
        </p>
      ) : (
        <div className="ccc-projects-grid">
          {rows.map((row) => (
            <ProjectCard
              key={row.id}
              row={row}
              displayPath={displayPathById.get(row.id) ?? ""}
              now={now}
              headingRef={(el) => {
                if (el) headingRefs.current.set(row.id, el);
                else headingRefs.current.delete(row.id);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
