// Owned by milestone 2 beyond the JobRun record shape and the pure ADR-09
// functions below (ADR-0013's milestone-1 scope, and the ADR that completes
// it). No clock loop fires in milestone 1.

import type { RunId, RunState } from "@ccc/domain";

export * from "./idempotency-key.js";

export interface JobRun {
  readonly jobRunId: RunId;
  readonly jobKey: string;
  readonly scheduledFor: string;
  readonly startedAt: string | null;
  readonly state: RunState;
  readonly idempotencyKey: string;
}
