import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  type JobRunOutcome,
  type NoteId,
  RESEARCH_ITEMS_PAGE_SIZE,
  RESEARCH_JOB_ID,
  RESEARCH_LIST_PAGE_SIZE,
  type ReportFrontmatter,
  type ResearchListRequest,
  type ResearchListResponse,
  type ResearchListRow,
  type ResearchReportHeader,
  type ResearchReportItem,
  type ResearchReportItemsPage,
  type ResearchReportSource,
  type ResearchReportSourcesPage,
  type ResearchStatusResponse,
  type SourceReference,
} from "@ccc/domain";
import { getResearchRunStatus, listJobRuns } from "@ccc/operational-store";
import { quoteInSource } from "@ccc/research";
import { readRawSourceNote, readReportNote, reportTitleText } from "@ccc/vault-repo";
import type Database from "better-sqlite3";
import { contentHashFor } from "./hash.js";
import type { ConfiguredSources } from "./services.js";
import type { ResearchRouteResult } from "./types.js";

/**
 * The research view models (plan 07-14; D-23, UI-SPEC "View-model requirements", research
 * Pitfall 11, T-07-07).
 *
 * Everything here is built from the validated frontmatter of a report (never from its Markdown),
 * from the raw source notes and from the job-run store. Only vault-relative paths cross the wire,
 * every text is the plain neutralised text the report schema already holds, and every response is
 * trimmed to {@link RESEARCH_RESPONSE_BUDGET_BYTES} by dropping WHOLE items from the end of a page
 * (never cutting a text), with `truncated` set and a cursor that still covers what was dropped.
 *
 * A report is served only when it is finalised (`stage: output`): a draft left by an interrupted
 * publication is neither listed nor served. A report whose frontmatter fails the strict parse is
 * listed by file name and path and is never served to the reader.
 */

/**
 * The most bytes one research response may take: the 64 KiB socket cap less 8 KiB of room for the
 * envelope and the headers (ADR-0026 section 8 precedent, research Pitfall 11).
 */
export const RESEARCH_RESPONSE_BUDGET_BYTES = 57344;

const OUTPUT_DIR = "global/output";
const REPORT_FILE_NAME = /^research-(\d{4}-\d{2}-\d{2})-([0-9a-z]{25})\.md$/;
const RUN_HISTORY_LIMIT = 200;
/** The most report files one listing or lookup considers; a folder beyond it is not walked further. */
const MAX_REPORT_FILES = 2000;
/** How much of an unreadable report is read to find its note id. */
const PEEK_BYTES = 4096;

export interface ReportEntry {
  readonly name: string;
  readonly path: string;
  readonly frontmatter: ReportFrontmatter;
}

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

// ---------------------------------------------------------------------------
// Cursors: opaque, URL-safe, validated on the way back in

function encodeCursor(payload: string): string {
  return Buffer.from(payload, "utf8").toString("base64url");
}

/** The payload of a cursor, or null when it is not exactly what {@link encodeCursor} produces. */
function decodeCursor(cursor: string): string | null {
  const payload = Buffer.from(cursor, "base64url").toString("utf8");
  return encodeCursor(payload) === cursor ? payload : null;
}

/** An offset cursor (`<prefix>:<n>`): a whole number from 1 to `length - 1`, else null. */
function decodeOffset(cursor: string, prefix: "i" | "s", length: number): number | null {
  const payload = decodeCursor(cursor);
  const match = payload === null ? null : new RegExp(`^${prefix}:(\\d{1,3})$`).exec(payload);
  if (match === null || match[1] === undefined) return null;
  const offset = Number(match[1]);
  return offset >= 1 && offset < length ? offset : null;
}

interface ListPosition {
  readonly date: string;
  /** The generation instant of the row, or "" for an unreadable one. */
  readonly generatedAt: string;
  readonly name: string;
}

const LIST_CURSOR = /^l:(\d{4}-\d{2}-\d{2})\|([0-9T:.Z-]*)\|(research-[0-9-]+-[0-9a-z]{25}\.md)$/;

