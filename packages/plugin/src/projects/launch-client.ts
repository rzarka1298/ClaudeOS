import type { LaunchAction, LaunchErrorKind, ProjectId } from "@ccc/domain";
import type { SocketApiClient } from "@ccc/service-api-client";
import type { ConnectionState } from "../connection-state.js";

/**
 * STUB (Task 1 RED phase). Real behavior lands in the GREEN commit.
 */
export const LAUNCH_DEADLINE_MS = 5000;

export function classifyLaunchFailure(_error: unknown): LaunchErrorKind {
  return "spawn-failed";
}

export interface CreateLaunchRequesterOptions {
  readonly client: SocketApiClient;
  readonly notify: (message: string) => void;
  readonly connection: () => ConnectionState;
  readonly projectName: (projectId: ProjectId | null) => string;
  readonly setTimer: (callback: () => void, ms: number) => number;
  readonly clearTimer: (id: number) => void;
}

export function createLaunchRequester(
  _deps: CreateLaunchRequesterOptions,
): (projectId: ProjectId | null, action: LaunchAction) => void {
  return (_projectId, _action) => {
    // not implemented
  };
}
