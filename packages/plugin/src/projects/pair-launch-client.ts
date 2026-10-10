import type { LaunchPairRequest, LaunchPairResponse, ProjectId } from "@ccc/domain";
import type { SocketApiClient } from "@ccc/service-api-client";
import type { ConnectionState } from "../connection-state.js";
import type { ConflictChooser } from "./launch-client.js";
import type { LaunchTimerControls } from "./launch-status.js";

export interface CreatePairRequesterOptions {
  readonly client: SocketApiClient;
  /** Shows an Obsidian Notice: the durable record beside the inline lines. */
  readonly notify: (message: string) => void;
  readonly connection: () => ConnectionState;
  /** The project's display name for a Notice's `{project}`; `null` when unknown. */
  readonly projectName: (projectId: ProjectId) => string | null;
  /** The Claude Code terminal's display label for `{Terminal}`. Defaults to `Terminal`. */
  readonly terminalLabel?: (() => string) | undefined;
  readonly isDisposed?: (() => boolean) | undefined;
  readonly holdStatus?: (() => () => void) | undefined;
  readonly chooseOnConflict?: ConflictChooser | undefined;
  readonly setTimer: LaunchTimerControls["setTimer"];
  readonly clearTimer: LaunchTimerControls["clearTimer"];
  /** Posts the strict pair request. Defaults to the service client's `launchPair`. */
  readonly launchPair?:
    | ((client: SocketApiClient, request: LaunchPairRequest) => Promise<LaunchPairResponse>)
    | undefined;
}

export function createPairRequester(
  options: CreatePairRequesterOptions,
): (projectId: ProjectId) => void {
  void options;
  return () => {};
}
