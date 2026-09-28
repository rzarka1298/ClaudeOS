import type {
  LaunchAction,
  LaunchErrorKind,
  LaunchGuard,
  LaunchRequest,
  LaunchResult,
  ProjectGitState,
  ProjectId,
  ProjectLookup,
} from "@ccc/domain";
import type { OperationalStore } from "@ccc/operational-store";
import type { Spawner } from "./spawner.js";

/** RED skeleton (04-06 Task 1). */
export const LAUNCH_CAP_MS = 4000;

export const ALLOW_ALL_GUARD: LaunchGuard = {
  check: () => Promise.resolve({ ok: true }),
};

export interface LaunchCollector {
  refresh(projectId: ProjectId): unknown;
  onRegistryChanged(): unknown;
  gitState(projectId: ProjectId): ProjectGitState | null;
}

export interface LaunchLogFields {
  readonly projectId: ProjectId | null;
  readonly action: LaunchAction;
  readonly kind: LaunchErrorKind | "ok";
}

export interface LaunchLogger {
  info(fields: LaunchLogFields, msg: string): void;
  warn(fields: LaunchLogFields, msg: string): void;
}

export interface LaunchServiceDeps {
  readonly store: OperationalStore;
  readonly spawner: Spawner;
  readonly lookup: ProjectLookup;
  readonly collector: LaunchCollector;
  readonly logger: LaunchLogger;
  readonly guard?: LaunchGuard;
  readonly capMs?: number;
}

export interface LaunchService {
  launch(request: LaunchRequest): Promise<LaunchResult>;
}

export function createLaunchService(_deps: LaunchServiceDeps): LaunchService {
  return {
    launch() {
      return Promise.resolve({ ok: false, error: "launcher-not-configured" });
    },
  };
}
