// Owned by Phase 4 (project registration, git state, application and
// terminal launchers). This package exists now, with an empty functional
// surface, so the import-boundary lint (REPO-03, plan 01-03) has a real
// package to constrain from day one.

/** The mechanism that opens a Project in an external macOS application. */
export interface Launcher {
  readonly launcherId: string;
}
