import type { ReportItem, ResearchSourcesConfig } from "@ccc/domain";
import { recordResearchSource } from "@ccc/operational-store";
import { delimitSourcesWithReport, quoteInSource, validateSummariserOutput } from "@ccc/research";
import { deriveOutcome } from "@ccc/scheduler";
import { readRawSourceNote, type WikiSourceSnapshot, writeRawSourceNote } from "@ccc/vault-repo";
import { USER_CONTENT_MAX_CHARS } from "./anthropic-request.js";
import { createRunBudget, type SafeFetcher } from "./fetch/index.js";
import { contentHashFor } from "./hash.js";
import { summariseSources } from "./pipeline.js";
import { nameEffect, PIPELINE_EFFECTS } from "./pipeline-effects.js";
import { runPublicationStage } from "./pipeline-publication.js";
import {
  idFor,
  isRawSnapshotRefusal,
  isRunGone,
  type Prepared,
  type PreparedSource,
  prepare,
  RawSnapshotRefused,
  recordSources,
  sameBinding,
  sourceRecordFor,
  trimToInputCap,
} from "./pipeline-sources.js";
import {
  appendStage,
  assertLive,
  errorName,
  logWarn,
  type PipelineResult,
  type ResearchPipelineDeps,
  type RunTrace,
  StageFailure,
  type SummariserChoice,
} from "./pipeline-trace.js";
import { loadResearchSources } from "./sources-config.js";
import { SummariserError } from "./summariser-error.js";

/**
 * The stages of a run (09-12, D-12), one exported function each with an explicit input and output:
 * capture and summariser choice, fetch, prepare, raw write, synthesis, publication. `runStages` only
 * sequences them. Phase 10 replaces the summariser by replacing `runSynthesisStage` alone.
 */

/**
 * The values threaded across stages. No stage receives the whole context: each one's input and
 * output is a `Pick` of the fields it reads or produces, so the hand-over between stages is explicit.
 * `generatedAt`, `reportPath` and `wikiSnapshots` are used inside the publication stage only.
 */
export interface StageContext {
  readonly config: ResearchSourcesConfig;
  readonly choice: SummariserChoice;
  readonly fetched: Awaited<ReturnType<SafeFetcher["fetchSources"]>>;
  readonly nonce: string;
  readonly retrievedAt: string;
  /** One outcome per allowlist entry, in allowlist order. */
  readonly outcomes: readonly Prepared[];
  /** The prepared sources that fit the summariser's input cap. */
  readonly kept: readonly PreparedSource[];
  readonly droppedIndexes: ReadonlySet<number>;
  /** Indexes of sources whose raw snapshot was refused. The raw write stage adds to it. */
  readonly refused: Set<number>;
  /** The stored raw text of each source whose raw note was written and read back, by source id. */
  readonly stored: ReadonlyMap<string, string>;
  readonly rawIds: readonly string[];
  /** The kept sources that were not refused: what the summariser sees and the report cites. */
  readonly usable: readonly PreparedSource[];
  readonly items: ReportItem[];
  readonly generatedAt: string;
  readonly reportPath: string;
  readonly wikiSnapshots: readonly WikiSourceSnapshot[];
  readonly reportId: string;
}

// ---------------------------------------------------------------------------
// capture and summariser choice

export type CaptureOutput = Pick<StageContext, "config" | "choice">;

/**
 * Reads the allowlist (runtime directory only, never the vault), records it, then chooses the
 * summariser: a run that cannot summarise fetches nothing.
 */
export async function runCaptureStage(
  deps: ResearchPipelineDeps,
  trace: RunTrace,
): Promise<CaptureOutput> {
  trace.phase = "capture";
  const loaded = loadResearchSources(deps.runtimeDir, deps.sourcesFs, {
    vaultRoot: deps.vaultRoot,
  });
  if (!loaded.ok) {
    logWarn(deps, { event: "research-sources-unusable", code: loaded.code });
    throw new StageFailure("all-sources-failed");
  }
  const config = loaded.config;
  trace.sourceTotal = config.sources.length;
  trace.sources = config.sources.map((entry) => ({
    label: entry.label,
    contributed: false,
    code: null,
    status: "pending" as const,
  }));
  appendStage(deps, trace, "capture", [], { sources: config.sources.length });
  if (config.sources.length === 0) throw new StageFailure("all-sources-failed");

  // The summariser is chosen before anything is fetched: a run that cannot summarise fetches nothing.
  // Its refusal keeps its own code (for example `summariser-unconfigured`).
  trace.phase = "summarise";
  let choice: SummariserChoice;
  try {
    choice = await deps.chooseSummariser(config);
  } catch (error) {
    if (error instanceof SummariserError) throw new StageFailure(error.code);
    throw error;
  }
  // The choice may have waited minutes (a Keychain prompt): a run the watchdog already ended must
  // not start the fetch effect, or it would reach the network alongside its replacement.
  assertLive(trace);
  return { config, choice };
}

