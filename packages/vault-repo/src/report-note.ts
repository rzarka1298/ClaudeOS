import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  ACCESS_CLASS_DISPLAY,
  EXTRACTIVE_SUMMARISER_ID,
  type NoteId,
  newNoteId,
  REPORT_FILE_MAX_BYTES,
  REPORT_FRONTMATTER_KEY_ORDER,
  REPORT_FRONTMATTER_MAX_BYTES,
  REPORT_HANDLING_KEY_ORDER,
  REPORT_ITEM_KEY_ORDER,
  REPORT_ITEM_KIND_DISPLAY,
  REPORT_ITEM_KINDS,
  REPORT_UNAVAILABLE_SOURCE_KEY_ORDER,
  RESEARCH_JOB_ID,
  type ReportFrontmatter,
  ReportFrontmatterSchema,
  type ReportItem,
  RUN_ID_PATTERN,
  SANITISE_COUNT_KEYS,
  SANITISE_COUNTS_KEY_ORDER,
  SOURCE_FAILURE_DISPLAY,
  SOURCE_REFERENCE_KEY_ORDER,
  SOURCE_TYPE_DISPLAY,
  type SourceHandling,
  type SourceReference,
  type SummariserId,
  type UnavailableSource,
} from "@ccc/domain";
import { atomicWriteFileSync } from "./atomic-write.js";
import {
  ExtendedNoteError,
  type ExtendedNoteFail,
  type ExtendedNoteReason,
  frontmatterBlockBytes,
  orderedGeneratedBy,
  orderedList,
  orderedMap,
  parseExtendedNote,
  readBoundedFile,
  resolveGlobalNotePath,
  sha256Hex,
  stringifyExtendedNote,
} from "./extended-note.js";
import { regenerateIndex } from "./index-generation.js";
import { escapeMarkdownText, inlineCode } from "./markdown-escape.js";

/**
 * The research report note (plan 07-08; D-12, D-14, D-15, RSRCH-02/03/04, research Pattern 5).
 *
 * One report per run, in `global/output`, with a file name built from the generation date and the
 * run id only (never from untrusted text). It is written as stage `deliverable` and then
 * finalised IN PLACE as stage `output` by a second atomic write of the same path, so the report is
 * never absent between the two stages and nothing is renamed.
 *
 * The body is engine-templated from structured fields. No function here takes a pre-rendered
 * Markdown string: every untrusted field (topic, finding text and quote, source titles, authors,
 * unavailable-source labels) reaches the body only through {@link escapeMarkdownText}, and every
 * address and path only through {@link inlineCode}. The labels, glyphs and legend lines come from
 * the same domain map the reader uses (`REPORT_ITEM_KIND_DISPLAY`), so the note and the view show
 * identical words (RSRCH-04).
 *
 * The reader never throws: a report whose frontmatter was hand-edited into something invalid
 * reads back as `{ readable: false, reason }`.
 */

/** Why a report note was refused. Each code is fixed (see {@link ExtendedNoteReason}). */
export type ReportNoteReason = ExtendedNoteReason;

/** A refusal raised by the report writer or parser. The message is constant and quotes no note text. */
export class ReportNoteError extends ExtendedNoteError {
  constructor(reason: ReportNoteReason, issues: readonly unknown[] = []) {
    super(reason, `report note refused: ${reason}`, issues);
    this.name = "ReportNoteError";
  }
}

const failReport: ExtendedNoteFail = (reason, issues = []) => new ReportNoteError(reason, issues);

const OWNED_KEYS: ReadonlySet<string> = new Set(REPORT_FRONTMATTER_KEY_ORDER);

const NESTED = {
  generatedBy: orderedGeneratedBy,
  unavailableSources: (value: unknown) => orderedList(value, REPORT_UNAVAILABLE_SOURCE_KEY_ORDER),
  sourceRefs: (value: unknown) => orderedList(value, SOURCE_REFERENCE_KEY_ORDER),
  sourceHandling: (value: unknown) =>
    (value as readonly Record<string, unknown>[]).map((entry) => {
      const ordered = orderedMap(entry, REPORT_HANDLING_KEY_ORDER);
      ordered.counts = orderedMap(entry.counts, SANITISE_COUNTS_KEY_ORDER);
      return ordered;
    }),
  items: (value: unknown) => orderedList(value, REPORT_ITEM_KEY_ORDER),
} as const;

const STRINGIFY_SPEC = { keyOrder: REPORT_FRONTMATTER_KEY_ORDER, nested: NESTED };

