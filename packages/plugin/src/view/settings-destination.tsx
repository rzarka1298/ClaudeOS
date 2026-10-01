import type { VNode } from "preact";
import type { ConnectionState } from "../connection-state.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import { type LaunchersSession, LaunchersSettings } from "./launchers-settings.js";

export interface SettingsDestinationProps {
  readonly launchersActions: LaunchersActions;
  readonly launchersSession: LaunchersSession;
  readonly connection: ConnectionState;
  readonly now: number;
}

/**
 * The command center's own Settings destination (D-37). Phase 4 fills its
 * Launchers section (S6); diagnostics and the remaining settings arrive in
 * Phase 8, which the footer note says in so many words.
 */
export function SettingsDestination({
  launchersActions,
  launchersSession,
  connection,
  now,
}: SettingsDestinationProps): VNode {
  return (
    <div className="ccc-settings-section">
      <LaunchersSettings
        actions={launchersActions}
        connection={connection}
        now={now}
        session={launchersSession}
      />
      <p className="ccc-list-meta">
        Reduced motion is in Obsidian's settings under Claude command center. Diagnostics and the
        remaining settings arrive in a later phase.
      </p>
    </div>
  );
}
