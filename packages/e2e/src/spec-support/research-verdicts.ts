import {
  ACCESS_CLASS_DISPLAY,
  REPORT_ITEM_KIND_DISPLAY,
  REPORT_ITEM_KINDS,
  type ReportItemKind,
  RUN_STATE_DISPLAY,
  SOURCE_TYPE_DISPLAY,
} from "@ccc/domain";
import { RESEARCH_UAT_TOPIC } from "../research-uat-fixture.js";
import { allMotionOff, anyMotionOn, focusRingVisible, type MotionSample } from "./cross-support.js";
import { RAW_BANNER, RESEARCH_CLASSES, RESEARCH_TEXT } from "./research-copy.js";
import type {
  ArticleFacts,
  ReadingViewFacts,
  RenderedReader,
  RenderedResearch,
  RenderedRow,
  RenderedSource,
  ResearchFocus,
  ResearchLayoutFacts,
  TranscriptRecord,
} from "./research-dom.js";
import {
  checkRunTrace,
  type ParsedRawNote,
  type ParsedReportNote,
  parseRunNote,
  parseStageLog,
  scalarOf,
} from "./research-notes.js";
import type { AutomationRunRow, JobRunRow, VaultNotes } from "./research-support.js";

/**
 * Pure verdicts over what the Research destination showed (plan 07-17). Each returns the list of
 * problems found, in plain words, and the empty list when the item's expectation holds; a spec
 * asserts `toEqual([])`, so a failure names what was missing instead of "expected false to be
 * true". Nothing here reads a clock or a file.
 */

// ---------------------------------------------------------------------------
// 07-UAT item 2: the run as it happens

const RUNNING_WORD = "▸ Running";

/**
 * The closed set of words the Current run row may read for what the run is doing now (the plugin's
 * ACTIVITY_AFTER_STAGE and ACTIVITY_BEFORE_ANY_STAGE).
 */
const STAGE_WORDS = [
  RESEARCH_TEXT.stageCapture,
  RESEARCH_TEXT.stageRaw,
  "Summarising",
  "Updating source notes",
  "Writing the report",
] as const;

/**
 * The status line and the Current run row over one run (record order is time order): the status
 * line reads the starting sentence, then the started sentence, then that a report is ready; the
 * Current run row shows `▸ Running` with a word from the closed set, and is gone when the run has
 * ended.
 *
 * The row names what the run is doing NOW (07-FIX7): the service sends the last stage the run has
 * logged, and the pipeline logs a stage when it is finished, so before any stage is logged the row
 * reads `Reading the source list` and, once the source list is read and while the sources are
 * fetched, `Fetching sources`. The fixture holds the run in its fetch, so `Fetching sources` must
 * be shown, and shown first unless the short-lived earlier state `Reading the source list` was caught.
 * A fixture answers in milliseconds after that hold, so the later words are shown only if a status
 * fetch lands in between; seeing them is not required.
 */
