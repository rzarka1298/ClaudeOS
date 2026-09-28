import type { LaunchersSummary, ProjectGitState, ProjectView } from "@ccc/domain";
import type { LauncherConfigRecord, ProjectRecord } from "@ccc/operational-store";

// RED skeleton (plan 04-04 Task 1): typed, not implemented yet.

export function toDisplayPath(_absolutePath: string, _homeDir: string): string {
  throw new Error("not implemented");
}

export function buildProjectView(
  _record: ProjectRecord,
  _git: ProjectGitState,
  _observedAt: string | null,
  _gitReadFailed: boolean,
  _homeDir: string,
): ProjectView {
  throw new Error("not implemented");
}

export function launchersSummary(_configs: readonly LauncherConfigRecord[]): LaunchersSummary {
  throw new Error("not implemented");
}
