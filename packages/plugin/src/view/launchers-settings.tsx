import type { VNode } from "preact";
import type { ConnectionState } from "../connection-state.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";

/** RED stub. */
export function requestLaunchersFocus(): void {}

export interface LaunchersSession {
  readonly stub: true;
}

export function createLaunchersSession(): LaunchersSession {
  return { stub: true };
}

export interface LaunchersSettingsProps {
  readonly actions: LaunchersActions;
  readonly connection: ConnectionState;
  readonly now: number;
  readonly session?: LaunchersSession | undefined;
}

export function LaunchersSettings(_props: LaunchersSettingsProps): VNode {
  return <div />;
}
