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

/** RED stub. */
export function SettingsDestination(props: SettingsDestinationProps): VNode {
  return (
    <LaunchersSettings
      actions={props.launchersActions}
      connection={props.connection}
      now={props.now}
      session={props.launchersSession}
    />
  );
}