export function checkRunTranscript(records: readonly TranscriptRecord[]): string[] {
  const problems: string[] = [];
  const firstAt = (match: (status: string) => boolean): number =>
    records.findIndex((entry) => match(entry.status));
  const starting = firstAt((status) => status === RESEARCH_TEXT.statusStarting);
  const started = firstAt((status) => status === RESEARCH_TEXT.statusStarted);
  const ready = firstAt((status) => status.startsWith(RESEARCH_TEXT.reportReadyPrefix));
  if (starting < 0) problems.push("the status line never read the starting sentence");
  if (started < 0) problems.push("the status line never read the started sentence");
  if (ready < 0) problems.push("the status line never read that a report is ready");
  if (starting >= 0 && started >= 0 && ready >= 0 && !(starting < started && started < ready)) {
    problems.push("the status line sentences came in the wrong order");
  }
  const running = records.filter((entry) => entry.current?.includes(RUNNING_WORD) === true);
  if (running.length === 0) problems.push("the Current run row never showed Running");
  // `▸ Running · {words} · started {time}`: the row always names what the run is doing, so a row
  // with no word between Running and started is a defect, not an early state.
  const parts = running.map((entry) => (entry.current ?? "").split(" · "));
  const words = parts.filter((entry) => entry.length >= 3).map((entry) => entry[1] ?? "");
  if (running.length > 0 && words.length === 0) {
    problems.push("the Current run row never named a stage");
  } else if (parts.some((entry) => entry.length < 3)) {
    problems.push("the Current run row showed Running with no stage word");
  }
  if (words.some((word) => !(STAGE_WORDS as readonly string[]).includes(word))) {
    problems.push("the Current run row showed a stage word outside the closed set");
  }
  const first = words[0];
  if (
    first !== undefined &&
    first !== RESEARCH_TEXT.stageCapture &&
    first !== RESEARCH_TEXT.stageRaw
  ) {
    problems.push("the Current run row did not first name the held fetch stage");
  } else if (words.length > 0 && !words.includes(RESEARCH_TEXT.stageRaw)) {
    problems.push("the Current run row never named the held fetch stage");
  }
  const last = records[records.length - 1];
  if (last !== undefined && last.current !== null) {
    problems.push("the Current run row was still there when the run ended");
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 07-UAT item 2: the list row

export interface RowExpectation {
  /** The source count as the row writes it: `3 sources`, or `2 of 3 sources` for a partial report. */
  readonly sourcesPhrase: string;
  /** The item count as the row writes it: `3 items`. */
  readonly itemsPhrase: string;
  /** The row's instant must fall within these epoch milliseconds. */
  readonly notBefore: number;
  readonly notAfter: number;
  /** True when the row must carry the Partial badge. */
  readonly partial?: boolean;
}

/**
 * A readable list row: its generation time, the freshness badge `◐ Cached`, the source count and
 * the item count; the Partial badge only when the report is partial.
 */
export function checkReportRow(row: RenderedRow, expectation: RowExpectation): string[] {
  const problems: string[] = [];
  if (row.unreadable) problems.push("the row is an unreadable report");
  if (row.dateTime === null) {
    problems.push("the row has no generation time");
  } else {
    const at = Date.parse(row.dateTime);
    if (!Number.isFinite(at) || at < expectation.notBefore || at > expectation.notAfter) {
      problems.push("the generation time is outside the run");
    }
  }
  const cached = row.badges.find((entry) => entry.kind === "cached");
  if (cached === undefined || cached.glyph !== "◐" || cached.label !== "Cached") {
    problems.push("the row shows no Cached badge with its glyph");
  }
  for (const phrase of [expectation.sourcesPhrase, expectation.itemsPhrase]) {
    // Whole-phrase match, so `3 sources` is not found inside `13 sources`.
    if (!new RegExp(`(^|[^0-9])${phrase}(?![A-Za-z])`).test(row.meta)) {
      problems.push(`the row does not say ${phrase}`);
    }
  }
  const partial = row.badges.some((entry) => entry.kind === "partial");
  if (expectation.partial === true && !partial) problems.push("the row shows no Partial badge");
  if (expectation.partial !== true && partial) problems.push("the row shows a Partial badge");
  return problems;
}

// ---------------------------------------------------------------------------
// 07-UAT item 1: the first open

/** The destination as it is before any run: nothing run, nothing listed (07-UAT item 1). */
export function checkFirstOpen(read: RenderedResearch): string[] {
  if (!read.mounted) return ["the Research destination is not mounted"];
  const problems: string[] = [];
  if (read.heading !== RESEARCH_TEXT.heading) problems.push("the heading is not Research");
  if (!read.runNow.present) problems.push("there is no Run now button");
  else {
    if (read.runNow.label !== RESEARCH_TEXT.runNowLabel)
      problems.push("the button is not labelled Run now");
    if (read.runNow.disabled) problems.push("Run now is disabled");
  }
  if (read.subline !== `${RESEARCH_UAT_TOPIC} · 3 sources configured`) {
    problems.push("the subline is not the topic and the configured source count");
  }
  const rowOf = (label: string) => read.runStatus.rows.find((row) => row.label === label);
  if (rowOf(RESEARCH_TEXT.lastSuccessLabel)?.value !== RESEARCH_TEXT.noneYet) {
    problems.push("Last successful run does not read None yet");
  }
  if (rowOf(RESEARCH_TEXT.lastFailureLabel)?.value !== RESEARCH_TEXT.none) {
    problems.push("Last failed run does not read None");
  }
  if (read.list.emptyHeading !== RESEARCH_TEXT.emptyReportsHeading) {
    problems.push("the Reports list does not say No reports yet");
  }
  if (read.list.emptyBody !== RESEARCH_TEXT.emptyNeverRun) {
    problems.push("the Reports empty text is not the first-run sentence");
  }
  if (read.status !== "") problems.push("the status line is not empty");
  return problems;
}

// ---------------------------------------------------------------------------
// 07-UAT item 3: one run traced end to end

export interface TraceInput {
  readonly jobRunId: string;
  readonly notes: VaultNotes;
  readonly job: JobRunRow | undefined;
  readonly runs: readonly AutomationRunRow[];
}

/**
 * The run's records agree (RSRCH-02, RSRCH-06, SC1): its note in `automation-runs` lists the six
 * stages with the note ids each produced, the store holds the same stage log, every raw note is
 * stage `raw`, every wiki note `wiki` and the report `output`, and the job run and its paired
 * run completed with outcome success.
 */
export function checkRunRecords(input: TraceInput): string[] {
  const problems: string[] = [];
  const { notes, job } = input;
  const runFile = notes.runs.find((entry) => entry.name === `${input.jobRunId}.md`);
  if (runFile === undefined) problems.push("there is no run note for the run");
  if (job === undefined) problems.push("the store has no job run for the run");
  const paired = input.runs.find((entry) => entry.run_id === input.jobRunId);
  if (paired === undefined) problems.push("the store has no paired run");
  else if (paired.state !== "completed") {
    problems.push(`the paired run is ${paired.state}, not completed`);
  }
  if (job !== undefined && job.outcome !== "success") {
    problems.push(`the store outcome is ${job.outcome}, not success`);
  }

  const stageOfNote = new Map<string, string | null>();
  const folders = [
    ["raw", notes.raw, "raw"],
    ["wiki", notes.wiki, "wiki"],
    ["output", notes.output, "output"],
  ] as const;
  for (const [folder, files, want] of folders) {
    for (const file of files) {
      const id = scalarOf(file.text, "id");
      const stage = scalarOf(file.text, "stage");
      if (id !== null) stageOfNote.set(id, stage);
      if (stage !== want) problems.push(`${folder}/${file.name} is stage ${stage}, not ${want}`);
    }
  }
  if (runFile !== undefined && job !== undefined) {
    const verdict = checkRunTrace({
      runNote: parseRunNote(runFile.text),
      stageLog: parseStageLog(job.stage_log),
      stageOfNote,
    });
    if (!verdict.ok) problems.push(...verdict.problems);
  }
  const report = notes.output.find((file) => scalarOf(file.text, "jobRunId") === input.jobRunId);
  if (report === undefined) problems.push("there is no report note for the run");
  else if (job !== undefined && job.report_note_id !== scalarOf(report.text, "id")) {
    problems.push("the store's report is not the report of the run");
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 07-UAT item 4: a source entry and its reference

const SOURCE_TERMS = [
  RESEARCH_TEXT.fieldType,
  RESEARCH_TEXT.fieldAccess,
  RESEARCH_TEXT.fieldAddress,
  RESEARCH_TEXT.fieldAuthor,
  RESEARCH_TEXT.fieldPublished,
  RESEARCH_TEXT.fieldRetrieved,
  RESEARCH_TEXT.fieldContentHash,
  RESEARCH_TEXT.fieldStableId,
  RESEARCH_TEXT.fieldSnapshot,
  RESEARCH_TEXT.removedBeforeSummarising,
];

/**
 * A source entry of the reader shows every PRD 10.1 field in the contracted order, with the
 * values the report note's reference carries (`ref` is one `sourceRefs` entry of the note).
 */
export function checkSourceEntry(
  source: RenderedSource,
  ref: Readonly<Record<string, string>>,
): string[] {
  if (source.fields.map((entry) => entry.term).join("|") !== SOURCE_TERMS.join("|")) {
    return ["the fields are not the contracted ones in order"];
  }
  const problems: string[] = [];
  const of = (term: string) => source.fields.find((entry) => entry.term === term);
  const type = SOURCE_TYPE_DISPLAY[ref.sourceType as keyof typeof SOURCE_TYPE_DISPLAY];
  if (of(RESEARCH_TEXT.fieldType)?.text !== type) {
    problems.push(`Type is ${of(RESEARCH_TEXT.fieldType)?.text}, not ${type}`);
  }
  const access = ACCESS_CLASS_DISPLAY[ref.accessClass as keyof typeof ACCESS_CLASS_DISPLAY];
  if (of(RESEARCH_TEXT.fieldAccess)?.text !== `${access.label} ${access.explanation}`) {
    problems.push(`Access does not read ${access.label} with its explanation`);
  }
  const address = of(RESEARCH_TEXT.fieldAddress);
  if (address?.text !== (ref.canonicalUrl ?? ref.deepLink)) {
    problems.push("Address is not the canonical address");
  }
  if (!address?.buttons.includes(RESEARCH_TEXT.copyAddressLabel)) {
    problems.push("Address has no Copy address");
  }
  const noAuthor = ref.author === undefined || ref.author === "null";
  if (of(RESEARCH_TEXT.fieldAuthor)?.text !== (noAuthor ? RESEARCH_TEXT.notProvided : ref.author)) {
    problems.push("Author is not the recorded author");
  }
  const published = of(RESEARCH_TEXT.fieldPublished)?.text ?? "";
  const noDate = ref.publishedAt === undefined || ref.publishedAt === "null";
  if (noDate ? published !== RESEARCH_TEXT.notProvided : !/\d/.test(published)) {
    problems.push("Published is not the recorded date");
  }
  const retrieved = of(RESEARCH_TEXT.fieldRetrieved)?.text ?? "";
  if (!/\d/.test(retrieved)) problems.push("Retrieved is not a time");
  const hash = of(RESEARCH_TEXT.fieldContentHash);
  if (hash?.text !== ref.contentHash?.slice(0, 12)) {
    problems.push("Content hash does not start with the recorded hash");
  }
  if (!hash?.titles.includes(ref.contentHash ?? "-")) {
    problems.push("Content hash does not carry the full hash");
  }
  if (of(RESEARCH_TEXT.fieldStableId)?.text !== ref.id)
    problems.push("Stable ID is not the source id");
  const snapshot = of(RESEARCH_TEXT.fieldSnapshot);
  if (snapshot?.text !== ref.snapshotPath) problems.push("Snapshot is not the snapshot path");
  if (!snapshot?.buttons.includes(RESEARCH_TEXT.openSnapshotLabel)) {
    problems.push("Snapshot has no Open snapshot");
  }
  if ((of(RESEARCH_TEXT.removedBeforeSummarising)?.text ?? "") === "") {
    problems.push("Removed before summarising says nothing");
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 07-UAT item 5: the three kinds, in the view and in the note

/** `2 reported facts · 1 source claim · 0 model inferences`: zero segments are kept. */
export function kindCountsPhrase(counts: Readonly<Record<ReportItemKind, number>>): string {
  const word = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [
    word(counts["source-fact"], "reported fact", "reported facts"),
    word(counts["unverified-claim"], "source claim", "source claims"),
    word(counts.inference, "model inference", "model inferences"),
  ].join(" · ");
}

/**
 * The reader's legend, kind tags and counts match the contracted words and the report note's
 * items and body labels; the extractive summariser makes no model inference (RSRCH-04).
 */
export function checkKindsView(reader: RenderedReader, note: ParsedReportNote): string[] {
  const problems: string[] = [];
  const legendKinds = reader.legend.map((entry) => entry.kind);
  if (REPORT_ITEM_KINDS.some((kind) => !legendKinds.includes(kind)) || reader.legend.length !== 3) {
    problems.push("the legend does not list all three kinds");
  }
  for (const kind of REPORT_ITEM_KINDS) {
    const display = REPORT_ITEM_KIND_DISPLAY[kind];
    const line = reader.legend.find((entry) => entry.kind === kind);
    if (line === undefined) continue;
    if (line.term !== `${display.glyph} ${display.label}`) {
      problems.push(`the legend line for ${kind} is not the kind's label`);
    }
    if (line.meaning !== display.meaning) {
      problems.push(`the legend meaning for ${kind} is not the contracted one`);
    }
  }
  reader.findings.forEach((entry, index) => {
    const display = REPORT_ITEM_KIND_DISPLAY[entry.kind as ReportItemKind];
    if (display === undefined || entry.tagWord !== display.label) {
      problems.push(
        `finding ${index + 1} shows the tag ${entry.tagWord}, not ${display?.label ?? "a known kind"}`,
      );
    } else if (entry.tag !== `${display.glyph} ${display.label}`) {
      problems.push(`finding ${index + 1} shows the tag ${entry.tag}, not its glyph and word`);
    }
  });
  const viewKinds = reader.findings.map((entry) => entry.kind).join(",");
  if (viewKinds !== note.itemKinds.join(",")) {
    problems.push("the findings' kinds differ from the note's items");
  }
  const counts = { "source-fact": 0, "unverified-claim": 0, inference: 0 };
  for (const kind of note.itemKinds) counts[kind as ReportItemKind] += 1;
  const phrase = kindCountsPhrase(counts);
  if (reader.counts !== phrase) problems.push(`the kind counts are not ${phrase}`);
  if (counts.inference > 0) problems.push("the extractive summariser made a model inference");
  for (const kind of REPORT_ITEM_KINDS) {
    // The legend writes each label once; each finding writes its kind's label once.
    const expected = 1 + counts[kind];
    const actual = note.bodyLabels[kind] ?? 0;
    if (actual !== expected) {
      problems.push(
        `the note body writes the ${REPORT_ITEM_KIND_DISPLAY[kind].label} label ${actual} times, expected ${expected}`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 07-UAT item 6: a partial run

export interface PartialExpectation {
  /** The number of configured sources. */
  readonly total: number;
  readonly unavailable: readonly { readonly label: string; readonly phrase: string }[];
}

function hasPartial(badges: readonly { kind: string; glyph: string; label: string }[]): boolean {
  return badges.some(
    (entry) => entry.kind === "partial" && entry.glyph === "◈" && entry.label === "Partial",
  );
}

/**
 * A partial run (RSRCH-05, DIAG-05): the gaps sentence, the Partial badge in the strip, the row
 * and the reader header, the unavailable sources before the findings, and the success row.
 */
export function checkPartialView(read: RenderedResearch, expected: PartialExpectation): string[] {
  const problems: string[] = [];
  const missing = expected.unavailable.length;
  const line = `${RESEARCH_TEXT.reportReadyGapsPrefix}${missing} of ${expected.total} sources were unavailable.`;
  if (read.status !== line) problems.push(`the status line is not ${line}`);
  if (!hasPartial(read.strip.badges)) problems.push("the strip shows no Partial badge");
  const row = read.list.rows[0];
  if (row === undefined || !hasPartial(row.badges))
    problems.push("the report row shows no Partial badge");
  const reader = read.reader;
  if (reader === null || !hasPartial(reader.metaBadges)) {
    problems.push("the reader header shows no Partial badge");
  }
  const success = read.runStatus.rows.find(
    (entry) => entry.label === RESEARCH_TEXT.lastSuccessLabel,
  );
  const sourcesPhrase = `${expected.total - missing} of ${expected.total} sources`;
  if (
    success === undefined ||
    !success.value.includes("✓ Completed") ||
    !hasPartial(success.badges) ||
    !success.value.includes(sourcesPhrase)
  ) {
    problems.push(
      `Last successful run does not show ✓ Completed, the Partial badge and ${sourcesPhrase}`,
    );
  }
  if (reader !== null) {
    if (reader.unavailable === null) {
      problems.push("the reader has no Unavailable sources notice");
    } else {
      for (const entry of expected.unavailable) {
        const text = `✕ ${entry.label} — ${entry.phrase}`;
        if (!reader.unavailable.entries.includes(text)) {
          problems.push(`the notice does not list ${text}`);
        }
      }
    }
    const notice = reader.headings.indexOf(RESEARCH_TEXT.readerUnavailableHeading);
    const findings = reader.headings.indexOf(RESEARCH_TEXT.readerFindingsHeading);
    if (notice >= 0 && findings >= 0 && notice > findings) {
      problems.push("the unavailable sources come after the findings");
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 07-UAT item 7: every source fails

export interface FailedExpectation {
  /** The reason as the plugin writes it mid-sentence, for example `no source could be fetched`. */
  readonly reason: string;
  /** How many report rows the list must show. */
  readonly reports: number;
}

export function checkFailedView(read: RenderedResearch, expected: FailedExpectation): string[] {
  const problems: string[] = [];
  const line = `${RESEARCH_TEXT.runFailedPrefix}${expected.reason}.`;
  if (read.status !== line) problems.push(`the status line is not ${line}`);
  const failed = read.runStatus.rows.find(
    (entry) => entry.label === RESEARCH_TEXT.lastFailureLabel,
  );
  if (
    failed === undefined ||
    !failed.value.includes("✕ Failed") ||
    !failed.value.includes(expected.reason)
  ) {
    problems.push("Last failed run does not show ✕ Failed with the reason");
  }
  if (read.list.rows.length !== expected.reports) {
    problems.push(`the list shows ${read.list.rows.length} reports, expected ${expected.reports}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 07-UAT items 8 and 22: the summariser is not set up

export function checkUnconfiguredView(read: RenderedResearch): string[] {
  const problems: string[] = [];
  const line = `${RESEARCH_TEXT.runFailedPrefix}${RESEARCH_TEXT.failureUnconfigured}.`;
  if (read.status !== line) problems.push(`the status line is not ${line}`);
  const setup = read.runStatus.setup;
  if (setup === null) {
    problems.push("there is no setup callout");
  } else {
    if (setup.heading !== RESEARCH_TEXT.setupHeading) {
      problems.push(`the setup callout heading is not ${RESEARCH_TEXT.setupHeading}`);
    }
    if (setup.body !== RESEARCH_TEXT.setupBody) {
      problems.push("the setup callout body is not the fixed sentence");
    }
  }
  const failed = read.runStatus.rows.find(
    (entry) => entry.label === RESEARCH_TEXT.lastFailureLabel,
  );
  if (failed === undefined || !failed.value.includes(RESEARCH_TEXT.failureUnconfigured)) {
    problems.push("Last failed run does not give the reason");
  }
  return problems;
}

/** What a run that failed before it fetched anything leaves behind (07-UAT items 8 and 22). */
export interface BeforeFetchEvidence {
  /** The names of the stages in the run's stored stage log, in order. */
  readonly stages: readonly string[];
  /** Research notes the run left in the vault, by folder. */
  readonly rawNotes: number;
  readonly wikiNotes: number;
  readonly reportNotes: number;
  /** Rows the whole store holds in the two provenance tables (a run records one per source written). */
  readonly sourceRecords: number;
  readonly reportRecords: number;
}

/**
 * The proof that a failed run never reached the network (T-07-45), from what it left behind rather
 * than from what the log does not say: a run that stopped before its fetch has no stage past the
 * capture stage (the raw stage is logged only after sources were fetched and written), wrote no
 * raw, wiki or report note and recorded no source or report in the operational store. Nothing a
 * fetch or a summariser call would have produced exists. A search of the log for a host name
 * proves nothing (the log never names one), so none is made.
 */
export function checkNoWorkBeforeFailure(evidence: BeforeFetchEvidence): string[] {
  const problems: string[] = [];
  const past = evidence.stages.filter((stage) => stage !== "capture");
  if (past.length > 0) {
    problems.push(`the stage log went past the capture stage (${past.join(", ")})`);
  }
  if (evidence.rawNotes > 0) problems.push("the run wrote raw source notes");
  if (evidence.wikiNotes > 0) problems.push("the run wrote wiki notes");
  if (evidence.reportNotes > 0) problems.push("the run wrote a report");
  if (evidence.sourceRecords > 0) problems.push("the store holds source records for the run");
  if (evidence.reportRecords > 0) problems.push("the store holds a report record for the run");
  return problems;
}

// ---------------------------------------------------------------------------
// 07-UAT items 9 and 10: hostile content

/**
 * A raw snapshot of a hostile source (RSRCH-08, RSRCH-09): stage `raw`, the banner first, the
 * sanitised text alone inside one fence, none of the strings the corpus entry says must go, and
 * the ones it says must stay.
 */
export function checkHostileRaw(
  raw: ParsedRawNote,
  entry: { readonly forbidden: readonly string[]; readonly keeps: readonly string[] },
): string[] {
  const problems: string[] = [];
  if (raw.stage !== "raw") problems.push(`the note is stage ${raw.stage}, not raw`);
  if (raw.banner !== RAW_BANNER)
    problems.push("the note does not open with the untrusted-content banner");
  if (raw.fenced === null) {
    problems.push("the note has no fenced text");
    return problems;
  }
  if (raw.outside !== "") problems.push("the note has text outside the fence");
  const lowered = raw.fenced.toLowerCase();
  for (const forbidden of entry.forbidden) {
    if (lowered.includes(forbidden.toLowerCase())) {
      problems.push(`the fenced text still holds ${forbidden}`);
    }
  }
  for (const kept of entry.keeps) {
    if (!lowered.includes(kept.toLowerCase())) problems.push(`the fenced text lost ${kept}`);
  }
  return problems;
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * A note rendered in Reading view (research Pitfall 7, R4): nothing loads or runs, no link, frame,
 * script, embed or transclusion exists, the fenced text shows as one code block, and the texts
 * the note should show are visible.
 */
export function checkReadingFacts(
  facts: ReadingViewFacts,
  expected: { readonly fenced?: string; readonly texts?: readonly string[] },
): string[] {
  if (!facts.found) return ["the note did not render in Reading view"];
  const problems: string[] = [];
  if (facts.images > 0) problems.push(`the rendered note loads ${facts.images} image(s)`);
  if (facts.frames > 0) problems.push(`the rendered note holds ${facts.frames} frame(s)`);
  if (facts.scripts > 0) problems.push(`the rendered note holds ${facts.scripts} script(s)`);
  if (facts.embeds > 0) problems.push(`the rendered note holds ${facts.embeds} embed(s)`);
  if (facts.internalEmbeds > 0) {
    problems.push(`the rendered note transcludes ${facts.internalEmbeds} note(s)`);
  }
  if (facts.anchors.length > 0)
    problems.push(`the rendered note holds ${facts.anchors.length} link(s)`);
  if (expected.fenced !== undefined) {
    const want = collapse(expected.fenced);
    if (!facts.codeBlocks.some((block) => collapse(block) === want)) {
      problems.push("no code block holds the fenced text");
    }
  }
  const visible = collapse(facts.text);
  for (const text of expected.texts ?? []) {
    if (!visible.includes(collapse(text))) problems.push(`the rendered text lacks: ${text}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 07-UAT items 15 and 23: the article

const LEADING = 1.6;

/**
 * The reader as an article (RSRCH-10, D-24, UI-SPEC "Article typography"): the prose column is at
 * most 68ch, finding text and quotes are body size and regular weight with the prose leading of
 * 1.6, findings are one large step apart, section headings have the extra-large step above them,
 * and nothing is clamped, ellipsised, hidden or past the reader's edge. Values are computed
 * pixels read from the page, so the tolerance is a pixel.
 */
export function checkArticleFacts(
  facts: ArticleFacts,
  expected: { readonly findings: number },
): string[] {
  if (!facts.found) return ["the report did not render"];
  const problems: string[] = [];
  if (facts.findingCount !== expected.findings) {
    problems.push(`the reader shows ${facts.findingCount} findings, expected ${expected.findings}`);
  }
  if (!(facts.measure68chPx > 0) || Math.abs(facts.maxWidthPx - facts.measure68chPx) > 1) {
    problems.push("the reader's maximum width is not 68ch");
  }
  if (facts.articleWidthPx > facts.maxWidthPx + 1)
    problems.push("the prose column is wider than 68ch");
  if (Math.abs(facts.textLeadingPx - LEADING * facts.textFontPx) > 0.6) {
    problems.push("the finding text does not have prose leading of 1.6");
  }
  if (Math.abs(facts.textFontPx - facts.rootFontPx) > 0.5) {
    problems.push("the finding text is not body size");
  }
  if (facts.textWeight !== "400") problems.push("the finding text is not regular weight");
  if (
    facts.quoteLeadingPx > 0 &&
    Math.abs(facts.quoteLeadingPx - LEADING * facts.textFontPx) > 0.6
  ) {
    problems.push("a quote does not have prose leading of 1.6");
  }
  if (!(facts.spaceLgPx > 0) || Math.abs(facts.itemGapPx - facts.spaceLgPx) > 1) {
    problems.push("findings are not separated by the large spacing step");
  }
  if (facts.headingMarginTopPx.length < 2) {
    problems.push("fewer than two section headings were measured");
  } else if (
    !(facts.spaceXlPx > 0) ||
    facts.headingMarginTopPx.some((margin) => Math.abs(margin - facts.spaceXlPx) > 1)
  ) {
    problems.push("a section heading is not spaced by the extra-large step");
  }
  if (facts.clamped.length > 0) {
    problems.push(`something is clamped or truncated: ${facts.clamped.join(", ")}`);
  }
  if (facts.overflowX > 1) problems.push("something runs past the reader's edge");
  return problems;
}

// ---------------------------------------------------------------------------
// 07-UAT item 16: the two layouts

/** The grid switches at 48rem. */
const STACK_AT_REM = 48;

function sideways(facts: ResearchLayoutFacts): boolean {
  return facts.overflowRoot > 1 || facts.overflowGrid > 1;
}

/**
 * Width behaviour (UI-SPEC "Width behaviour"): at full width the list sits beside the reader; in a
 * narrow pane an open report replaces the list and offers Back to reports; neither scrolls sideways.
 */
export function checkLayouts(input: {
  readonly wide: ResearchLayoutFacts;
  readonly narrow: ResearchLayoutFacts;
}): string[] {
  const problems: string[] = [];
  const { wide, narrow } = input;
  if (!wide.found) {
    problems.push("full width: the Research layout was not found");
  } else {
    if (wide.gridWidth < STACK_AT_REM * wide.rootFontPx) {
      problems.push("full width: the grid is narrower than 48rem");
    }
    if (wide.mode !== "side") problems.push("full width: the layout is stacked");
    if (wide.list === null || wide.list.display === "none")
      problems.push("full width: the list is not shown");
    if (wide.reader === null || wide.reader.display === "none") {
      problems.push("full width: the reader is not shown");
    }
    if (wide.list !== null && wide.reader !== null && wide.list.display !== "none") {
      if (wide.list.right > wide.reader.left + 1)
        problems.push("full width: the list is not beside the reader");
      if (Math.abs(wide.list.top - wide.reader.top) > 4) {
        problems.push("full width: the list and the reader do not start on the same row");
      }
    }
    if (sideways(wide)) problems.push("full width: the destination scrolls sideways");
  }
  if (!narrow.found) {
    problems.push("narrow pane: the Research layout was not found");
  } else {
    if (narrow.mode !== "stacked") problems.push("narrow pane: the layout is not stacked");
    if (narrow.readerOpen !== "true") problems.push("narrow pane: no report is open");
    if (narrow.gridWidth > STACK_AT_REM * narrow.rootFontPx) {
      problems.push("narrow pane: the grid is wider than 48rem");
    }
    if (narrow.list !== null && narrow.list.display !== "none") {
      problems.push("narrow pane: the open report does not replace the list");
    }
    if (!narrow.backToReportsVisible) problems.push("narrow pane: Back to reports is not shown");
    if (sideways(narrow)) problems.push("narrow pane: the destination scrolls sideways");
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 07-UAT item 17: the keyboard

const isButton = (entry: ResearchFocus): boolean => entry.tag === "button";

/**
 * The Tab walk from Run now to Open run note (UI-SPEC "Interaction and keyboard contract"): the
 * landmarks come in order (Run now, the run status controls, a report row, then the reader's
 * controls), and every button reached shows a focus ring.
 */
export function checkTabOrder(
  records: readonly ResearchFocus[],
  options: {
    readonly sourcesCount: number;
    /** The first record is where a spec put focus with a script (no ring is drawn for that). */
    readonly skipRingOnFirst?: boolean;
  },
): string[] {
  const landmarks: Array<{ label: string; match: (entry: ResearchFocus) => boolean }> = [
    { label: "Run now", match: (entry) => entry.name.startsWith(RESEARCH_TEXT.runNowLabel) },
    { label: "Open report", match: (entry) => entry.name === RESEARCH_TEXT.openReportLabel },
    {
      label: "Show configured sources",
      match: (entry) => entry.name === `${RESEARCH_TEXT.showSourcesPrefix}${options.sourcesCount})`,
    },
    {
      label: "a report row",
      match: (entry) => entry.classes.split(/\s+/).includes(RESEARCH_CLASSES.rowButton),
    },
    {
      label: "Open note",
      match: (entry) => entry.inReader && entry.name === RESEARCH_TEXT.openNoteLabel,
    },
    { label: "a citation", match: (entry) => entry.cite !== null },
    { label: "Copy address", match: (entry) => entry.name === RESEARCH_TEXT.copyAddressLabel },
    { label: "Open snapshot", match: (entry) => entry.name === RESEARCH_TEXT.openSnapshotLabel },
    { label: "Open run note", match: (entry) => entry.name === RESEARCH_TEXT.openRunNoteLabel },
  ];
  const problems: string[] = [];
  const at = landmarks.map((landmark) => records.findIndex(landmark.match));
  landmarks.forEach((landmark, index) => {
    if ((at[index] as number) < 0) {
      problems.push(`focus never reached ${landmark.label}`);
      return;
    }
    for (let earlier = 0; earlier < index; earlier += 1) {
      if ((at[earlier] as number) >= 0 && (at[index] as number) < (at[earlier] as number)) {
        problems.push(
          `${landmark.label} came before ${(landmarks[earlier] as { label: string }).label}`,
        );
        return;
      }
    }
  });
  const reached = options.skipRingOnFirst === true ? records.slice(1) : records;
  for (const entry of reached.filter(isButton)) {
    if (!entry.focusVisible || !focusRingVisible(entry)) {
      problems.push(`${entry.name} shows no focus ring`);
    }
  }
  return problems;
}

/** A citation moves focus to its source entry's heading; Back to finding returns it (UI-SPEC focus rules). */
export function checkCitationRoundTrip(input: {
  readonly cite: ResearchFocus;
  readonly source: ResearchFocus | null;
  readonly next: ResearchFocus | null;
  readonly returned: ResearchFocus | null;
}): string[] {
  const problems: string[] = [];
  const [finding, source] = (input.cite.cite ?? "-").split("-");
  if (input.source === null || input.source.tag !== "h5") {
    problems.push("the citation did not move focus to a source entry");
  } else if (input.source.sourceNumber !== source) {
    problems.push(`focus moved to source ${input.source.sourceNumber}, not source ${source}`);
  }
  if (input.next === null || input.next.name !== `${RESEARCH_TEXT.backToFindingPrefix}${finding}`) {
    problems.push(`the way back to finding ${finding} is not the next stop`);
  }
  if (input.returned === null || input.returned.cite !== input.cite.cite) {
    problems.push("Back to finding did not return focus to the citation");
  }
  return problems;
}

/** Escape in the one-column layout closes the reader and returns focus to the originating row. */
export function checkEscapeToRow(input: {
  readonly readerClosed: boolean;
  readonly focus: ResearchFocus | null;
}): string[] {
  const problems: string[] = [];
  if (!input.readerClosed) problems.push("Escape did not close the reader");
  if (
    input.focus === null ||
    !input.focus.inRow ||
    !input.focus.classes.split(/\s+/).includes(RESEARCH_CLASSES.rowButton)
  ) {
    problems.push("focus did not return to the report row");
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 07-UAT item 18: reduced motion

/**
 * Reduced motion (A11Y-03, UI-SPEC "Motion"): a baseline taken with motion on must show motion
 * (otherwise "all off" below would pass on nothing), the root is in reduced mode, nothing sampled
 * moves, and a scroll to a cited source is instant.
 */
export function checkMotion(input: {
  readonly baseline: readonly MotionSample[];
  readonly reduced: readonly MotionSample[];
  readonly reducedRoot: string | null;
  readonly scrolls: readonly { readonly behavior: string | null }[];
  readonly scrollBehaviours: readonly string[];
}): string[] {
  const problems: string[] = [];
  if (!anyMotionOn(input.baseline)) {
    problems.push("the full-motion baseline shows no motion, so the reduced run proves nothing");
  }
  if (input.reducedRoot !== "reduced")
    problems.push("the command center root is not in reduced motion");
  if (!allMotionOff(input.reduced)) problems.push("something still moves under reduced motion");
  if (input.scrolls.length === 0) problems.push("following a citation scrolled nothing");
  if (input.scrolls.some((entry) => entry.behavior === "smooth")) {
    problems.push("a scroll to a source was smooth");
  }
  if (input.scrollBehaviours.includes("smooth")) {
    problems.push("the reader sits inside a smooth-scrolling container");
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 07-UAT items 12 and 14: the service stops

/** The service is away (UI-SPEC "Destination states"): dimmed, last-good content, Run now aria-disabled with its reason. */
export function checkDisconnectedView(
  read: RenderedResearch,
  expected: { readonly rows: number; readonly findings: number },
): string[] {
  const problems: string[] = [];
  if (!read.dimmed) problems.push("the destination is not dimmed");
  if (!read.runNow.disabled) problems.push("Run now is not aria-disabled");
  if (read.runNow.reason !== RESEARCH_TEXT.disconnectedReason) {
    problems.push("Run now does not give the service-away reason");
  }
  if (
    !read.strip.badges.some(
      (entry) =>
        entry.kind === "unavailable" && entry.glyph === "○" && entry.label === "Unavailable",
    )
  ) {
    problems.push("the strip does not show Unavailable");
  }
  if (read.reader === null) problems.push("the open report is gone");
  else if (read.reader.findings.length !== expected.findings) {
    problems.push(
      `the open report shows ${read.reader.findings.length} findings, expected ${expected.findings}`,
    );
  }
  if (read.list.rows.length !== expected.rows) {
    problems.push(`the list shows ${read.list.rows.length} rows, expected ${expected.rows}`);
  }
  return problems;
}

export function checkReconnectedView(read: RenderedResearch): string[] {
  const problems: string[] = [];
  if (read.dimmed) problems.push("the destination is still dimmed");
  if (read.runNow.disabled) problems.push("Run now is still disabled");
  return problems;
}

/** A run that ended without reporting is an Unknown run, never an invented outcome (DIAG-05). */
export function checkUnknownRun(read: RenderedResearch): string[] {
  const row = read.runStatus.rows.find((entry) => entry.label === RESEARCH_TEXT.unknownRunLabel);
  if (row === undefined) return ["there is no Unknown run row"];
  const stale = RUN_STATE_DISPLAY.stale;
  const word = `${stale.glyph} ${stale.label}`;
  return row.value.includes(word) ? [] : [`the Unknown run row does not read ${word}`];
}

// ---------------------------------------------------------------------------
// 07-UAT item 13: reruns

export interface NotesSnapshot {
  /** The file names in `global/raw`. */
  readonly raw: readonly string[];
  /** The wiki notes: file name, note id and the instant the source was last retrieved. */
  readonly wiki: readonly {
    readonly name: string;
    readonly id: string;
    readonly retrievedAt: string;
  }[];
}

/**
 * Reruns reuse and update in place (RSRCH-02, RSRCH-03): an unchanged rerun adds no raw file and
 * rewrites each wiki note with the same id; a changed source adds exactly one raw file and keeps
 * the earlier ones (the first report's snapshot paths still open).
 */
export function checkReuse(input: {
  readonly first: NotesSnapshot;
  readonly second: NotesSnapshot;
  readonly third: NotesSnapshot;
}): string[] {
  const problems: string[] = [];
  const { first, second, third } = input;
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
  if (!same(first.raw, second.raw)) problems.push("the unchanged rerun added a raw file");
  for (const note of first.wiki) {
    const again = second.wiki.find((entry) => entry.name === note.name);
    if (again === undefined || again.id !== note.id) {
      problems.push("a wiki note changed its id on the unchanged rerun");
    } else if (again.retrievedAt === note.retrievedAt) {
      problems.push("a wiki note was not rewritten on the unchanged rerun");
    }
  }
  if (third.raw.length !== first.raw.length + 1) {
    problems.push("the changed source did not add exactly one raw file");
  }
  if (first.raw.some((name) => !third.raw.includes(name))) {
    problems.push("an earlier raw file disappeared");
  }
  for (const note of first.wiki) {
    const later = third.wiki.find((entry) => entry.name === note.name);
    if (later === undefined || later.id !== note.id) {
      problems.push("a wiki note changed its id after the changed source");
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 07-UAT item 20: the Overview

/** What `checkOverviewCards` reads of a card (an `OverviewCard` of overview-support.ts satisfies it). */
export interface OverviewCardFacts {
  readonly title: string;
  readonly presentation: string | null;
  readonly note: string | null;
  readonly intel: { readonly title: string } | null;
  readonly footer: {
    readonly freshness: string | null;
    readonly freshnessLabel: string | null;
    readonly partial: string | null;
  };
}

/**
 * The Overview after Phase 8 (item 20 as amended by SLICE-01, D-19, D-20, D-47). Phase 7 first
 * asserted that the Overview was unchanged: Today the permission-required card, technology and
 * market intelligence unavailable. Both cards are live now. Today is service-fed (ready, stale or
 * empty), carries the Partial badge and the note that Google Calendar and Gmail are not part of
 * this version; after the long report's run the technology card is ready with the latest report
 * and shows it as Cached, never Live. Returns what is wrong; an empty list is a pass.
 */
export function checkOverviewCards(cards: readonly OverviewCardFacts[]): string[] {
  const problems: string[] = [];
  const today = cards.find((card) => card.title === RESEARCH_TEXT.todayTitle);
  if (today === undefined) problems.push("there is no Today card");
  else {
    if (today.presentation === "permission-required") {
      problems.push("the Today card is permission-required, not service-fed");
    } else if (!["ready", "stale", "empty"].includes(today.presentation ?? "")) {
      problems.push(`the Today card is ${today.presentation ?? "unreadable"}, not ready`);
    }
    if (today.note === null || !today.note.includes(RESEARCH_TEXT.todaySource)) {
      problems.push(
        "the Today card does not carry the note that Google Calendar and Gmail are not part of this version",
      );
    }
    if (
      today.footer.partial === null ||
      !today.footer.partial.includes(RESEARCH_TEXT.partialLabel)
    ) {
      problems.push(`the Today card does not carry the ${RESEARCH_TEXT.partialLabel} badge`);
    }
  }
  const intel = cards.find((card) => card.title === RESEARCH_TEXT.techIntelTitle);
  if (intel === undefined) problems.push("there is no technology and market intelligence card");
  else if (intel.presentation !== "ready") {
    problems.push(
      `the technology and market intelligence card is ${intel.presentation ?? "unreadable"}, not ready with the latest report`,
    );
  } else {
    if (intel.intel === null) {
      problems.push("the technology and market intelligence card shows no report");
    }
    if (intel.footer.freshness !== "cached") {
      problems.push(
        `the technology and market intelligence card freshness is ${intel.footer.freshnessLabel ?? "missing"}, not ${RESEARCH_TEXT.cachedLabel}`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 07-UAT item 21: logs and settings

const ADDRESS = /https?:\/\/[^\s"']+/;
const ADDRESS_WITH_QUERY = /https?:\/\/[^\s"']+\?[^\s"']+/;
const KEY_SHAPED = /sk-[A-Za-z0-9_-]{16,}/;
const REMOTE_ERROR =
  /ECONN\w*|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|certificate|HTTP\/\d|status code \d{3}/i;

/**
 * Only codes, ids and counts reach a log or the settings file (ADR-0017, PRIV-04): no source
 * text, no address (and none with a query), no key-shaped string and no remote error text. An
 * empty text proves nothing and is refused.
 */
export function checkLogPrivacy(
  texts: readonly { readonly label: string; readonly text: string }[],
  markers: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const { label, text } of texts) {
    if (text.trim() === "") {
      problems.push(`${label} is empty, so there is nothing to check`);
      continue;
    }
    for (const marker of markers) {
      if (text.includes(marker)) problems.push(`${label} holds source text (${marker})`);
    }
    if (ADDRESS_WITH_QUERY.test(text))
      problems.push(`${label} holds an address with a query string`);
    if (ADDRESS.test(text)) problems.push(`${label} holds an address`);
    if (KEY_SHAPED.test(text)) problems.push(`${label} holds a key-shaped string`);
    if (REMOTE_ERROR.test(text)) problems.push(`${label} holds remote error text`);
  }
  return problems;
}
