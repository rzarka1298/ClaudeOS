import type {
  JobRunOutcome,
  ResearchStage,
  RunErrorCode,
  RunId,
  SourceFailureCode,
} from "@ccc/domain";
import type Database from "better-sqlite3";

// Signature stubs only (red step of TDD, plan 07-06 task 1). Nothing here works yet.

/** What started a job run. Mirrors `JOB_RUN_TRIGGERS` in `@ccc/scheduler`, which this package may not import. */
export const JOB_RUN_TRIGGERS = ["manual", "scheduled"] as const;
export type JobRunTrigger = (typeof JOB_RUN_TRIGGERS)[number];

export interface StartJobRunInput {
  readonly jobRunId: RunId;
  readonly jobKey: string;
  readonly idempotencyKey: string;
  readonly trigger: JobRunTrigger;
  readonly startedAt: string;
  readonly scheduledFor?: string;
}

export type StartJobRunResult =
  | { readonly started: true }
  | { readonly started: false; readonly inFlightRunId: RunId };

export interface JobRunStageEntry {
  readonly stage: ResearchStage;
  readonly at: string;
  readonly noteIds: readonly string[];
  readonly counts?: Readonly<Record<string, number>>;
}

export interface UnavailableSource {
  readonly sourceId: string;
  readonly code: SourceFailureCode;
}

export interface FinishJobRunInput {
  readonly outcome: JobRunOutcome;
  readonly endedAt: string;
  readonly sourceCount: number;
  readonly sourceTotal: number;
  readonly reportNoteId: string | null;
  readonly unavailableSources: readonly UnavailableSource[];
  readonly errorCode: RunErrorCode | null;
}

export function startJobRun(_db: Database.Database, _input: StartJobRunInput): StartJobRunResult {
  throw new Error("not implemented");
}

export function appendJobRunStage(
  _db: Database.Database,
  _jobRunId: RunId,
  _entry: JobRunStageEntry,
): void {
  throw new Error("not implemented");
}

export function finishJobRun(
  _db: Database.Database,
  _jobRunId: RunId,
  _input: FinishJobRunInput,
): void {
  throw new Error("not implemented");
}
