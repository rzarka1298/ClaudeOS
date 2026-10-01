import type { VNode } from "preact";
import type { ConnectionState } from "../connection-state.js";
import type { LaunchersActions } from "../projects/launchers-actions.js";
import type { LaunchersSession } from "./launchers-settings.js";

/** RED stub. */
export interface ClaudeCodePanelProps {
  readonly actions: LaunchersActions;
  readonly session: LaunchersSession;
  readonly connection: ConnectionState;
  readonly now: number;
  readonly sampleDisplayPath: string;
}

export function ClaudeCodePanel(_props: ClaudeCodePanelProps): VNode {
  return <section />;
}