/** The only shape a report path may have: `global/output/research-<date>-<run id>.md`. */
export const REPORT_NOTE_PATH_PATTERN =
  /^global\/output\/research-\d{4}-\d{2}-\d{2}-[0-9a-z]{25}\.md$/;

/** The only shape a run note path may have: a plain file directly in `automation-runs`. */
const RUN_NOTE_PATH_PATTERN = /^automation-runs\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.md$/;

const GENERATED_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T/;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * The vault-relative path of a run's report. Built from the date part of the generation instant
 * and the run id alone.
 *
 * @throws {RangeError} when either argument is malformed; both come from the service, so this is a
 *   programming error, and refusing keeps an unchecked value out of a path.
 */
export function reportNotePathFor(generatedAt: string, jobRunId: string): string {
  const match = GENERATED_AT_PATTERN.exec(generatedAt);
  if (match === null || !Number.isFinite(Date.parse(generatedAt))) {
    throw new RangeError("a report path needs a generation instant");
  }
  if (!RUN_ID_PATTERN.test(jobRunId)) throw new RangeError("a report path needs a run id");
  return `global/output/research-${match[1]}-${match[2]}-${match[3]}-${jobRunId}.md`;
}

/** A report note as it exists on disk. */
export interface ParsedReportNote {
  readonly frontmatter: ReportFrontmatter;
  readonly body: string;
  readonly passthrough: Record<string, unknown>;
  readonly plainDateKeys: ReadonlySet<string>;
}

/**
 * Parses one report note, refusing rather than repairing: file and frontmatter caps before any
 * YAML is loaded, then the delimiter, the core-schema load, the alias bound and the report schema.
 *
 * @throws {ReportNoteError} for every refusal; `reason` says why.
 */
export function parseReportNote(raw: string): ParsedReportNote {
  return parseExtendedNote(raw, {
    fileMaxBytes: REPORT_FILE_MAX_BYTES,
    frontmatterMaxBytes: REPORT_FRONTMATTER_MAX_BYTES,
    schema: ReportFrontmatterSchema,
    ownedKeys: OWNED_KEYS,
    fail: failReport,
  });
}

/** What {@link readReportNote} returns: a validated report, or a fixed reason, never a throw. */
export type ReadReportResult =
  | { readonly readable: true; readonly frontmatter: ReportFrontmatter; readonly body: string }
  | { readonly readable: false; readonly reason: ReportNoteReason };

/**
 * Reads a report from the vault. The path must have the report file shape and resolve inside the
 * global scope; the size is checked before the file is read. Anything wrong (a missing file, a
 * hand-edited frontmatter that fails the strict parse, a path that escapes) is a fixed reason.
 */
export function readReportNote(vaultRoot: string, path: string): ReadReportResult {
  try {
    const target = resolveGlobalNotePath(vaultRoot, path, REPORT_NOTE_PATH_PATTERN, failReport);
    const raw = readBoundedFile(target, REPORT_FILE_MAX_BYTES, failReport);
    const parsed = parseReportNote(raw);
    return { readable: true, frontmatter: parsed.frontmatter, body: parsed.body };
  } catch (error) {
    if (error instanceof ReportNoteError) return { readable: false, reason: error.reason };
    return { readable: false, reason: "invalid-path" };
  }
}

// ---------------------------------------------------------------------------
// The body

type ReportFields = Omit<ReportFrontmatter, "contentHash">;

function formatDate(generatedAt: string): string {
  const match = GENERATED_AT_PATTERN.exec(generatedAt);
  const month = MONTHS[Number(match?.[2] ?? "1") - 1] ?? "Jan";
  return `${month} ${Number(match?.[3] ?? "1")}, ${match?.[1] ?? "1970"}`;
}

function plural(count: number, one: string): string {
  return `${count} ${count === 1 ? one : `${one}s`}`;
}

function sourceNumbers(item: ReportItem, refs: readonly SourceReference[]): number[] {
  const numbers: number[] = [];
  for (const id of item.citedSourceIds) {
    const index = refs.findIndex((ref) => ref.id === id);
    if (index !== -1 && !numbers.includes(index + 1)) numbers.push(index + 1);
  }
  return numbers;
}

function renderUnavailable(report: ReportFields): string[] {
  if (!report.partial) return [];
  const lines = [
    "## Unavailable sources",
    "",
    `\u25c8 Partial \u2014 ${report.unavailableSources.length} of ${report.sourceTotal} sources were unavailable, so this report covers only the rest.`,
    "",
  ];
  for (const source of report.unavailableSources) {
    lines.push(
      `- \u2715 ${escapeMarkdownText(source.label)} \u2014 ${SOURCE_FAILURE_DISPLAY[source.code]}`,
    );
  }
  lines.push("");
  return lines;
}

