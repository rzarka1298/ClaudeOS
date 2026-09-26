// RED skeleton (plan 04-01 Task 1): typed exports only, so the failing tests
// fail on their assertions rather than on a missing module. GREEN replaces
// every schema below with the real contract.
import { z } from "zod";
import { API_BASE } from "./api.js";
import type { ProjectId } from "./ids.js";

function pending<T>(): z.ZodType<T> {
  return z.custom<T>(() => false);
}

export const PROTECTED_LOCATIONS = ["documents", "desktop", "downloads", "icloud-drive"] as const;
export type ProtectedLocation = (typeof PROTECTED_LOCATIONS)[number];

export const PROJECT_REGISTER_PATH = `${API_BASE}/projects/register-pending`;

export interface RegisterProjectRequest {
  path: string;
  acknowledgeProtectedLocation?: boolean;
}
export const RegisterProjectRequestSchema = pending<RegisterProjectRequest>();

export type RegisterProjectResponse =
  | { kind: "registered"; projectId: ProjectId }
  | { kind: "already-registered"; projectId: ProjectId }
  | { kind: "protected-location"; location: ProtectedLocation };
export const RegisterProjectResponseSchema = pending<RegisterProjectResponse>();

export type ProjectGitState = { kind: string };
export type GithubTarget = { kind: string };

export interface ProjectView {
  projectId: ProjectId;
  displayName: string;
  displayPath: string;
  pinned: boolean;
  lastOpenedAt: string | null;
  observedAt: string | null;
  gitReadFailed: boolean;
  git: ProjectGitState;
  github: GithubTarget;
}
export const ProjectViewSchema = pending<ProjectView>();

export const LAUNCHER_STATUSES = ["not-set-up", "set-up", "tested"] as const;
export type LauncherStatus = (typeof LAUNCHER_STATUSES)[number];
export interface LaunchersSummary {
  antigravity: LauncherStatus;
  "claude-code": { status: LauncherStatus; terminalLabel: string };
  "claude-desktop": LauncherStatus;
}

export interface ProjectsSnapshot {
  projects: ProjectView[];
  launchers: LaunchersSummary;
}
export const ProjectsSnapshotSchema = pending<ProjectsSnapshot>();

export const EMPTY_PROJECTS_SNAPSHOT: ProjectsSnapshot = {
  projects: [],
  launchers: {
    antigravity: "not-set-up",
    "claude-code": { status: "not-set-up", terminalLabel: "" },
    "claude-desktop": "not-set-up",
  },
};

export interface ProjectsUpdatedPayload {
  upserted: ProjectView[];
  removed: ProjectId[];
  launchers?: LaunchersSummary;
}
export const ProjectsUpdatedPayloadSchema = pending<ProjectsUpdatedPayload>();

export function compareProjectViews(
  _a: Pick<ProjectView, "pinned" | "lastOpenedAt" | "displayName">,
  _b: Pick<ProjectView, "pinned" | "lastOpenedAt" | "displayName">,
): number {
  throw new Error("compareProjectViews is not implemented yet (packages/domain/src/projects.ts)");
}
