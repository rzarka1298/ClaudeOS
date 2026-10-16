import {
  ACCESS_CLASS_DISPLAY,
  REPORT_ITEM_KIND_DISPLAY,
  REPORT_ITEM_KINDS,
  type ReportItemKind,
  SOURCE_TYPE_DISPLAY,
} from "@ccc/domain";
import { RAW_BANNER, RESEARCH_TEXT } from "./research-copy.js";
import type {
  ReadingViewFacts,
  RenderedReader,
  RenderedResearch,
  RenderedRow,
  RenderedSource,
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
import { RESEARCH_UAT_TOPIC } from "../research-uat-fixture.js";

/**
 * Pure verdicts over what the Research destination showed (plan 07-17). Each returns the list of
 * problems found, in plain words, and the empty list when the item's expectation holds; a spec
 * asserts `toEqual([])`, so a failure names what was missing instead of "expected false to be
 * true". Nothing here reads a clock or a file.
 */

// ---------------------------------------------------------------------------
// 07-UAT item 2: the run as it happens

const RUNNING_WORD = "▸ Running";

/** The closed set of stage words the Current run row may read (the plugin's STAGE_TEXT). */
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
 * Current run row shows `▸ Running` with a stage word from the closed set, the first one being
 * the stage the fixture holds the run in (`Reading the source list`: the row names the last
 * stage the run has logged, and the fetch happens before `raw` is logged), and is gone when the
 * run has ended. A fixture answers in milliseconds after that hold, so the later stage words
 * are shown only if a status fetch lands in between; seeing them is not required.
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
  const words = running.map((entry) => (entry.current ?? "").split(" · ")[1] ?? "");
  if (words.some((word) => !(STAGE_WORDS as readonly string[]).includes(word))) {
    problems.push("the Current run row showed a stage word outside the closed set");
  }
  if (running.length > 0 && words[0] !== RESEARCH_TEXT.stageCapture) {
    problems.push("the Current run row did not first name the held fetch stage");
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
