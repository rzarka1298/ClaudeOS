import type { ReportItem, ResearchSourcesConfig } from "@ccc/domain";
import { recordResearchReport, removeResearchReportRecord } from "@ccc/operational-store";
import {
  captureWikiSourceNote,
  finaliseReportNote,
  readReportNote,
  removeReportNote,
  reportNotePathFor,
  type WikiSourceSnapshot,
  writeReportNote,
  writeWikiSourceNote,
} from "@ccc/vault-repo";
import { nameEffect, PIPELINE_EFFECTS } from "./pipeline-effects.js";
import {
  isRunGone,
  type Prepared,
  type PreparedSource,
  recordSources,
} from "./pipeline-sources.js";
import {
  appendStage,
  assertLive,
  errorClassName,
  logWarn,
  type ResearchPipelineDeps,
  type RunTrace,
  StageFailure,
  type SummariserChoice,
} from "./pipeline-trace.js";
import { reportContentDigest } from "./report-digest.js";

/**
 * The publication stage (09-12, D-12): the report written first, then the wiki notes, then the report
 * finalised and bound to the run in the operational store; all or nothing. Moved out of runStages
 * verbatim into its own module to keep pipeline-stages.ts under 400 lines.
 */

/** What the publication stage reads: the allowlist, the summariser, the source outcomes, the items. */
export interface PublicationInput {
  readonly config: ResearchSourcesConfig;
  readonly choice: SummariserChoice;
  readonly outcomes: readonly Prepared[];
  readonly droppedIndexes: ReadonlySet<number>;
  readonly refused: ReadonlySet<number>;
  readonly usable: readonly PreparedSource[];
  readonly items: readonly ReportItem[];
}

/** What the publication stage answers: the id of the finalised report note. */
export interface PublicationOutput {
  readonly reportId: string;
}

export async function runPublicationStage(
  deps: ResearchPipelineDeps,
  trace: RunTrace,
  input: PublicationInput,
): Promise<PublicationOutput> {
  const { config, choice, outcomes, droppedIndexes, refused, usable, items } = input;
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
        logWarn(deps, { event: "research-wiki-restore-failed", errorName: errorClassName(error) });
      }
    }
    try {
      removeReportNote({ vaultRoot: deps.vaultRoot, path: reportPath });
    } catch (error) {
      logWarn(deps, { event: "research-report-removal-failed", errorName: errorClassName(error) });
    }
    try {
      // The record goes with the report it describes (a missing record only ever means unverified).
      removeResearchReportRecord(deps.db, trace.runId);
    } catch (error) {
      logWarn(deps, {
        event: "research-report-record-removal-failed",
        errorName: errorClassName(error),
      });
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
    // The digest the store will vouch for is the one of the report THIS pipeline produced, taken
    // here from the in-memory frontmatter that was validated and written, never from what the vault
    // holds later. The digest leaves the stage out (finalising changes only the stage), so it is
    // also the digest the finalised form must have. A vault-confined writer who rewrites the report
    // between this write and its finalising (during the wiki writes) cannot get the rewrite
    // blessed: the read-back below has to equal this value (07-FIX7, ADR-0030).
    const trustedDigest = reportContentDigest(report.frontmatter);

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
    // Bind the report to this run in the operational store (07-FIX6b, ADR-0030): read the finalised
    // report back from the vault, exactly as the reader will parse it, and record the digest of what
    // it says. This comes before the output stage is logged, because a run still working vouches
    // for its report only once that stage names it, and before the run is finished.
    const finalised = readReportNote(deps.vaultRoot, report.path);
    if (
      !finalised.readable ||
      finalised.frontmatter.id !== report.id ||
      finalised.frontmatter.stage !== "output"
    ) {
      throw new Error("the finalised report cannot be read back");
    }
    // The vault is read back only to prove the finalised report is the one this run wrote. A
    // report that changed in between is not published and no digest is recorded for it: the run
    // fails, and the rollback below takes the report back out.
    if (reportContentDigest(finalised.frontmatter) !== trustedDigest) {
      logWarn(deps, { event: "research-report-changed-before-finalise" });
      throw new Error("the report changed between its publication and its finalising");
    }
    try {
      recordResearchReport(deps.db, {
        jobRunId: trace.runId,
        reportNoteId: report.id,
        contentDigest: trustedDigest,
        recordedAt: deps.now().toISOString(),
      });
    } catch (error) {
      if (isRunGone(error)) {
        logWarn(deps, {
          event: "research-report-record-run-ended",
          errorName: errorClassName(error),
        });
        throw new StageFailure("interrupted");
      }
      throw error;
    }
    appendStage(deps, trace, "output", [report.id], { items: items.length });
  } catch (error) {
    trace.rollbackPublication();
    throw error;
  }
  trace.reportNoteId = reportId;
  recordSources(trace, config, outcomes, droppedIndexes, refused, true);
  return { reportId };
}
