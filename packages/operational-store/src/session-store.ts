import type { RunId, SessionRun } from "@ccc/domain";
import type Database from "better-sqlite3";

// RED signature stub (05-05 Task 1): the behavior lands in the GREEN commit.

export function upsertSessionRun(_db: Database.Database, _run: SessionRun): void {}

export function getSessionRun(_db: Database.Database, _runId: RunId): SessionRun | null {
  return null;
}

export function findRunByIdentity(
  _db: Database.Database,
  _claudeSessionId: string,
  _pid: number | null,
): SessionRun | null {
  return null;
}
