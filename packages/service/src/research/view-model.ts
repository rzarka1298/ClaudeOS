import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type JobRunOutcome,
  type NoteId,
  RESEARCH_ITEMS_PAGE_SIZE,
  RESEARCH_JOB_ID,
  RESEARCH_LIST_PAGE_SIZE,
  type ReportFrontmatter,
  type ResearchListResponse,
  type ResearchListRow,
  type ResearchReportHeader,
  type ResearchReportItem,
  type ResearchReportItemsPage,
  type ResearchReportSource,
  type ResearchReportSourcesPage,
  type ResearchStatusResponse,
} from "@ccc/domain";
import { getResearchRunStatus, listJobRuns } from "@ccc/operational-store";
import { readReportNote, reportTitleText } from "@ccc/vault-repo";
import type Database from "better-sqlite3";
import type { ConfiguredSources } from "./services.js";

/**
 * The research view models (plan 07-14; D-23, UI-SPEC "View-model requirements", T-07-07).
 *
 * Everything here is built from the validated frontmatter of a report (never from its Markdown),
 * from the raw source notes and from the job-run store. Only vault-relative paths cross the wire,
 * and every text is the plain neutralised text the report schema already holds.
 */

const OUTPUT_DIR = "global/output";
const REPORT_FILE_NAME = /^research-(\d{4}-\d{2}-\d{2})-([0-9a-z]{25})\.md$/;
const RUN_HISTORY_LIMIT = 200;

export interface ReportEntry {
  readonly name: string;
  readonly path: string;
  readonly frontmatter: ReportFrontmatter;
}

/** Report file names in `global/output`, newest file date first. Names only; nothing is read. */
export function listReportFileNames(vaultRoot: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(vaultRoot, "global", "output"));
  } catch {
    return [];
  }
  return names
    .filter((name) => REPORT_FILE_NAME.test(name))
    .sort((a, b) => {
      const dateA = REPORT_FILE_NAME.exec(a)?.[1] ?? "";
      const dateB = REPORT_FILE_NAME.exec(b)?.[1] ?? "";
      if (dateA !== dateB) return dateA < dateB ? 1 : -1;
      return a < b ? 1 : a > b ? -1 : 0;
    });
}

export function reportPathOf(name: string): string {
  return `${OUTPUT_DIR}/${name}`;
}

function rowOf(vaultRoot: string, name: string): ResearchListRow | null {
  const path = reportPathOf(name);
  const read = readReportNote(vaultRoot, path);
  if (!read.readable) return { readable: false, fileName: name, notePath: path };
  const report = read.frontmatter;
  return {
    readable: true,
    noteId: report.id,
    notePath: path,
    title: reportTitleText(report.topicLabel, report.generatedAt),
    generatedAt: report.generatedAt,
    partial: report.partial,
    sourceCount: report.sourceRefs.length,
    sourceTotal: report.sourceTotal,
    itemCount: report.items.length,
    unavailableCount: report.unavailableSources.length,
  };
}

export function buildReportList(vaultRoot: string): ResearchListResponse {
  const rows: ResearchListRow[] = [];
  for (const name of listReportFileNames(vaultRoot).slice(0, RESEARCH_LIST_PAGE_SIZE)) {
    const row = rowOf(vaultRoot, name);
    if (row !== null) rows.push(row);
  }
  return { rows, nextCursor: null };
}

export function findReport(vaultRoot: string, noteId: string): ReportEntry | null {
  for (const name of listReportFileNames(vaultRoot)) {
    const path = reportPathOf(name);
    const read = readReportNote(vaultRoot, path);
    if (read.readable && read.frontmatter.id === noteId) {
      return { name, path, frontmatter: read.frontmatter };
    }
  }
  return null;
}

function sourceNumbers(report: ReportFrontmatter): ReadonlyMap<string, number> {
  return new Map(report.sourceRefs.map((ref, index) => [ref.id, index + 1]));
}

function itemsOf(report: ReportFrontmatter): ResearchReportItem[] {
  const numbers = sourceNumbers(report);
  const titles = new Map(report.sourceRefs.map((ref) => [ref.id, ref.title]));
  return report.items.map((item, index) => {
    const cited = [...new Set(item.citedSourceIds)]
      .map((id) => ({ number: numbers.get(id) ?? 0, title: titles.get(id) ?? "" }))
      .filter((citation) => citation.number > 0)
      .sort((a, b) => a.number - b.number);
    const first = cited[0];
    const hasQuote = item.quote !== undefined && first !== undefined;
    return {
      index: index + 1,
      kind: item.kind,
      text: item.text,
      quote: hasQuote ? (item.quote ?? null) : null,
      quoteSourceNumber: hasQuote ? first.number : null,
      citations: cited,
    };
  });
}

