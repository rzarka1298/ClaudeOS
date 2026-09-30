import type { GithubTarget, ProjectId } from "@ccc/domain";
import type { VNode } from "preact";
import type { DestinationId } from "../view/destinations.js";
import type { QuickActionDescriptor } from "./contract.js";

/**
 * STUB (Task 1 RED phase). Real behavior lands in the GREEN commit.
 */
export interface LaunchToolbarProps {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly github: GithubTarget;
  readonly terminalLabel: string;
  readonly onQuickAction?: ((descriptor: QuickActionDescriptor) => void) | undefined;
  readonly inProjects?: boolean | undefined;
  readonly onNavigate?: ((destination: DestinationId) => void) | undefined;
  readonly openSystemSettings?: ((pane: "automation" | "privacy-security") => void) | undefined;
}

export function LaunchToolbar(_props: LaunchToolbarProps): VNode | null {
  return null;
}
