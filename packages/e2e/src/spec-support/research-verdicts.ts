import { RESEARCH_TEXT } from "./research-copy.js";
import type { RenderedRow, TranscriptRecord } from "./research-dom.js";

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