function renderLegend(): string[] {
  const lines = ["## How to read this report", ""];
  for (const kind of REPORT_ITEM_KINDS) {
    const display = REPORT_ITEM_KIND_DISPLAY[kind];
    lines.push(`- ${display.glyph} **${display.label}** \u2014 ${display.meaning}`);
  }
  lines.push("");
  return lines;
}

function renderFindings(report: ReportFields): string[] {
  const lines = ["## Findings", ""];
  report.items.forEach((item, index) => {
    const display = REPORT_ITEM_KIND_DISPLAY[item.kind];
    const numbers = sourceNumbers(item, report.sourceRefs);
    lines.push(`### Finding ${index + 1}`, "", `${display.glyph} **${display.label}**`, "");
    lines.push(escapeMarkdownText(item.text), "");
    // The writer does not re-verify a quote (vault-repo cannot import @ccc/research): the domain
    // schema requires one on every fact and claim, and the trusted stage (claims.ts) upholds that
    // a stored quote is a whole-token substring of its cited sources' evidence text.
    if (item.quote !== undefined) {
      const caption = numbers.length === 1 ? "source" : "sources";
      lines.push(`Quoted from ${caption} ${numbers.join(", ")}:`, "");
      lines.push(`> ${escapeMarkdownText(item.quote)}`, "");
    }
    lines.push(
      numbers.length === 0
        ? "No source cited"
        : `Sources: ${numbers.map((n) => `\\[${n}\\]`).join(" ")}`,
      "",
    );
  });
  return lines;
}

function renderHandling(handling: SourceHandling | undefined): string[] {
  if (handling === undefined) return [];
  const parts = SANITISE_COUNT_KEYS.map((key) => `${key} ${handling.counts[key]}`);
  return [`    - Removed before summarising: ${parts.join(", ")}`];
}

function renderSources(report: ReportFields): string[] {
  const lines = ["## Sources", ""];
  report.sourceRefs.forEach((ref, index) => {
    lines.push(`${index + 1}. ${escapeMarkdownText(ref.title)}`);
    lines.push(`    - Type: ${SOURCE_TYPE_DISPLAY[ref.sourceType]}`);
    lines.push(`    - Access: ${ACCESS_CLASS_DISPLAY[ref.accessClass].label}`);
    if (ref.canonicalUrl !== undefined)
      lines.push(`    - Address: ${inlineCode(ref.canonicalUrl)}`);
    if (ref.deepLink !== undefined) lines.push(`    - Address: ${inlineCode(ref.deepLink)}`);
    lines.push(
      `    - Author: ${ref.author === null ? "Not provided" : escapeMarkdownText(ref.author)}`,
    );
    lines.push(
      `    - Published: ${ref.publishedAt === null ? "Not provided" : inlineCode(ref.publishedAt)}`,
    );
    lines.push(`    - Retrieved: ${inlineCode(ref.retrievedAt)}`);
    lines.push(`    - Content hash: ${inlineCode(ref.contentHash)}`);
    lines.push(`    - Snapshot: ${inlineCode(ref.snapshotPath)}`);
    lines.push(...renderHandling(report.sourceHandling.find((entry) => entry.sourceId === ref.id)));
  });
  lines.push("");
  return lines;
}

function summariserText(summariser: SummariserId): string {
  return summariser === EXTRACTIVE_SUMMARISER_ID
    ? "the extractive summariser (no model)"
    : inlineCode(summariser);
}

/**
 * Renders the report body from validated structured fields, in the order the reader shows its
 * blocks (UI-SPEC R4): title, AI line, partial notice, legend, findings, sources, run record.
 * Deterministic: the same fields give the same bytes.
 */