function runNoteExists(vaultRoot: string, jobRunId: string): string | null {
  const path = `automation-runs/${jobRunId}.md`;
  const absolute = join(vaultRoot, "automation-runs", `${jobRunId}.md`);
  try {
    return existsSync(absolute) && lstatSync(absolute).isFile() ? path : null;
  } catch {
    return null;
  }
}

function headerOf(
  vaultRoot: string,
  db: Database.Database,
  entry: ReportEntry,
  items: readonly ResearchReportItem[],
): ResearchReportHeader {
  const report = entry.frontmatter;
  const run = listJobRuns(db, RESEARCH_JOB_ID, RUN_HISTORY_LIMIT).find(
    (candidate) => candidate.jobRunId === report.jobRunId,
  );
  const kindCounts = { "source-fact": 0, "unverified-claim": 0, inference: 0 };
  for (const item of items) kindCounts[item.kind] += 1;
  return {
    title: reportTitleText(report.topicLabel, report.generatedAt),
    noteId: report.id,
    notePath: entry.path,
    generatedAt: report.generatedAt,
    partial: report.partial,
    unavailableSources: report.unavailableSources.map((source) => ({
      label: source.label,
      code: source.code,
    })),
    sourceCount: report.sourceRefs.length,
    sourceTotal: report.sourceTotal,
    kindCounts,
    summariser: report.summariser,
    jobRunId: report.jobRunId as ResearchReportHeader["jobRunId"],
    runStartedAt: run?.startedAt ?? null,
    runEndedAt: run?.endedAt ?? null,
    runOutcome: (run?.outcome ?? null) as JobRunOutcome | null,
    runNotePath: runNoteExists(vaultRoot, report.jobRunId),
  };
}

export function buildReportItemsPage(
  vaultRoot: string,
  db: Database.Database,
  entry: ReportEntry,
): ResearchReportItemsPage {
  const all = itemsOf(entry.frontmatter);
  return {
    page: "items",
    header: headerOf(vaultRoot, db, entry, all),
    items: all.slice(0, RESEARCH_ITEMS_PAGE_SIZE),
    nextCursor: null,
    truncated: false,
  };
}

export function buildReportSourcesPage(entry: ReportEntry): ResearchReportSourcesPage {
  const report = entry.frontmatter;
  const handling = new Map(report.sourceHandling.map((item) => [item.sourceId, item.counts]));
  const sources: ResearchReportSource[] = report.sourceRefs.map((ref, index) => ({
    number: index + 1,
    ...ref,
    counts: handling.get(ref.id) ?? null,
  }));
  return { page: "sources", sources, nextCursor: null, truncated: false };
}

export function buildResearchStatus(
  db: Database.Database,
  configured: ConfiguredSources | null,
): ResearchStatusResponse {
  const status = getResearchRunStatus(db, RESEARCH_JOB_ID);
  const success = status.lastSuccess;
  const failure = status.lastFailure;
  const inFlight = status.inFlight;
  const unknown = status.latestUnknown;
  return {
    lastSuccess:
      success !== null &&
      success.endedAt !== null &&
      (success.outcome === "success" || success.outcome === "partial") &&
      success.reportNoteId !== null &&
      success.sourceCount !== null &&
      success.sourceTotal !== null
        ? {
            runId: success.jobRunId,
            endedAt: success.endedAt,
            outcome: success.outcome,
            sourceCount: success.sourceCount,
            sourceTotal: success.sourceTotal,
            reportNoteId: success.reportNoteId as NoteId,
          }
        : null,
    lastFailure:
      failure !== null && failure.endedAt !== null && failure.errorCode !== null
        ? { runId: failure.jobRunId, endedAt: failure.endedAt, errorCode: failure.errorCode }
        : null,
    inFlight:
      inFlight !== null && inFlight.startedAt !== null
        ? { runId: inFlight.jobRunId, startedAt: inFlight.startedAt, stage: inFlight.latestStage }
        : null,
    latestUnknown:
      unknown !== null && unknown.startedAt !== null
        ? { runId: unknown.jobRunId, startedAt: unknown.startedAt }
        : null,
    configuredSources: configured === null ? null : [...configured.sources],
    topicLabel: configured === null ? null : configured.topicLabel,
  };
}
