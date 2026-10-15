// Owned by milestone 2 beyond the JobRun record shape and the pure ADR-09
// functions below (ADR-0013's milestone-1 scope, and the ADR that completes
// it). No clock loop fires in milestone 1.

import type { JobRunOutcome, RunErrorCode, RunId, RunState } from "@ccc/domain";

export * from "./idempotency-key.js";
export * from "./outcome.js";
export * from "./window.js";

/** What started a job run. A scheduled trigger is milestone-2 work and is never produced in milestone 1. */
export const JOB_RUN_TRIGGERS = ["manual", "scheduled"] as const;
export type JobRunTrigger = (typeof JOB_RUN_TRIGGERS)[number];

export interface JobRun {
  readonly jobRunId: RunId;
  readonly jobKey: string;
  readonly scheduledFor: string;
  readonly startedAt: string | null;
  readonly state: RunState;
  readonly idempotencyKey: string;
  /** When the run ended; null while it runs and for a run that went stale. */
  readonly endedAt: string | null;
  /** Null while running and forever for a stale run (a stale run never invents a terminal outcome). */
  readonly outcome: JobRunOutcome | null;
  readonly errorCode: RunErrorCode | null;
  /** The id of the report note the run wrote, or null when none was written. */
  readonly reportNoteId: string | null;
  /** Sources that contributed text. */
  readonly sourceCount: number | null;
  /** Sources the run tried. */
  readonly sourceTotal: number | null;
  readonly trigger: JobRunTrigger | null;
}
