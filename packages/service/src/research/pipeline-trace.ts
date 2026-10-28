import type {
  JobRunOutcome,
  ResearchSourcesConfig,
  ResearchStage,
  ResearchUpdatedPayload,
  RunErrorCode,
  RunId,
  SourceFailureCode,
  SummariserId,
} from "@ccc/domain";
import { appendJobRunStage } from "@ccc/operational-store";
import type Database from "better-sqlite3";
import type { TextTransport } from "../untrusted/index.js";
import type { SafeFetcher } from "./fetch/index.js";
import { nameEffect, PIPELINE_EFFECTS, type PipelineEffect } from "./pipeline-effects.js";
import type { RunNoteSource, RunNoteStage, WrittenRunNote } from "./run-note.js";
import type { ResearchSourcesFs, SourcesRefusal } from "./sources-config.js";

/**
 * The run's live record and the helpers every stage shares (09-12, D-12): the dependency and result
 * types, the RunTrace, the two failure classes, the log and event wrappers that can never change what
 * a run did, and the stage recorder. Moved out of pipeline.ts verbatim; nothing here touches the
 * network, the vault or a model.
 */

/** The stages of a run as they are recorded; `phase` is finer and only picks a failure code. */
export type Phase = "capture" | "fetch" | "prepare" | "write" | "summarise";

/** Which code an unexpected failure in a phase ends the run with (a hang is `interrupted`). */
export const PHASE_ERROR_CODE: Readonly<Record<Phase, RunErrorCode>> = {
  capture: "all-sources-failed",
  fetch: "all-sources-failed",
  prepare: "all-sources-failed",
  write: "vault-write-failed",
  summarise: "summariser-failed",
};

/** Only the two log methods the pipeline uses, so a test can supply a recorder. */
export interface PipelineLog {
  warn(fields: Readonly<Record<string, unknown>>, message?: string): void;
  error(fields: Readonly<Record<string, unknown>>, message?: string): void;
}

export interface SummariserChoice {
  readonly transport: TextTransport;
  /** What the report records as its summariser: a model id or the extractive double. */
  readonly id: SummariserId;
  /**
   * The most characters the transport accepts as input. The pipeline trims whole sources to it
   * before the model call. Default: the live transport's cap, USER_CONTENT_MAX_CHARS.
   */
  readonly maxInputChars?: number;
}

export interface ResearchPipelineDeps {
  readonly db: Database.Database;
  readonly vaultRoot: string;
  /** Where `research-sources.json` lives. */
  readonly runtimeDir: string;
  readonly fetcher: Pick<SafeFetcher, "fetchSources">;
  /** The summariser for a run, chosen from the allowlist file's model. */
  readonly chooseSummariser: (
    config: ResearchSourcesConfig,
  ) => SummariserChoice | Promise<SummariserChoice>;
  readonly now: () => Date;
  /** A fresh run nonce (32 lowercase hex characters). */
  readonly newNonce: () => string;
  readonly log: PipelineLog;
  /** Announces a run state change (`research.updated`). A throw is swallowed. */
  readonly publish: (payload: ResearchUpdatedPayload) => void;
  readonly sourcesFs?: ResearchSourcesFs;
  /** Observes each classified effect step as it happens (diagnostics and tests). */
  readonly audit?: (operation: PipelineEffect) => void;
}

/** What a run ended with, before it is recorded. */
export interface PipelineResult {
  readonly outcome: JobRunOutcome;
  readonly errorCode: RunErrorCode | null;
  /** Sources that contributed text. */
  readonly sourceCount: number;
  /** Sources the run tried. */
  readonly sourceTotal: number;
  readonly reportNoteId: string | null;
  readonly unavailable: readonly UnavailableEntry[];
}

export interface UnavailableEntry {
  readonly sourceId: string;
  readonly label: string;
  readonly code: SourceFailureCode;
}

/** The live record of one run, shared by the pipeline, the watchdog and the finish path. */
export interface RunTrace {
  readonly runId: RunId;
  readonly startedAt: string;
  readonly stages: RunNoteStage[];
  sources: RunNoteSource[];
  unavailable: UnavailableEntry[];
  sourceTotal: number;
  sourceCount: number;
  reportNoteId: string | null;
  reportPath: string | null;
  phase: Phase;
  /** Set by the watchdog: a late completion may not write or record anything after this. */
  cancelled: boolean;
  /** Takes the published report back and restores the wiki notes; null until a report is written. */
  rollbackPublication: (() => void) | null;
  finished: boolean;
  runNote: WrittenRunNote | null;
}

export function createRunTrace(runId: RunId, startedAt: string): RunTrace {
  return {
    runId,
    startedAt,
    stages: [],
    sources: [],
    unavailable: [],
    sourceTotal: 0,
    sourceCount: 0,
    reportNoteId: null,
    reportPath: null,
    phase: "capture",
    cancelled: false,
    rollbackPublication: null,
    finished: false,
    runNote: null,
  };
}

