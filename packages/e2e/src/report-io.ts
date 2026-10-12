import { sanitizeText } from "./sanitize.js";
import { RUN_DATE_PATTERN, type RunClass } from "./uat-tags.js";

/**
 * The inverse of renderReport plus the three in-place edits the later commands need (05.2-09):
 * a front-matter note, a look verdict on one row, and the ratification line. Every edit returns
 * the report byte for byte except the lines it names.
 */

const NOTE_KEY = /^[a-z][a-z-]*$/;
const NOTE_VALUE = /^[a-z0-9,. -]{1,120}$/;
const UNRATIFIED = "ratified: pending";
const FRONT_LINE = /^([a-z][a-z-]*): ?(.*)$/;
const ROW = /^\| (\d+) \| (.*) \| (auto\+look|auto|owner) \| ([^|]*) \| (.*) \|$/;
const COUNT_LINE = /^- ([a-z-]+): (\d+)$/;
const PARTIAL_HEADING = /^### Item (\d+): /;
const STATEMENT_MAX = 200;
const NOT_A_REPORT = "The text is not an automated UAT report.";

export interface ParsedReportRow {
  number: number;
  title: string;
  runClass: RunClass;
  status: string;
  note: string;
}

export interface ParsedReport {
  frontMatter: Record<string, string>;
  rows: ParsedReportRow[];
  partials: Array<{ item: number; lines: string[] }>;
  counts: Record<string, number>;
}

/**
 * Inserts one `key: value` line into a freshly rendered report's front matter, just before the
 * unratified marker. The key and value are restricted to fixed-vocabulary characters so a note
 * can never carry script text, a path or a quoted message.
 */
export function addFrontMatterNote(text: string, key: string, value: string): string {
  if (!NOTE_KEY.test(key) || !NOTE_VALUE.test(value)) {
    throw new Error("A report front-matter note must use plain lowercase words.");
  }
  const lines = text.split("\n");
  const at = lines.findIndex((line, index) => line === UNRATIFIED && index < 40);
  if (at < 0) throw new Error("The report has no unratified marker to place the note before.");
  lines.splice(at, 0, `${key}: ${value}`);
  return lines.join("\n");
}

function frontMatterEnd(lines: readonly string[]): number {
  if (lines[0] !== "---") throw new Error(NOT_A_REPORT);
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error(NOT_A_REPORT);
  return end;
}

/** The line range [from, to) under a `## ` heading. */
function section(lines: readonly string[], heading: string): [number, number] {
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(NOT_A_REPORT);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if ((lines[index] as string).startsWith("## ")) {
      end = index;
      break;
    }
  }
  return [start + 1, end];
}

export function parseReport(text: string): ParsedReport {
  const lines = text.split("\n");
  const frontEnd = frontMatterEnd(lines);
  const frontMatter: Record<string, string> = {};
  for (let index = 1; index < frontEnd; index += 1) {
    const match = FRONT_LINE.exec(lines[index] as string);
    if (match !== null && frontMatter[match[1] as string] === undefined) {
      frontMatter[match[1] as string] = (match[2] as string).trim();
    }
  }
  const counts: Record<string, number> = {};
  const [countsFrom, countsTo] = section(lines, "## Counts");
  for (let index = countsFrom; index < countsTo; index += 1) {
    const match = COUNT_LINE.exec(lines[index] as string);
    if (match !== null) counts[match[1] as string] = Number(match[2]);
  }
  const rows: ParsedReportRow[] = [];
  const [rowsFrom, rowsTo] = section(lines, "## Items");
  for (let index = rowsFrom; index < rowsTo; index += 1) {
    const match = ROW.exec(lines[index] as string);
    if (match === null) continue;
    rows.push({
      number: Number(match[1]),
      title: match[2] as string,
      runClass: match[3] as RunClass,
      status: (match[4] as string).trim(),
      note: match[5] as string,
    });
  }
  const partials: ParsedReport["partials"] = [];
  const [partsFrom, partsTo] = section(lines, "## Owner partials");
  for (let index = partsFrom; index < partsTo; index += 1) {
    const line = lines[index] as string;
    const heading = PARTIAL_HEADING.exec(line);
    if (heading !== null) partials.push({ item: Number(heading[1]), lines: [] });
    else if (line.startsWith("- ")) partials.at(-1)?.lines.push(line);
  }
  return { frontMatter, rows, partials, counts };
}

/**
 * Sets one automated row to pass or fail and refreshes the two automated counts (D-11). Every
 * other line is returned byte for byte; an owner row or an unknown item is refused.
 */
export function updateReportOutcome(
  text: string,
  item: number,
  status: "pass" | "fail",
  note: string,
): string {
  if (/[\r\n]/.test(note)) throw new Error("A report note must be a single line.");
  const lines = text.split("\n");
  const [rowsFrom, rowsTo] = section(lines, "## Items");
  let found = false;
  for (let index = rowsFrom; index < rowsTo; index += 1) {
    const match = ROW.exec(lines[index] as string);
    if (match === null || Number(match[1]) !== item) continue;
    if (match[3] === "owner") throw new Error("An owner row has no automated outcome.");
    lines[index] =
      `| ${match[1]} | ${match[2]} | ${match[3]} | ${status} | ${note.replace(/\|/g, "\\|")} |`;
    found = true;
    break;
  }
  if (!found) throw new Error("The report has no row for that item.");

  const rows = parseReport(lines.join("\n")).rows.filter((row) => row.runClass !== "owner");
  const tally = (value: string): number => rows.filter((row) => row.status === value).length;
  const [countsFrom, countsTo] = section(lines, "## Counts");
  for (let index = countsFrom; index < countsTo; index += 1) {
    const line = lines[index] as string;
    if (line.startsWith("- auto-passed: ")) lines[index] = `- auto-passed: ${tally("pass")}`;
    if (line.startsWith("- auto-failed: ")) lines[index] = `- auto-failed: ${tally("fail")}`;
  }
  return lines.join("\n");
}

/** Writes the owner's one-line statement into the front matter; nothing else changes. */
export function setRatified(text: string, statement: string, date: string): string {
  const trimmed = statement.trim();
  if (
    trimmed === "" ||
    trimmed.length > STATEMENT_MAX ||
    Array.from(trimmed).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new Error("The ratification statement must be one plain line of at most 200 characters.");
  }
  if (!RUN_DATE_PATTERN.test(date)) throw new Error("The ratification date must be YYYY-MM-DD.");
  const clean = sanitizeText(trimmed, { maxLength: STATEMENT_MAX });
  if (clean === "") throw new Error("The ratification statement is empty after cleaning.");
  const lines = text.split("\n");
  const end = frontMatterEnd(lines);
  const at = lines.findIndex((line, index) => index < end && line === UNRATIFIED);
  if (at < 0) throw new Error("The report is already ratified or has no unratified marker.");
  lines[at] = `ratified: ${clean} (${date})`;
  return lines.join("\n");
}
