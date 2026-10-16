import {
  type JobRunOutcome,
  type ReportItem,
  type ResearchSourceEntry,
  type ResearchSourcesConfig,
  type ResearchStage,
  type ResearchUpdatedPayload,
  type RunErrorCode,
  type RunId,
  rawSnapshotPathFor,
  type SanitiseCounts,
  type SourceFailureCode,
  type SourceReference,
  SourceReferenceSchema,
  type SummariserId,
} from "@ccc/domain";
import { appendJobRunStage, finishJobRun } from "@ccc/operational-store";
import {
  canonicaliseUrl,
  delimitSourcesWithReport,
  evidenceText,
  htmlToText,
  parseDelimitedBlocks,
  parseFeed,
  quoteInSource,
  renderFeedText,
  validateSummariserOutput,
} from "@ccc/research";
import { deriveOutcome } from "@ccc/scheduler";
import {
  captureWikiSourceNote,
  finaliseReportNote,
  readRawSourceNote,
  removeReportNote,
  reportNotePathFor,
  SourceNoteError,
  type WikiSourceSnapshot,
  writeRawSourceNote,
  writeReportNote,
  writeWikiSourceNote,
} from "@ccc/vault-repo";
import type Database from "better-sqlite3";
import { summarizeUntrusted, type TextTransport, UntrustedInputError } from "../untrusted/index.js";
import { USER_CONTENT_MAX_CHARS } from "./anthropic-request.js";
import { createRunBudget, type SafeFetcher } from "./fetch/index.js";
import { contentHashFor, sourceIdFor } from "./hash.js";
import { nameEffect, PIPELINE_EFFECTS, type PipelineEffect } from "./pipeline-effects.js";
import {
  type RunNoteSource,
  type RunNoteStage,
  type WrittenRunNote,
  writeRunNote,
} from "./run-note.js";
import { loadResearchSources, type ResearchSourcesFs } from "./sources-config.js";
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
 * No remote string reaches the store, the run note or a log line: only codes, ids, counts,
 * instants and the owner's own labels.
 */

/** The stages of a run as they are recorded; `phase` is finer and only picks a failure code. */
type Phase = "capture" | "fetch" | "prepare" | "write" | "summarise";

/** Which code an unexpected failure in a phase ends the run with (a hang is `interrupted`). */
const PHASE_ERROR_CODE: Readonly<Record<Phase, RunErrorCode>> = {
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
class StageFailure extends Error {
  readonly code: RunErrorCode;
  constructor(code: RunErrorCode) {
    super(code);
    this.name = "StageFailure";
    this.code = code;
  }
}

/** Thrown when the watchdog already ended the run: nothing more may be written. */
class RunCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "RunCancelled";
  }
}

function assertLive(trace: RunTrace): void {
  if (trace.cancelled) throw new RunCancelled();
}

/** A log call that can never change what a run did: a throwing sink is ignored. */
function logWarn(deps: ResearchPipelineDeps, fields: Readonly<Record<string, unknown>>): void {
  try {
    deps.log.warn(fields);
  } catch {
    // A broken log sink never changes the outcome.
  }
}