export function renderReportBody(report: ReportFields, runNotePath?: string): string {
  const counts = REPORT_ITEM_KINDS.map((kind) => {
    const count = report.items.filter((item) => item.kind === kind).length;
    const label = REPORT_ITEM_KIND_DISPLAY[kind].label.toLowerCase();
    return plural(count, label);
  });
  const lines: string[] = [
    `# ${escapeMarkdownText(report.topicLabel)} \u2014 ${formatDate(report.generatedAt)}`,
    "",
    `AI-generated summary by ${summariserText(report.summariser)}. Not verified by a person.`,
    "",
    `Generated ${inlineCode(report.generatedAt)}. ${report.sourceRefs.length} of ${report.sourceTotal} sources contributed. ${plural(report.items.length, "finding")}: ${counts.join(", ")}.`,
    "",
    ...renderUnavailable(report),
    ...renderLegend(),
    ...renderFindings(report),
    ...renderSources(report),
    "## Run record",
    "",
    `- Run: ${inlineCode(report.jobRunId)}`,
  ];
  if (runNotePath !== undefined) lines.push(`- Run note: ${inlineCode(runNotePath)}`);
  lines.push(`- Summariser: ${summariserText(report.summariser)}`, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Writers

/** Everything a caller supplies to write one report. Structured fields only. */
export interface WriteReportNoteOptions {
  readonly vaultRoot: string;
  readonly topicLabel: string;
  /** ISO instant the report was generated; its date part names the file. */
  readonly generatedAt: string;
  readonly jobRunId: string;
  readonly summariser: SummariserId;
  /** How many sources the run tried. */
  readonly sourceTotal: number;
  readonly unavailableSources: readonly UnavailableSource[];
  /** The sources that contributed, in the order citations are numbered. */
  readonly sourceRefs: readonly SourceReference[];
  readonly sourceHandling: readonly SourceHandling[];
  readonly items: readonly ReportItem[];
  /** Vault-relative path of the run's `automation-runs` note, shown in the run record. */
  readonly runNotePath?: string;
  readonly now?: Date;
}

/** What one report write produced. */
export interface WrittenReportNote {
  readonly id: NoteId;
  /** Vault-relative, POSIX-separated. */
  readonly path: string;
  readonly absolutePath: string;
  readonly frontmatter: ReportFrontmatter;
  /** SHA-256 of the complete file bytes. */
  readonly contentHash: string;
}

interface Existing {
  readonly id: string;
  readonly stage: ReportFrontmatter["stage"];
  readonly created: string;
  readonly passthrough: Record<string, unknown>;
  readonly plainDateKeys: ReadonlySet<string>;
}

/** The identity of a report already at `target`, or null when there is none. */
function readExisting(target: string): Existing | null {
  if (!existsSync(target)) return null;
  try {
    const raw = readBoundedFile(target, REPORT_FILE_MAX_BYTES, failReport);
    const parsed = parseReportNote(raw);
    return {
      id: parsed.frontmatter.id,
      stage: parsed.frontmatter.stage,
      created: parsed.frontmatter.created,
      passthrough: parsed.passthrough,
      plainDateKeys: parsed.plainDateKeys,
    };
  } catch (error) {
    // Never overwrite a file this module cannot read back: it may be the owner's hand edit.
    if (error instanceof ReportNoteError) throw new ReportNoteError("existing-unreadable");
    throw error;
  }
}

function assertWithinCaps(text: string): void {
  if (Buffer.byteLength(text, "utf8") > REPORT_FILE_MAX_BYTES)
    throw new ReportNoteError("too-large");
  if (frontmatterBlockBytes(text) > REPORT_FRONTMATTER_MAX_BYTES) {
    throw new ReportNoteError("frontmatter-too-large");
  }
}

function writeAndIndex(
  vaultRoot: string,
  path: string,
  target: string,
  frontmatter: ReportFrontmatter,
  text: string,
): WrittenReportNote {
  assertWithinCaps(text);
  const folder = dirname(target);
  mkdirSync(folder, { recursive: true });
  atomicWriteFileSync(target, text);
  regenerateIndex(folder, { vaultRoot });
  return {
    id: frontmatter.id as NoteId,
    path,
    absolutePath: target,
    frontmatter,
    contentHash: sha256Hex(text),
  };
}

/**
 * Writes the report for a run as stage `deliverable`. The frontmatter is validated by the report
 * schema before anything is written, so a caller cannot write a report the reader would refuse;
 * scope and containment are verified before any directory is created.
 *
 * Writing the same report again keeps the note id, the `created` stamp and any keys the owner
 * added, so with the same clock the file is byte-identical. A report that is already at stage
 * `output` stays `output` (a retry never regresses a finalised report). A file that already exists
 * but cannot be read back is never overwritten.
 *
 * @throws {ReportNoteError} for a bad run note path, an unreadable existing file or an oversized note.
 * @throws {ZodError} when the supplied fields do not satisfy the report schema.
 * @throws {WorkspaceScopeViolationError} when the target resolves outside the global scope.
 */
export function writeReportNote(options: WriteReportNoteOptions): WrittenReportNote {
  if (options.runNotePath !== undefined && !RUN_NOTE_PATH_PATTERN.test(options.runNotePath)) {
    throw new ReportNoteError("invalid-path");
  }
  const path = reportNotePathFor(options.generatedAt, options.jobRunId);
  const target = resolveGlobalNotePath(
    options.vaultRoot,
    path,
    REPORT_NOTE_PATH_PATTERN,
    failReport,
  );
  const existing = readExisting(target);

  const now = (options.now ?? new Date()).toISOString();
  const validated = ReportFrontmatterSchema.parse({
    id: existing?.id ?? newNoteId(),
    scope: "global",
    // A retry never regresses a finalised report: an existing `output` stays `output`.
    stage: existing?.stage === "output" ? "output" : "deliverable",
    created: existing?.created ?? now,
    updated: now,
    generatedBy: {
      ...(options.summariser === EXTRACTIVE_SUMMARISER_ID ? {} : { model: options.summariser }),
      automation: RESEARCH_JOB_ID,
      runId: options.jobRunId,
    },
    aiGenerated: true,
    claimType: "summary",
    sources: options.sourceRefs.map((ref) => ref.id),
    confidence: "unverified",
    lastReviewed: null,
    type: "report",
    topicLabel: options.topicLabel,
    generatedAt: options.generatedAt,
    jobRunId: options.jobRunId,
    summariser: options.summariser,
    partial: options.unavailableSources.length > 0,
    sourceTotal: options.sourceTotal,
    unavailableSources: options.unavailableSources,
    sourceRefs: options.sourceRefs,
    sourceHandling: options.sourceHandling,
    items: options.items,
  });

  const body = renderReportBody(validated, options.runNotePath);
  const frontmatter: ReportFrontmatter = { ...validated, contentHash: sha256Hex(body) };
  const text = stringifyExtendedNote(
    frontmatter,
    body,
    STRINGIFY_SPEC,
    existing?.passthrough,
    existing?.plainDateKeys,
  );
  return writeAndIndex(options.vaultRoot, path, target, frontmatter, text);
}

/** Everything needed to finalise a report. */
export interface FinaliseReportNoteOptions {
  readonly vaultRoot: string;
  /** Vault-relative path returned by {@link writeReportNote}. */
  readonly path: string;
  readonly now?: Date;
}

/**
 * Finalises a report in place: stage `deliverable` becomes `output` and `updated` moves forward,
 * by a second atomic write of the same path. Every other byte of the frontmatter and the body is
 * unchanged, there is no rename, and the report is never absent. A report that is already `output`
 * is returned as it is, so finalising twice is harmless.
 *
 * @throws {ReportNoteError} when the path is not a report path or the file cannot be read back.
 */
export function finaliseReportNote(options: FinaliseReportNoteOptions): WrittenReportNote {
  const target = resolveGlobalNotePath(
    options.vaultRoot,
    options.path,
    REPORT_NOTE_PATH_PATTERN,
    failReport,
  );
  const raw = readBoundedFile(target, REPORT_FILE_MAX_BYTES, failReport);
  const parsed = parseReportNote(raw);
  if (parsed.frontmatter.stage === "output") {
    return {
      id: parsed.frontmatter.id as NoteId,
      path: options.path,
      absolutePath: target,
      frontmatter: parsed.frontmatter,
      contentHash: sha256Hex(raw),
    };
  }
  const frontmatter = ReportFrontmatterSchema.parse({
    ...parsed.frontmatter,
    stage: "output",
    updated: (options.now ?? new Date()).toISOString(),
  });
  const text = stringifyExtendedNote(
    frontmatter,
    parsed.body,
    STRINGIFY_SPEC,
    parsed.passthrough,
    parsed.plainDateKeys,
  );
  return writeAndIndex(options.vaultRoot, options.path, target, frontmatter, text);
}

/** Everything needed to take a report back. */
export interface RemoveReportNoteOptions {
  readonly vaultRoot: string;
  /** Vault-relative path of the report (the shape {@link reportNotePathFor} produces). */
  readonly path: string;
}

/**
 * Takes a report back out of the vault: the file is deleted, then the folder index is rebuilt.
 * It exists so a run that fails after its report was written can leave no exposed report behind
 * (07-FIX4 b). A report that is not there is not an error. The file is gone even when the index
 * rebuild then throws; the throw tells the caller the index is stale.
 *
 * @throws {ReportNoteError} when the path is not a report path.
 * @throws {WorkspaceScopeViolationError} when the target resolves outside the global scope.
 */
export function removeReportNote(options: RemoveReportNoteOptions): void {
  const target = resolveGlobalNotePath(
    options.vaultRoot,
    options.path,
    REPORT_NOTE_PATH_PATTERN,
    failReport,
  );
  if (!existsSync(target)) return;
  rmSync(target, { force: true });
  regenerateIndex(dirname(target), { vaultRoot: options.vaultRoot });
}
