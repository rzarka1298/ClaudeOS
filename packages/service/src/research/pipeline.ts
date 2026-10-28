import { summarizeUntrusted, type TextTransport, UntrustedInputError } from "../untrusted/index.js";
import { finishRun } from "./pipeline-finish.js";
import { checkDelimited } from "./pipeline-sources.js";
import { runStages } from "./pipeline-stages.js";
import {
  errorClassName,
  failedPipelineResult,
  logWarn,
  PHASE_ERROR_CODE,
  type PipelineResult,
  type ResearchPipelineDeps,
  RunCancelled,
  type RunTrace,
  StageFailure,
} from "./pipeline-trace.js";
import { SummariserError, type SummariserErrorCode } from "./summariser-error.js";

/**
 * The research pipeline (plan 07-12; D-03, D-10, D-11, D-12, D-18, D-19, D-25, RSRCH-02, RSRCH-03,
 * RSRCH-05, RSRCH-06, RSRCH-09). One run is a linear function of the owner's allowlist:
 *
 *   capture   the allowlist is read (runtime directory only, never the vault) and recorded
 *   fetch     the safe fetcher, three at a time, one shared byte budget, every source isolated
 *   raw       one content-addressed raw note per source, the EVIDENCE TEXT as its body
 *   synthesis the only model call: delimited text in, text out, then the trusted validation
 *   wiki      one wiki note per source, updated in place
 *   deliverable -> output   the report, written then finalised in place
 *
 * Failure routing (research Pattern 1): any source success plus any failure is a partial report;
 * zero successes, zero surviving items, a summariser failure, a vault write failure and a hung
 * run (the watchdog, code `interrupted`) are failed runs with a code from the closed set, never
 * an invented state. A raw snapshot that was edited or damaged since it was written is ONE
 * source's failure (`parse-failure`), never the run's.
 *
 * Publication is all or nothing (07-FIX4 b): the report is written first, then the wiki notes, then
 * the report is finalised; if anything after the first report write fails, the report is taken
 * back out of the vault and every wiki note is put back as it was, so a failed run leaves no
 * exposed report and no wiki note that cites one.
 * Provenance (07-FIX6, decision D-A, ADR-0030): when a source's raw note has been written and read
 * back, the run records (run, source, address, hash, snapshot path, label) in the operational
 * store. The vault can be forged; the store cannot be reached from it, so the reader counts a
 * quote as evidence only for a source with such a row. The report is bound the same way (07-FIX6b):
 * once it is finalised and read back, the run records a digest of what it says, taken from the
 * report as the vault holds it, before it logs the output stage and finishes. A report edited after
 * that no longer matches its record, and a failed publication takes the record back with the report.
 * No remote string reaches the store, the run note or a log line: only codes, ids, counts,
 * instants and the owner's own labels.
 */

export { finishRun, recordRunNote } from "./pipeline-finish.js";
export type { PreparedSource } from "./pipeline-sources.js";
export { checkDelimited, sourceRecordFor, trimToInputCap } from "./pipeline-sources.js";
export type {
  PipelineLog,
  PipelineResult,
  ResearchPipelineDeps,
  RunTrace,
  SummariserChoice,
  UnavailableEntry,
} from "./pipeline-trace.js";
export { createRunTrace } from "./pipeline-trace.js";

// The summariser step. This is the ONE call site of `summarizeUntrusted` in the service and
// `pipeline-delimit.test.ts` pins it to this file (`research/pipeline.ts:1`), so it stays in the
// facade while the stages around it live in their own modules (09-12).
export type SummariseResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: SummariserErrorCode };

/**
 * The one place the pipeline calls the summariser port. Content that is not delimited with
 * exactly the fetched ids never reaches the transport: the result is `summariser-invalid-output`
 * and the transport is not called. A transport error becomes its closed code.
 */
export async function summariseSources(
  input: { readonly delimitedContent: string; readonly sourceIds: readonly string[] },
  transport: TextTransport,
): Promise<SummariseResult> {
  if (!checkDelimited(input.delimitedContent, input.sourceIds)) {
    return { ok: false, code: "summariser-invalid-output" };
  }
  try {
    const answer = await summarizeUntrusted(input, transport);
    return { ok: true, text: answer.text };
  } catch (error) {
    if (error instanceof SummariserError) return { ok: false, code: error.code };
    if (error instanceof UntrustedInputError) {
      return { ok: false, code: "summariser-invalid-output" };
    }
    return { ok: false, code: "summariser-failed" };
  }
}

/**
 * Runs the stages and answers how the run ended. Never throws: a stage failure keeps its code,
 * and anything unexpected (or a run the watchdog already ended) maps to the code of the phase it
 * happened in. Only the error's class name is ever logged.
 */
export async function runResearchPipeline(
  deps: ResearchPipelineDeps,
  trace: RunTrace,
): Promise<PipelineResult> {
  try {
    return await runStages(deps, trace);
  } catch (error) {
    if (error instanceof StageFailure) return failedPipelineResult(trace, error.code);
    if (!(error instanceof RunCancelled)) {
      logWarn(deps, {
        event: "research-pipeline-error",
        phase: trace.phase,
        errorName: errorClassName(error),
      });
    }
    return failedPipelineResult(trace, PHASE_ERROR_CODE[trace.phase]);
  }
}

/** How a hung run is cut off: the injected timer is how tests stay fast. */
export interface Watchdog {
  readonly ms: number;
  /** Starts a timer; returns its cancel function. */
  readonly schedule: (fire: () => void, ms: number) => () => void;
}

/**
 * Runs the pipeline under the watchdog and always finishes the job run. A pipeline that does not
 * settle in time ends as a failed run with the code `interrupted`; whatever it does
 * later is discarded (`trace.cancelled` stops every write and record). Never rejects.
 */
export async function executeResearchRun(
  deps: ResearchPipelineDeps,
  trace: RunTrace,
  watchdog: Watchdog,
  /**
   * Called with the pipeline's own promise, so the caller can keep waiting for it after the
   * watchdog has ended the run (07-FIX8): a cut-off call that is still hanging inside a fetch or a
   * summariser must still be drained before the service is called idle.
   */
  track?: (pipeline: Promise<unknown>) => void,
): Promise<void> {
  let result: PipelineResult;
  let cancel: () => void = () => {};
  try {
    const hung = new Promise<PipelineResult>((resolve) => {
      cancel = watchdog.schedule(() => {
        trace.cancelled = true;
        logWarn(deps, { event: "research-watchdog-fired", phase: trace.phase });
        // A run cut off by the watchdog is `interrupted`: it is not recorded as a failure of the
        // phase it happened to be in, and sources that were never judged are not listed as failing.
        resolve(failedPipelineResult(trace, "interrupted"));
      }, watchdog.ms);
    });
    const pipeline = runResearchPipeline(deps, trace);
    track?.(pipeline);
    result = await Promise.race([pipeline, hung]);
  } catch {
    result = failedPipelineResult(trace, PHASE_ERROR_CODE[trace.phase]);
  } finally {
    cancel();
  }
  finishRun(deps, trace, result);
}