function encodeListCursor(position: ListPosition): string {
  return encodeCursor(`l:${position.date}|${position.generatedAt}|${position.name}`);
}

function decodeListCursor(cursor: string): ListPosition | null {
  const payload = decodeCursor(cursor);
  const match = payload === null ? null : LIST_CURSOR.exec(payload);
  if (match === null) return null;
  const [, date, generatedAt, name] = match;
  if (date === undefined || generatedAt === undefined || name === undefined) return null;
  if (REPORT_FILE_NAME.exec(name)?.[1] !== date) return null;
  if (generatedAt !== "" && !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(generatedAt)) return null;
  return { date, generatedAt, name };
}

// ---------------------------------------------------------------------------
// Discovery

/**
 * The real `global/output` folder, or null. The folder must resolve to exactly
 * `<vault>/global/output`: a link that leaves the vault lists nothing.
 */
function outputFolder(vaultRoot: string): string | null {
  try {
    const root = realpathSync(vaultRoot);
    const folder = realpathSync(join(vaultRoot, "global", "output"));
    return folder === join(root, "global", "output") ? folder : null;
  } catch {
    return null;
  }
}

/** Report file names in `global/output`, newest file date first. Names only; nothing is read. */
export function listReportFileNames(vaultRoot: string): string[] {
  const folder = outputFolder(vaultRoot);
  if (folder === null) return [];
  let names: string[];
  try {
    names = readdirSync(folder);
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
    })
    .slice(0, MAX_REPORT_FILES);
}

export function reportPathOf(name: string): string {
  return `${OUTPUT_DIR}/${name}`;
}

interface ListCandidate {
  readonly row: ResearchListRow;
  readonly position: ListPosition;
}

/** One file as a list candidate, or null for a draft (never listed). */
function candidateOf(vaultRoot: string, name: string): ListCandidate | null {
  const date = REPORT_FILE_NAME.exec(name)?.[1] ?? "";
  const path = reportPathOf(name);
  const read = readReportNote(vaultRoot, path);
  if (!read.readable) {
    return {
      row: { readable: false, fileName: name, notePath: path },
      position: { date, generatedAt: "", name },
    };
  }
  const report = read.frontmatter;
  if (report.stage !== "output") return null;
  return {
    row: {
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
    },
    position: { date, generatedAt: report.generatedAt, name },
  };
}

/** Newest first within a day: later instant first, an unreadable report last, then name. */
function compareWithinDay(a: ListPosition, b: ListPosition): number {
  if (a.generatedAt !== b.generatedAt) return a.generatedAt < b.generatedAt ? 1 : -1;
  return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
}

/** True when `position` comes strictly after `after` in the list order. */
function isAfter(position: ListPosition, after: ListPosition): boolean {
  if (position.date !== after.date) return position.date < after.date;
  return compareWithinDay(after, position) < 0;
}

export function buildReportList(
  vaultRoot: string,
  request: ResearchListRequest,
): ResearchRouteResult<ResearchListResponse> {
  let after: ListPosition | null = null;
  if (request.cursor !== undefined) {
    after = decodeListCursor(request.cursor);
    if (after === null) return { ok: false, code: "invalid-cursor" };
  }
  const limit = request.limit ?? RESEARCH_LIST_PAGE_SIZE;

  const names = listReportFileNames(vaultRoot);
  const byDate = new Map<string, string[]>();
  for (const name of names) {
    const date = REPORT_FILE_NAME.exec(name)?.[1] ?? "";
    byDate.set(date, [...(byDate.get(date) ?? []), name]);
  }

  // Walk the day groups newest first; read a group only when the page still needs rows.
  const collected: ListCandidate[] = [];
  for (const [date, group] of byDate) {
    if (after !== null && date > after.date) continue;
    if (collected.length > limit) break;
    const candidates = group
      .map((name) => candidateOf(vaultRoot, name))
      .filter((candidate): candidate is ListCandidate => candidate !== null)
      .filter((candidate) => after === null || isAfter(candidate.position, after))
      .sort((a, b) => compareWithinDay(a.position, b.position));
    collected.push(...candidates);
  }

  const page = collected.slice(0, limit);
  const last = page[page.length - 1];
  const more = collected.length > limit && last !== undefined;
  return {
    ok: true,
    value: {
      rows: page.map((candidate) => candidate.row),
      nextCursor: more ? encodeListCursor(last.position) : null,
    },
  };
}