function logError(deps: ResearchPipelineDeps, fields: Readonly<Record<string, unknown>>): void {
  try {
    deps.log.error(fields);
  } catch {
    // A broken log sink never changes the outcome.
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function emit(deps: ResearchPipelineDeps, payload: ResearchUpdatedPayload): void {
  try {
    deps.publish(payload);
  } catch {
    // A broken event bus never changes what a run did.
  }
}

function appendStage(
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
    logError(deps, { event: "research-stage-record-failed", stage, errorName: errorName(error) });
    throw new StageFailure("interrupted");
  }
  trace.stages.push({ stage, at, noteIds });
  emit(deps, { runId: trace.runId, state: "running", stage });
}

// ---------------------------------------------------------------------------
// The summariser step

const BLOCK_HEADER = /^<<<SRC id=[0-9a-f]{32} nonce=([0-9a-f]{16,64})>>>$/m;

/**
 * True when `delimitedContent` is exactly one block per fetched source id, in order, and nothing
 * else: the blocks parsed back out and recomposed reproduce the content byte for byte. The
 * summariser port trusts its caller that the content is delimited with exactly these ids (its
 * folder cannot import `@ccc/research`), so the pipeline asserts it before any model call
 * (wave 2 opus review).
 */
export function checkDelimited(delimitedContent: string, sourceIds: readonly string[]): boolean {
  const blocks = parseDelimitedBlocks(delimitedContent);
  if (blocks.length !== sourceIds.length || blocks.length === 0) return false;
  if (!blocks.every((block, index) => block.sourceId === sourceIds[index])) return false;
  const nonce = BLOCK_HEADER.exec(delimitedContent)?.[1];
  if (nonce === undefined) return false;
  const recomposed = blocks
    .map(
      (block) =>
        `<<<SRC id=${block.sourceId} nonce=${nonce}>>>\n${block.text}\n<<<END nonce=${nonce}>>>`,
    )
    .join("\n");
  return recomposed === delimitedContent;
}

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

// ---------------------------------------------------------------------------
// Preparing sources

export interface PreparedSource {
  readonly index: number;
  readonly entry: ResearchSourceEntry;
  readonly sourceId: string;
  /** The EVIDENCE TEXT: the exact string the summariser is shown, and the raw note's body. */
  readonly evidence: string;
  readonly counts: SanitiseCounts;
  readonly truncated: boolean;
  readonly ref: SourceReference;
}

type Prepared =
  | { readonly ok: true; readonly source: PreparedSource }
  | { readonly ok: false; readonly code: SourceFailureCode; readonly sourceId: string };

function idFor(entry: ResearchSourceEntry): string {
  const canonical = canonicaliseUrl(entry.url);
  return sourceIdFor(canonical.ok ? canonical.url : entry.url);
}

function prepare(
  index: number,
  entry: ResearchSourceEntry,
  fetched: { readonly text: string },
  retrievedAt: string,
  nonce: string,
): Prepared {
  const fallbackId = idFor(entry);
  try {
    const canonical = canonicaliseUrl(entry.url);
    if (!canonical.ok) return { ok: false, code: "parse-failure", sourceId: fallbackId };

    let text: string;
    let counts: SanitiseCounts;
    let truncated = false;
    let author: string | null = null;
    let publishedAt: string | null = null;
    if (entry.kind === "feed") {
      const parsed = parseFeed(fetched.text);
      if (parsed.entries.length === 0) {
        return {
          ok: false,
          code: parsed.format === "unknown" ? "parse-failure" : "empty-content",
          sourceId: fallbackId,
        };
      }
      text = renderFeedText(parsed.entries);
      counts = { ...parsed.report };
      author = parsed.entries.find((candidate) => candidate.author !== null)?.author ?? null;
      const retrievedMs = Date.parse(retrievedAt);
      for (const candidate of parsed.entries) {
        // An instant later than the retrieval is a feed's mistake, not a publication date.
        if (
          candidate.updated !== null &&
          Date.parse(candidate.updated) <= retrievedMs &&
          (publishedAt === null || candidate.updated > publishedAt)
        ) {
          publishedAt = candidate.updated;
        }
      }
    } else {
      const page = htmlToText(fetched.text);
      text = page.text;
      counts = { ...page.report };
      truncated = page.truncated;
    }

    const evidence = evidenceText(text, nonce);
    if (evidence.trim() === "") return { ok: false, code: "empty-content", sourceId: fallbackId };
    const sourceId = sourceIdFor(canonical.url);
    const contentHash = contentHashFor(evidence);
    const base = {
      sourceType: entry.kind === "feed" ? ("feed-entry" as const) : ("web-page" as const),
      id: sourceId,
      // The owner's own label, never a remote title: nothing remote reaches the reference's title.
      title: entry.label,
      canonicalUrl: canonical.url,
      publishedAt,
      retrievedAt,
      contentHash,
      snapshotPath: rawSnapshotPathFor(sourceId, contentHash),
      accessClass: "public" as const,
    };
    // A feed author or date the schema refuses is dropped rather than failing the whole source.
    let ref: SourceReference | null = null;
    for (const variant of [
      { author, publishedAt },
      { author: null, publishedAt },
      { author, publishedAt: null },
      { author: null, publishedAt: null },
    ]) {
      const parsedRef = SourceReferenceSchema.safeParse({ ...base, ...variant });
      if (parsedRef.success) {
        ref = parsedRef.data;
        break;
      }
    }
    if (ref === null) return { ok: false, code: "parse-failure", sourceId };
    return {
      ok: true,
      source: { index, entry, sourceId, evidence, counts, truncated, ref },
    };
  } catch {
    return { ok: false, code: "parse-failure", sourceId: fallbackId };
  }
}

const IDS_LABEL = "\nSource IDs: ";

/**
 * Keeps sources, in order, while the summariser input stays within the transport's cap. A source
 * whose block does not fit is dropped whole (never cut mid-block), so the delimiting stays valid
 * and the ids stay consistent; later, smaller sources may still fit.
 */
export function trimToInputCap(
  ready: readonly PreparedSource[],
  nonce: string,
  cap: number = USER_CONTENT_MAX_CHARS,
): { kept: PreparedSource[]; dropped: PreparedSource[] } {
  const overhead =
    `<<<SRC id=${"0".repeat(32)} nonce=${nonce}>>>\n`.length + `\n<<<END nonce=${nonce}>>>`.length;
  let total = IDS_LABEL.length;
  const kept: PreparedSource[] = [];
  const dropped: PreparedSource[] = [];
  for (const source of ready) {
    // block, the newline joining it to the previous block, its id in the id list, the ", " before it
    const add = overhead + source.evidence.length + 32 + (kept.length > 0 ? 1 + 2 : 0);
    if (total + add <= cap) {
      kept.push(source);
      total += add;
    } else {
      dropped.push(source);
    }
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// The run

function failureResult(trace: RunTrace, code: RunErrorCode): PipelineResult {
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

/**
 * Records which sources failed, which were read, and (only once a report is published) which
 * contributed, in allowlist order. `contributed` is false until the whole publication succeeded,
 * so a run that fails never says a source contributed.
 */
function recordSources(
  trace: RunTrace,
  config: ResearchSourcesConfig,
  outcomes: readonly Prepared[],
  dropped: ReadonlySet<number>,
  refused: ReadonlySet<number>,
  contributed: boolean,
): void {
  trace.sources = [];
  trace.unavailable = [];
  trace.sourceCount = 0;
  config.sources.forEach((entry, index) => {
    const outcome = outcomes[index];
    let code: SourceFailureCode | null = null;
    let sourceId = idFor(entry);
    if (outcome === undefined) code = "network-error";
    else if (!outcome.ok) {
      code = outcome.code;
      sourceId = outcome.sourceId;
    } else {
      sourceId = outcome.source.sourceId;
      if (dropped.has(index)) code = "oversize";
      else if (refused.has(index)) code = "parse-failure";
    }
    if (code !== null) {
      trace.sources.push({ label: entry.label, contributed: false, code });
      trace.unavailable.push({ sourceId, label: entry.label, code });
    } else if (contributed) {
      trace.sourceCount += 1;
      trace.sources.push({ label: entry.label, contributed: true, code: null });
    } else {
      trace.sources.push({ label: entry.label, contributed: false, code: null, status: "fetched" });
    }
  });
}

/**
 * True when a stored raw note names the same source this run's reference does. A raw note that
 * already exists is reused (it is content-addressed), so what it says about WHERE the text came
 * from must agree with what the report will cite: the address, the source kind, the access class,
 * the hash and the snapshot path. The label and the retrieval time are this run's own (an earlier
 * run may have named the source differently and fetched it earlier), so they may differ (07-14,
 * opus m8).
 */
function sameBinding(stored: SourceReference, cited: SourceReference): boolean {
  return (
    stored.id === cited.id &&
    stored.sourceType === cited.sourceType &&
    stored.canonicalUrl === cited.canonicalUrl &&
    stored.deepLink === cited.deepLink &&
    stored.contentHash === cited.contentHash &&
    stored.snapshotPath === cited.snapshotPath &&
    stored.accessClass === cited.accessClass
  );
}

/** Thrown inside the raw loop when a stored snapshot is not the one this run's evidence names. */
class RawSnapshotRefused extends Error {
  constructor() {
    super("raw snapshot refused");
    this.name = "RawSnapshotRefused";
  }
}

/**
 * True for a failure that belongs to ONE source's raw snapshot: the file at the content-addressed
 * path was edited, rewritten or damaged since it was written (or shares the hash prefix of other
 * content), so it is not the evidence this run holds. Any other failure (a folder that cannot be
 * written, a store fault) is the run's.
 */
function isRawSnapshotRefusal(error: unknown): boolean {
  return (
    error instanceof RawSnapshotRefused ||
    (error instanceof SourceNoteError && error.reason === "existing-unreadable")
  );
}

async function runStages(deps: ResearchPipelineDeps, trace: RunTrace): Promise<PipelineResult> {
  // capture
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

  // fetch
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

  // prepare
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

  // raw
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
        stored.set(source.sourceId, snapshot.text);
        rawIds.push(written.id);
      } catch (error) {
        if (!isRawSnapshotRefusal(error)) throw error;
        // This source cannot be cited: it fails alone, the file is left for the owner.
        refused.add(source.index);
        logWarn(deps, { event: "research-raw-snapshot-refused", code: "parse-failure" });
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

  // synthesis
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

  // Publication, all or nothing: the report first (so no wiki note ever cites a report that does
  // not exist), then the wiki notes, then the finalise. Any failure from the first report write
  // on takes the report back out and puts every wiki note back as it was.
  trace.phase = "write";
  assertLive(trace);
  const generatedAt = deps.now().toISOString();
  const reportPath = reportNotePathFor(generatedAt, trace.runId);
  const wikiSnapshots: WikiSourceSnapshot[] = [];
  trace.rollbackPublication = () => {
    for (const snapshot of [...wikiSnapshots].reverse()) {
      try {
        snapshot.restore();
      } catch (error) {
        logWarn(deps, { event: "research-wiki-restore-failed", errorName: errorName(error) });
      }
    }
    try {
      removeReportNote({ vaultRoot: deps.vaultRoot, path: reportPath });
    } catch (error) {
      logWarn(deps, { event: "research-report-removal-failed", errorName: errorName(error) });
    }
    trace.reportPath = null;
    trace.reportNoteId = null;
  };
  nameEffect(deps.audit, PIPELINE_EFFECTS.writeNotes);
  let reportId: string;
  try {
    const report = writeReportNote({
      vaultRoot: deps.vaultRoot,
      topicLabel: config.topicLabel,
      generatedAt,
      jobRunId: trace.runId,
      summariser: choice.id,
      sourceTotal: config.sources.length,
      unavailableSources: trace.unavailable.map((entry) => ({
        label: entry.label,
        code: entry.code,
      })),
      sourceRefs: usable.map((source) => source.ref),
      sourceHandling: usable.map((source) => ({
        sourceId: source.sourceId,
        counts: source.counts,
      })),
      items,
      runNotePath: `automation-runs/${trace.runId}.md`,
      now: deps.now(),
    });
    reportId = report.id;
    trace.reportPath = report.path;

    const wikiIds: string[] = [];
    for (const source of usable) {
      assertLive(trace);
      wikiSnapshots.push(captureWikiSourceNote(deps.vaultRoot, source.sourceId));
      const wiki = writeWikiSourceNote({
        vaultRoot: deps.vaultRoot,
        sourceId: source.sourceId,
        title: source.entry.label,
        canonicalUrl: source.ref.canonicalUrl ?? "",
        latestSnapshotPath: source.ref.snapshotPath,
        lastRetrievedAt: source.ref.retrievedAt,
        citingItems: items
          .filter((item) => item.citedSourceIds.includes(source.sourceId))
          .map((item) => ({ kind: item.kind, text: item.text, reportPath })),
        now: deps.now(),
      });
      wikiIds.push(wiki.id);
    }
    appendStage(deps, trace, "wiki", wikiIds, { sources: wikiIds.length });
    appendStage(deps, trace, "deliverable", [report.id], { items: items.length });
    assertLive(trace);
    nameEffect(deps.audit, PIPELINE_EFFECTS.writeNotes);
    finaliseReportNote({ vaultRoot: deps.vaultRoot, path: report.path, now: deps.now() });
    appendStage(deps, trace, "output", [report.id], { items: items.length });
  } catch (error) {
    trace.rollbackPublication();
    throw error;
  }
  trace.reportNoteId = reportId;
  recordSources(trace, config, outcomes, droppedIndexes, refused, true);

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
    if (error instanceof StageFailure) return failureResult(trace, error.code);
    if (!(error instanceof RunCancelled)) {
      logWarn(deps, {
        event: "research-pipeline-error",
        phase: trace.phase,
        errorName: errorName(error),
      });
    }
    return failureResult(trace, PHASE_ERROR_CODE[trace.phase]);
  }
}

// ---------------------------------------------------------------------------
// Finishing

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
    logWarn(deps, { event: "research-run-note-failed", errorName: errorName(error) });
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
    logError(deps, { event: "research-finish-failed", errorName: errorName(error) });
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
      logError(deps, { event: "research-finish-fallback-failed", errorName: errorName(second) });
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
        resolve(failureResult(trace, "interrupted"));
      }, watchdog.ms);
    });
    result = await Promise.race([runResearchPipeline(deps, trace), hung]);
  } catch {
    result = failureResult(trace, PHASE_ERROR_CODE[trace.phase]);
  } finally {
    cancel();
  }
  finishRun(deps, trace, result);
}
