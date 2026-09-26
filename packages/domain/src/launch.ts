// RED skeleton (plan 04-01 Task 3): the vocabulary and port types are
// declared; every schema rejects everything and every function throws, so
// the failing tests fail on their assertions. GREEN replaces the schemas.
import { z } from "zod";
import { API_BASE } from "./api.js";
import type { ProjectId } from "./ids.js";

function pending(): z.ZodType<unknown> {
  return z.custom<unknown>(() => false);
}

export const LAUNCH_ACTIONS = [
  "antigravity",
  "claude-code",
  "finder",
  "github",
  "claude-desktop",
] as const;
export type LaunchAction = (typeof LAUNCH_ACTIONS)[number];

export const LAUNCH_ERROR_KINDS = [
  "service-disconnected",
  "launcher-not-configured",
  "app-not-found",
  "project-missing",
  "project-moved",
  "no-github-remote",
  "automation-denied",
  "folder-access-denied",
  "timeout",
  "spawn-failed",
] as const;
export type LaunchErrorKind = (typeof LAUNCH_ERROR_KINDS)[number];

export const LAUNCHER_IDS = ["antigravity", "claude-code", "claude-desktop"] as const;
export type LauncherId = (typeof LAUNCHER_IDS)[number];

export const LAUNCH_PATH = `${API_BASE}/projects/launch-pending`;
export const LaunchRequestSchema = pending();
export type LaunchResult = { ok: true } | { ok: false; error: LaunchErrorKind };
export const LaunchResultSchema = pending();
export const SaveLauncherConfigRequestSchema = pending();
export const SystemSettingsPaneSchema = pending();
export const TestLauncherRequestSchema = pending();
export const TEMPLATE_REFUSAL_REASONS: readonly string[] = [];
export const LauncherConfigRefusalBodySchema = pending();

export function parseStoredLauncherConfig(_launcherId: string, _json: unknown): unknown {
  throw new Error(
    "parseStoredLauncherConfig is not implemented yet (packages/domain/src/launch.ts)",
  );
}

export interface TerminalLaunchInput {
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}
export interface TerminalLauncher {
  launch(input: TerminalLaunchInput): Promise<LaunchResult>;
}
export interface ResolvedProject {
  readonly projectId: ProjectId;
  readonly path: string;
  readonly displayName: string;
}