export type ReportLookup =
  | { readonly kind: "found"; readonly entry: ReportEntry }
  | { readonly kind: "unreadable" }
  | { readonly kind: "missing" };

/** The note id named on the `id:` line of a report's frontmatter, read without parsing it. */
function peekNoteId(vaultRoot: string, name: string): string | null {
  const folder = outputFolder(vaultRoot);
  if (folder === null) return null;
  const target = join(folder, name);
  let fd: number | null = null;
  try {
    if (!lstatSync(target).isFile()) return null;
    fd = openSync(target, "r");
    const buffer = Buffer.alloc(PEEK_BYTES);
    const read = readSync(fd, buffer, 0, PEEK_BYTES, 0);
    const head = buffer.subarray(0, read).toString("utf8");
    if (!head.startsWith("---\n")) return null;
    const end = head.indexOf("\n---", 4);
    const block = end === -1 ? head : head.slice(0, end);
    return /^id: ?["']?([0-9a-z]{25})["']?[ \t]*$/m.exec(block)?.[1] ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Finds the report with this note id. A finalised, readable report is `found`; a report whose id
 * is on its `id:` line but whose frontmatter fails the strict parse is `unreadable` (never served);
 * anything else, a draft included, is `missing`.
 */
export function findReport(vaultRoot: string, noteId: string): ReportLookup {
  for (const name of listReportFileNames(vaultRoot)) {
    const path = reportPathOf(name);
    const read = readReportNote(vaultRoot, path);
    if (read.readable) {
      if (read.frontmatter.id !== noteId) continue;
      if (read.frontmatter.stage !== "output") return { kind: "missing" };
      return { kind: "found", entry: { name, path, frontmatter: read.frontmatter } };
    }
    if (peekNoteId(vaultRoot, name) === noteId) return { kind: "unreadable" };
  }
  return { kind: "missing" };
}

// ---------------------------------------------------------------------------
// The reader pages

/**
 * The evidence text of a cited source, read back from its raw note: the stored snapshot text
 * (`evidenceText(sanitised, nonce)`, byte for byte), but only when its hash is the one the report
 * cites. A missing, reshaped or edited raw note has no evidence (null).
 */
function evidenceOf(vaultRoot: string, ref: SourceReference): string | null {
  const snapshot = readRawSourceNote(vaultRoot, ref.snapshotPath);
  if (!snapshot.readable || snapshot.text === null) return null;
  return contentHashFor(snapshot.text) === ref.contentHash ? snapshot.text : null;
}

/**
 * The findings as the reader gets them. Provenance (wave 3 A2/M3, plan 07-14): a finding that
 * carries a quote keeps it only if the exported predicate `quoteInSource` finds it in the evidence
 * text of EVERY source the finding cites, the same check the pipeline made before it wrote the
 * report. Otherwise the quote is not shown as evidence and the finding is served as the model's
 * inference (no quote, same text and citations): a hand-edited report or a changed snapshot can
 * never present words as a source's that the stored source does not hold.
 */
function itemsOf(vaultRoot: string, report: ReportFrontmatter): ResearchReportItem[] {
  const refs = new Map(report.sourceRefs.map((ref) => [ref.id, ref]));
  const numbers = new Map(report.sourceRefs.map((ref, index) => [ref.id, index + 1]));
  const evidence = new Map<string, string | null>();
  const evidenceFor = (ref: SourceReference): string | null => {
    if (!evidence.has(ref.id)) evidence.set(ref.id, evidenceOf(vaultRoot, ref));
    return evidence.get(ref.id) ?? null;
  };
  return report.items.map((item, index) => {
    const cited = [...new Set(item.citedSourceIds)]
      .map((id) => ({ number: numbers.get(id) ?? 0, title: refs.get(id)?.title ?? "" }))
      .filter((citation) => citation.number > 0)
      .sort((a, b) => a.number - b.number);
    const first = cited[0];
    const quote = item.quote;
    const verified =
      quote !== undefined &&
      first !== undefined &&
      [...new Set(item.citedSourceIds)].every((id) => {
        const ref = refs.get(id);
        const text = ref === undefined ? null : evidenceFor(ref);
        return text !== null && quoteInSource(text, quote);
      });
    return {
      index: index + 1,
      kind: quote === undefined || verified ? item.kind : "inference",
      text: item.text,
      quote: verified ? quote : null,
      quoteSourceNumber: verified ? first.number : null,
      citations: cited,
    };
  });
}

function runNotePathIfPresent(vaultRoot: string, jobRunId: string): string | null {
  const path = `automation-runs/${jobRunId}.md`;
  try {
    return lstatSync(join(vaultRoot, "automation-runs", `${jobRunId}.md`)).isFile() ? path : null;
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
    runNotePath: runNotePathIfPresent(vaultRoot, report.jobRunId),
  };
}

/**
 * Takes the longest run of whole entries from `start` (at most `pageSize`) whose page fits the
 * budget. Entries are dropped from the end of the page, never cut. `truncated` is true when the
 * budget, not the page size, ended the page; the cursor then names the first dropped entry.
 */
function fitPage<Page extends { readonly nextCursor: string | null; readonly truncated: boolean }>(
  total: number,
  start: number,
  pageSize: number,
  build: (end: number, nextCursor: string | null, truncated: boolean) => Page,
  cursorFor: (offset: number) => string,
): Page {
  const wanted = Math.min(start + pageSize, total);
  for (let end = wanted; end > start; end -= 1) {
    const next = end < total ? cursorFor(end) : null;
    const page = build(end, next, end < wanted);
    if (bytesOf(page) < RESEARCH_RESPONSE_BUDGET_BYTES) return page;
  }
  // Not even one entry fits (it cannot, by the schema caps): an empty, honest page that ends.
  return build(start, null, wanted > start);
}

export function buildReportItemsPage(
  vaultRoot: string,
  db: Database.Database,
  entry: ReportEntry,
  cursor?: string,
): ResearchRouteResult<ResearchReportItemsPage> {
  const all = itemsOf(vaultRoot, entry.frontmatter);
  let start = 0;
  if (cursor !== undefined) {
    const offset = decodeOffset(cursor, "i", all.length);
    if (offset === null) return { ok: false, code: "invalid-cursor" };
    start = offset;
  }
  const header = headerOf(vaultRoot, db, entry, all);
  const page = fitPage<ResearchReportItemsPage>(
    all.length,
    start,
    RESEARCH_ITEMS_PAGE_SIZE,
    (end, nextCursor, truncated) => ({
      page: "items",
      header,
      items: all.slice(start, end),
      nextCursor,
      truncated,
    }),
    (offset) => encodeCursor(`i:${offset}`),
  );
  return { ok: true, value: page };
}

export function buildReportSourcesPage(
  entry: ReportEntry,
  cursor?: string,
): ResearchRouteResult<ResearchReportSourcesPage> {
  const report = entry.frontmatter;
  const handling = new Map(report.sourceHandling.map((item) => [item.sourceId, item.counts]));
  const all: ResearchReportSource[] = report.sourceRefs.map((ref, index) => ({
    number: index + 1,
    ...ref,
    counts: handling.get(ref.id) ?? null,
  }));
  let start = 0;
  if (cursor !== undefined) {
    const offset = decodeOffset(cursor, "s", all.length);
    if (offset === null) return { ok: false, code: "invalid-cursor" };
    start = offset;
  }
  const page = fitPage<ResearchReportSourcesPage>(
    all.length,
    start,
    all.length,
    (end, nextCursor, truncated) => ({
      page: "sources",
      sources: all.slice(start, end),
      nextCursor,
      truncated,
    }),
    (offset) => encodeCursor(`s:${offset}`),
  );
  return { ok: true, value: page };
}

// ---------------------------------------------------------------------------
// Status

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
