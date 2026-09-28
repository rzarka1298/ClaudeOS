import type { ProjectGitState } from "@ccc/domain";
import type { CommandRunner } from "./command-runner.js";

// RED skeleton (plan 04-04 Task 3): the hardened git runner, not implemented yet.

export const GIT_OVERRIDES: readonly string[] = [];

export function gitArgs(_root: string, _sub: readonly string[]): string[] {
  return [];
}

export function gitEnv(_root: string, _homeDir?: string): Record<string, string> {
  return {};
}

export type GitResolution = { kind: "available"; path: string } | { kind: "unavailable" };

export function resolveGit(
  _runner: CommandRunner,
  _isExecutable?: (path: string) => boolean,
): Promise<GitResolution> {
  return Promise.resolve({ kind: "unavailable" });
}

export interface GitRunner {
  readProject(root: string): Promise<ProjectGitState>;
}

export function createGitRunner(_options: {
  runner: CommandRunner;
  git: GitResolution;
  callTimeoutMs?: number;
  homeDir?: string;
}): GitRunner {
  return { readProject: () => Promise.resolve({ kind: "pending" }) };
}
