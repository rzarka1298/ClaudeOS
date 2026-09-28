import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectId, ProjectsSnapshot } from "@ccc/domain";

// RED skeleton (plan 04-04 Task 1): the route table is empty until GREEN.

/** What the project routes and the snapshot need from the running service. */
export interface ProjectServices {
  snapshot(): ProjectsSnapshot;
  onRegistryChanged(): void;
  refresh(projectId?: ProjectId): void;
  readonly homeDir: string;
  readonly runtimeDir: string;
}

type SkeletonHandler = (req: IncomingMessage, res: ServerResponse, ctx: unknown) => void;

export const projectRoutes: Record<string, Record<string, SkeletonHandler>> = {};
