import { finishJobRun } from "@ccc/operational-store";
import { nameEffect, PIPELINE_EFFECTS } from "./pipeline-effects.js";
import {
  emit,
  errorClassName,
  logError,
  logWarn,
  type PipelineResult,
  type ResearchPipelineDeps,
  type RunTrace,
} from "./pipeline-trace.js";
import { writeRunNote } from "./run-note.js";

/**
 * How a run ends (09-12, D-12): the job run row first (the source of truth), then the run note, then
 * the final event. Moved out of pipeline.ts verbatim; `finishRun` is the one place a run is closed.
 */

function runNoteInput(trace: RunTrace, result: PipelineResult | null, endedAt: string | null) {
  return {
    runId: trace.runId,
    startedAt: trace.startedAt,
    endedAt,
    outcome: result?.outcome ?? null,
    errorCode: result?.errorCode ?? null,
    stages: trace.stages,
    sources: trace.sources,
    reportPath: result === null || result.outcome === "failure" ? null : trace.reportPath,
  };
}

/** Writes the run note (best effort: a failure is logged by class name only). */
export function recordRunNote(
  deps: ResearchPipelineDeps,
  trace: RunTrace,
  result: PipelineResult | null,
  endedAt: string | null,
): void {
  nameEffect(deps.audit, PIPELINE_EFFECTS.recordRun);
  try {
    trace.runNote = writeRunNote({
      vaultRoot: deps.vaultRoot,
      input: runNoteInput(trace, result, endedAt),
      ...(trace.runNote === null ? {} : { prior: trace.runNote }),
    });
  } catch (error) {
    logWarn(deps, { event: "research-run-note-failed", errorName: errorClassName(error) });
  }
}

/** A failed run records no source as contributed: what was fetched stays "fetched, no report". */
function demoteSources(trace: RunTrace): void {
  trace.sources = trace.sources.map((source) =>
    source.contributed
      ? { label: source.label, contributed: false, code: null, status: "fetched" as const }
      : source,
  );
}

/**
 * Ends the run exactly once: the job run row first (the source of truth), then the run note, then
 * the final event. If the row cannot take the computed finish (a cross-field rule), a minimal
 * failure is written instead, so the run is never left in flight.
 */
export function finishRun(
  deps: ResearchPipelineDeps,
  trace: RunTrace,
  result: PipelineResult,
): void {
  if (trace.finished) return;
  trace.finished = true;
  nameEffect(deps.audit, PIPELINE_EFFECTS.recordRun);
  const endedAt = deps.now().toISOString();
  let recorded = result;
  try {
    finishJobRun(deps.db, trace.runId, {
      outcome: result.outcome,
      endedAt,
      sourceCount: result.sourceCount,
      sourceTotal: result.sourceTotal,
      reportNoteId: result.reportNoteId,
      unavailableSources: result.unavailable.map(({ sourceId, code }) => ({ sourceId, code })),
      errorCode: result.errorCode,
    });
  } catch (error) {
    logError(deps, { event: "research-finish-failed", errorName: errorClassName(error) });
    // The run could not record what it computed, so it is recorded as cut short. The vault writes
    // may all have succeeded, so this is not a vault failure; and a published report would now sit
    // beside a failed run, so it is taken back.
    trace.rollbackPublication?.();
    recorded = {
      outcome: "failure",
      errorCode: result.errorCode ?? "interrupted",
      sourceCount: 0,
      sourceTotal: result.sourceTotal,
      reportNoteId: null,
      unavailable: [],
    };
    try {
      finishJobRun(deps.db, trace.runId, {
        outcome: "failure",
        endedAt,
        sourceCount: 0,
        sourceTotal: recorded.sourceTotal,
        reportNoteId: null,
        unavailableSources: [],
        errorCode: recorded.errorCode,
      });
    } catch (second) {
      logError(deps, {
        event: "research-finish-fallback-failed",
        errorName: errorClassName(second),
      });
    }
  }
  if (recorded.outcome === "failure") demoteSources(trace);
  recordRunNote(deps, trace, recorded, endedAt);
  emit(deps, {
    runId: trace.runId,
    state: recorded.outcome === "failure" ? "failed" : "completed",
    outcome: recorded.outcome,
  });
}
