import type Database from "better-sqlite3";
import type { ProjectId, RunId, RunState } from "@ccc/domain";

/**
 * STUB — deliberately incomplete for the RED phase of Task 2's TDD cycle.
 * Replaced by the real implementation before the GREEN commit.
 */
export type RunKind = "session" | "automation";

export interface RunRecord {
  readonly runId: RunId;
  readonly kind: RunKind;
  readonly projectId: ProjectId | null;
  readonly claudeSessionId: string | null;
  readonly state: RunState;
  readonly startedAt: string;
  readonly lastActivityAt: string | null;
  readonly endedAt: string | null;
}

export class InvalidRunStateError extends Error {
  constructor(value: string) {
    super(`not implemented: ${value}`);
    this.name = "InvalidRunStateError";
  }
}

export function insertRun(_db: Database.Database, _run: RunRecord): void {
  throw new Error("not implemented");
}

export function getRun(_db: Database.Database, _runId: RunId): RunRecord | null {
  throw new Error("not implemented");
}

export function updateRunState(_db: Database.Database, _runId: RunId, _state: RunState): void {
  throw new Error("not implemented");
}

export function listNonTerminalRuns(_db: Database.Database): RunRecord[] {
  throw new Error("not implemented");
}
