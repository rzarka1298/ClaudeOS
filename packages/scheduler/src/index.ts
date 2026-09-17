// Owned by milestone 2 beyond this JobRun record shape (ADR-0013's
// milestone-1 scope). This package exists now, with only the record shape
// below, so the import-boundary lint (REPO-03, plan 01-03) has a real
// package to constrain from day one.

import type { RunId, RunState } from "@ccc/domain";

export interface JobRun {
  readonly jobRunId: RunId;
  readonly jobKey: string;
  readonly scheduledFor: string;
  readonly startedAt: string | null;
  readonly state: RunState;
  readonly idempotencyKey: string;
}
