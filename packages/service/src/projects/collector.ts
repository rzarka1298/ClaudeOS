import { EMPTY_PROJECTS_SNAPSHOT, type ProjectId, type ProjectsSnapshot } from "@ccc/domain";
import type { LauncherConfigRecord, ProjectRecord } from "@ccc/operational-store";
import type { EventBus } from "../events/event-bus.js";
import type { GitRunner } from "./git-runner.js";

// RED skeleton (plan 04-04 Task 3): the projects collector, not implemented yet.

export interface ProjectsCollector {
  start(): void;
  stop(): void;
  refresh(projectId?: ProjectId): void;
  onRegistryChanged(): void;
  snapshot(): ProjectsSnapshot;
}

export interface ProjectsCollectorOptions {
  readonly eventBus: Pick<EventBus, "publish" | "subscriberCount">;
  readonly gitRunner: GitRunner;
  readonly readRecords: () => readonly ProjectRecord[];
  readonly readLauncherConfigs: () => readonly LauncherConfigRecord[];
  readonly homeDir: string;
  readonly now?: () => Date;
  readonly intervalMs?: number;
  readonly concurrency?: number;
}

export function createProjectsCollector(_options: ProjectsCollectorOptions): ProjectsCollector {
  return {
    start() {},
    stop() {},
    refresh() {},
    onRegistryChanged() {},
    snapshot: () => EMPTY_PROJECTS_SNAPSHOT,
  };
}