/** A failure the pipeline decided on: its code is the run's error code. */
export class StageFailure extends Error {
  readonly code: RunErrorCode;
  constructor(code: RunErrorCode) {
    super(code);
    this.name = "StageFailure";
    this.code = code;
  }
}

/** Thrown when the watchdog already ended the run: nothing more may be written. */
export class RunCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "RunCancelled";
  }
}

export function assertLive(trace: RunTrace): void {
  if (trace.cancelled) throw new RunCancelled();
}

/**
 * Every event the pipeline logs, by name. Only codes, ids, counts and the error's class name ever
 * appear in a field: no remote string reaches a log line. The names are what operators and the
 * `pipeline-*.test.ts` files read, so they are stable.
 */
export const PIPELINE_LOG_EVENTS = [
  "research-sources-unusable",
  "research-fetch-threw",
  "research-source-record-run-ended",
  "research-raw-snapshot-refused",
  "research-wiki-restore-failed",
  "research-report-removal-failed",
  "research-report-record-removal-failed",
  "research-report-changed-before-finalise",
  "research-report-record-run-ended",
  "research-pipeline-error",
  "research-stage-record-failed",
  "research-run-note-failed",
  "research-finish-failed",
  "research-finish-fallback-failed",
  "research-watchdog-fired",
] as const;

/** One log event of the pipeline: the discriminated union keyed by `event`, with the fields it carries. */
export type PipelineLogEvent =
  | { readonly event: "research-sources-unusable"; readonly code: SourcesRefusal }
  | { readonly event: "research-fetch-threw"; readonly errorName: string }
  | { readonly event: "research-source-record-run-ended"; readonly errorName: string }
  | {
      readonly event: "research-raw-snapshot-refused";
      readonly code: SourceFailureCode;
      readonly errorName: string;
    }
  | { readonly event: "research-wiki-restore-failed"; readonly errorName: string }
  | { readonly event: "research-report-removal-failed"; readonly errorName: string }
  | { readonly event: "research-report-record-removal-failed"; readonly errorName: string }
  | { readonly event: "research-report-changed-before-finalise" }
  | { readonly event: "research-report-record-run-ended"; readonly errorName: string }
  | {
      readonly event: "research-pipeline-error";
      readonly phase: Phase;
      readonly errorName: string;
    }
  | {
      readonly event: "research-stage-record-failed";
      readonly stage: ResearchStage;
      readonly errorName: string;
    }
  | { readonly event: "research-run-note-failed"; readonly errorName: string }
  | { readonly event: "research-finish-failed"; readonly errorName: string }
  | { readonly event: "research-finish-fallback-failed"; readonly errorName: string }
  | { readonly event: "research-watchdog-fired"; readonly phase: Phase };

/** A log call that can never change what a run did: a throwing sink is ignored. */
export function logWarn(deps: ResearchPipelineDeps, event: PipelineLogEvent): void {
  try {
    deps.log.warn(event);
  } catch {
    // A broken log sink never changes the outcome.
  }
}

export function logError(deps: ResearchPipelineDeps, event: PipelineLogEvent): void {
  try {
    deps.log.error(event);
  } catch {
    // A broken log sink never changes the outcome.
  }
}

/** The class name of a thrown value: the only thing about an error that is ever logged. */
export function errorClassName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function emit(deps: ResearchPipelineDeps, payload: ResearchUpdatedPayload): void {
  try {
    deps.publish(payload);
  } catch {
    // A broken event bus never changes what a run did.
  }
}

export function appendStage(
  deps: ResearchPipelineDeps,
  trace: RunTrace,
  stage: ResearchStage,
  noteIds: readonly string[],
  counts?: Readonly<Record<string, number>>,
): void {
  assertLive(trace);
  nameEffect(deps.audit, PIPELINE_EFFECTS.recordRun);
  const at = deps.now().toISOString();
  try {
    appendJobRunStage(deps.db, trace.runId, {
      stage,
      at,
      noteIds,
      ...(counts === undefined ? {} : { counts }),
    });
  } catch (error) {
    // The run record could not take the stage: the run is cut short. It is not a vault failure.
    logError(deps, {
      event: "research-stage-record-failed",
      stage,
      errorName: errorClassName(error),
    });
    throw new StageFailure("interrupted");
  }
  trace.stages.push({ stage, at, noteIds });
  emit(deps, { runId: trace.runId, state: "running", stage });
}

export function failedPipelineResult(trace: RunTrace, code: RunErrorCode): PipelineResult {
  return {
    outcome: "failure",
    errorCode: code,
    // A failed run produced no report, so no source contributed to one.
    sourceCount: 0,
    sourceTotal: trace.sourceTotal,
    reportNoteId: null,
    unavailable: trace.unavailable,
  };
}