// ---------------------------------------------------------------------------
// fetch

export type FetchInput = Pick<StageContext, "config">;
export type FetchOutput = Pick<StageContext, "fetched">;

export async function runFetchStage(
  deps: ResearchPipelineDeps,
  trace: RunTrace,
  input: FetchInput,
): Promise<FetchOutput> {
  const { config } = input;
  trace.phase = "fetch";
  nameEffect(deps.audit, PIPELINE_EFFECTS.fetch);
  let fetched: Awaited<ReturnType<SafeFetcher["fetchSources"]>>;
  try {
    fetched = await deps.fetcher.fetchSources(
      config.sources.map((entry) => ({ url: entry.url, kind: entry.kind })),
      createRunBudget(),
    );
  } catch (error) {
    // The fetcher itself broke (it never rejects for a source's failure). That is a fault of this
    // process, not a network error of any source: no source is blamed (07-14, opus m9).
    logWarn(deps, { event: "research-fetch-threw", errorName: errorName(error) });
    throw new StageFailure("interrupted");
  }
  assertLive(trace);
  return { fetched };
}

// ---------------------------------------------------------------------------
// prepare

export type PrepareInput = Pick<StageContext, "config" | "choice" | "fetched">;
export type PrepareOutput = Pick<
  StageContext,
  "nonce" | "retrievedAt" | "outcomes" | "kept" | "droppedIndexes" | "refused"
>;

export function runPrepareStage(
  deps: ResearchPipelineDeps,
  trace: RunTrace,
  input: PrepareInput,
): PrepareOutput {
  const { config, choice, fetched } = input;
  trace.phase = "prepare";
  const nonce = deps.newNonce();
  const retrievedAt = deps.now().toISOString();
  const outcomes: Prepared[] = config.sources.map((entry, index) => {
    const result = fetched[index];
    if (result === undefined) return { ok: false, code: "network-error", sourceId: idFor(entry) };
    if (!result.ok) return { ok: false, code: result.code, sourceId: idFor(entry) };
    return prepare(index, entry, result, retrievedAt, nonce);
  });
  const ready = outcomes.flatMap((outcome) => (outcome.ok ? [outcome.source] : []));
  const { kept, dropped } = trimToInputCap(
    ready,
    nonce,
    choice.maxInputChars ?? USER_CONTENT_MAX_CHARS,
  );
  const droppedIndexes = new Set(dropped.map((source) => source.index));
  const refused = new Set<number>();
  recordSources(trace, config, outcomes, droppedIndexes, refused, false);
  if (kept.length === 0) throw new StageFailure("all-sources-failed");
  return { nonce, retrievedAt, outcomes, kept, droppedIndexes, refused };
}

// ---------------------------------------------------------------------------
// raw write

export type RawWriteInput = Pick<
  StageContext,
  "config" | "outcomes" | "kept" | "droppedIndexes" | "refused"
>;
export type RawWriteOutput = Pick<StageContext, "stored" | "rawIds" | "usable">;

export function runRawWriteStage(
  deps: ResearchPipelineDeps,
  trace: RunTrace,
  input: RawWriteInput,
): RawWriteOutput {
  const { config, outcomes, kept, droppedIndexes, refused } = input;
  trace.phase = "write";
  assertLive(trace);
  const stored = new Map<string, string>();
  const rawIds: string[] = [];
  nameEffect(deps.audit, PIPELINE_EFFECTS.writeNotes);
  try {
    for (const source of kept) {
      assertLive(trace);
      try {
        const written = writeRawSourceNote({
          vaultRoot: deps.vaultRoot,
          sourceRef: source.ref,
          sanitise: source.counts,
          // The evidence text, byte for byte: what the model sees and what a quote is checked against.
          text: source.evidence,
          canonicalHash: contentHashFor,
          ...(source.truncated ? { truncated: true } : {}),
          now: deps.now(),
        });
        // Read it back: the hash is recomputed from the stored body, never trusted. An existing
        // file at this content-addressed path may have been edited since it was written.
        const snapshot = readRawSourceNote(deps.vaultRoot, source.ref.snapshotPath);
        if (
          !snapshot.readable ||
          snapshot.text === null ||
          contentHashFor(snapshot.text) !== source.ref.contentHash ||
          !sameBinding(snapshot.frontmatter.sourceRef, source.ref)
        ) {
          throw new RawSnapshotRefused();
        }
        // The raw note is written and read back: record it in the operational store. That row, not
        // the vault, is what lets the reader call a quote verified (07-FIX6, ADR-0030). A source
        // that fails above has no row, so a report can never cite it as evidence.
        const record = sourceRecordFor(source, trace.runId, deps.now().toISOString());
        if (record === null) throw new RawSnapshotRefused();
        recordResearchSource(deps.db, record);
        stored.set(source.sourceId, snapshot.text);
        rawIds.push(written.id);
      } catch (error) {
        if (isRunGone(error)) {
          // The run was ended under this pipeline (cut off, recovered as stale): a clean stop, like
          // a run record that cannot take a stage. Nothing more is recorded or written.
          logWarn(deps, { event: "research-source-record-run-ended", errorName: errorName(error) });
          throw new StageFailure("interrupted");
        }
        if (!isRawSnapshotRefusal(error)) throw error;
        // This source cannot be cited: it fails alone, the file is left for the owner.
        refused.add(source.index);
        logWarn(deps, {
          event: "research-raw-snapshot-refused",
          code: "parse-failure",
          errorName: errorName(error),
        });
      }
    }
  } finally {
    // Raw notes already written stay listed in the run record, whatever stopped the loop.
    if (rawIds.length > 0 && !trace.cancelled) {
      try {
        appendStage(deps, trace, "raw", rawIds, { sources: rawIds.length });
      } catch {
        // The failure that is being unwound is the one the run reports.
      }
    }
  }
  const usable = kept.filter((source) => !refused.has(source.index));
  recordSources(trace, config, outcomes, droppedIndexes, refused, false);
  if (usable.length === 0) throw new StageFailure("all-sources-failed");
  return { stored, rawIds, usable };
}

// ---------------------------------------------------------------------------
// synthesis

/** What the synthesis stage needs: the usable sources, the run nonce, the summariser, the stored texts. */
export type SynthesisInput = Pick<StageContext, "usable" | "nonce" | "choice" | "stored">;

/** What the synthesis stage answers (a failure is thrown as a StageFailure). */
export type SynthesisOutput = Pick<StageContext, "items">;

/**
 * The only model call of a run (Phase 10 replaces the summariser behind this one function): delimited
 * evidence in, text out, then the trusted validation and a second quote check against the stored text.
 * Throws a StageFailure with the run's error code; appends exactly one `synthesis` stage on success.
 */
export async function runSynthesisStage(
  deps: ResearchPipelineDeps,
  trace: RunTrace,
  input: SynthesisInput,
): Promise<SynthesisOutput> {
  const { usable, nonce, choice, stored } = input;
  trace.phase = "summarise";
  assertLive(trace);
  const sourceIds = usable.map((source) => source.sourceId);
  const delimited = delimitSourcesWithReport(
    usable.map((source) => ({ sourceId: source.sourceId, text: source.evidence })),
    nonce,
  );
  nameEffect(deps.audit, PIPELINE_EFFECTS.summarise);
  const answer = await summariseSources(
    { delimitedContent: delimited.composed, sourceIds },
    choice.transport,
  );
  assertLive(trace);
  if (!answer.ok) throw new StageFailure(answer.code);
  const validation = validateSummariserOutput(answer.text, {
    sources: Object.fromEntries(usable.map((source) => [source.sourceId, source.evidence])),
    nonce,
  });
  if (!validation.ok) throw new StageFailure(validation.code);
  // Every quote is checked once more, with the one predicate, against the text that is stored.
  const items: ReportItem[] = validation.items.filter(
    (item) =>
      item.quote === undefined ||
      item.citedSourceIds.every((id) => quoteInSource(stored.get(id) ?? "", item.quote ?? "")),
  );
  // Zero surviving items is not a success: nothing was reported.
  if (items.length === 0) throw new StageFailure("summariser-invalid-output");
  const kindCounts: Record<string, number> = {};
  for (const item of items) kindCounts[item.kind] = (kindCounts[item.kind] ?? 0) + 1;
  appendStage(deps, trace, "synthesis", [], kindCounts);
  return { items };
}

export type { PublicationInput, PublicationOutput } from "./pipeline-publication.js";
export { runPublicationStage };

// ---------------------------------------------------------------------------
// the sequence

/** Runs the stages in order and answers how the run ended. Each stage throws a StageFailure to end it. */
export async function runStages(
  deps: ResearchPipelineDeps,
  trace: RunTrace,
): Promise<PipelineResult> {
  const { config, choice } = await runCaptureStage(deps, trace);
  const { fetched } = await runFetchStage(deps, trace, { config });
  const { nonce, outcomes, kept, droppedIndexes, refused } = runPrepareStage(deps, trace, {
    config,
    choice,
    fetched,
  });
  const { stored, usable } = runRawWriteStage(deps, trace, {
    config,
    outcomes,
    kept,
    droppedIndexes,
    refused,
  });
  const { items } = await runSynthesisStage(deps, trace, { usable, nonce, choice, stored });
  const { reportId } = await runPublicationStage(deps, trace, {
    config,
    choice,
    outcomes,
    droppedIndexes,
    refused,
    usable,
    items,
  });
  return {
    outcome: deriveOutcome({
      succeeded: usable.length,
      failed: trace.unavailable.length,
      stageError: null,
    }),
    errorCode: null,
    sourceCount: usable.length,
    sourceTotal: config.sources.length,
    reportNoteId: reportId,
    unavailable: trace.unavailable,
  };
}
