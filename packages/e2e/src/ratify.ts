import { type ParsedReport, parseReport, setRatified } from "./report-io.js";
import { isRunCurrent } from "./staleness.js";

/**
 * Ratification (05.2-09, D-09, D-10, L-1, E2E-08, T-05.2-34): a run becomes the pass for its
 * items only when the orchestrator ratifies it with the owner's one-line statement, and only when
 * the run is for the requested id, was made on a clean tree, is still current, has no failed,
 * unfinished or look-pending automated item and recorded no version mismatch. `run` never calls
 * this; reasons are fixed sentences with counts and item numbers, never report or script text.
 */

const REQUIRED_FIELDS = ["run-id", "profile", "git-head", "git-clean", "build-hash", "ratified"];

export interface RatifyInput {
  runId: string;
  statement: string;
  /** An ISO date, YYYY-MM-DD. */
  date: string;
  currentHead: string;
  /** Files changed since the run's HEAD, or null when they could not be listed. */
  changedFiles: string[] | null;
  /** Whether the tracked files match HEAD now; false or unknown refuses (Wave 2 MEDIUM-4). */
  currentClean: boolean | undefined;
}

export type RatifyResult = { ok: true; text: string } | { ok: false; reasons: string[] };

/** The report records the flag as text; only the exact words count, anything else is unknown. */
function cleanFlag(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function itemList(numbers: readonly number[]): string {
  return numbers.join(", ");
}

export function checkRatifiable(input: {
  report: ParsedReport;
  runId: string;
  currentHead: string;
  changedFiles: string[] | null;
  currentClean: boolean | undefined;
}): string[] {
  const { report } = input;
  const front = report.frontMatter;
  const reasons: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    if (front[field] === undefined || front[field] === "") {
      reasons.push(`the report front matter is missing ${field}`);
    }
  }
  if (front["run-id"] !== undefined && front["run-id"] !== input.runId) {
    reasons.push("the report is not for the requested run id");
  }
  if (front.ratified !== undefined && front.ratified !== "pending") {
    reasons.push("the report is already ratified");
  }
  if (front["git-clean"] !== undefined && front["git-clean"] !== "true") {
    reasons.push("the run was made on a dirty tree");
  }
  if (front["version-mismatch"] !== undefined) {
    reasons.push("the run recorded a version mismatch");
  }
  if (front["run-problems"] !== undefined) {
    reasons.push("the run recorded problems (wdio failure, leak or cleanup error)");
  }
  if (front["item-mapping"] === "unavailable") {
    reasons.push("the run has no item mapping to a UAT script");
  }
  if (front["git-head"] !== undefined && front["git-head"] !== "") {
    const staleness = isRunCurrent({
      recordedHead: front["git-head"],
      currentHead: input.currentHead,
      changedFiles: input.changedFiles,
      recordedClean: cleanFlag(front["git-clean"]),
      currentClean: input.currentClean,
    });
    if (!staleness.current) {
      const files =
        staleness.files.length > 0 ? ` (${staleness.files.length} product file(s))` : "";
      reasons.push(`the run is stale: ${staleness.reason}${files}`);
    }
  }

  const automated = report.rows.filter((row) => row.runClass !== "owner");
  const withStatus = (status: string): number[] =>
    automated.filter((row) => row.status === status).map((row) => row.number);
  const failed = withStatus("fail");
  const unfinished = withStatus("inconclusive");
  const looking = withStatus("inconclusive (look pending)");
  const known = new Set([
    "pass",
    "fail",
    "inconclusive",
    "inconclusive (look pending)",
    "skipped-profile",
  ]);
  const unknown = automated.filter((row) => !known.has(row.status)).map((row) => row.number);
  if (failed.length > 0) reasons.push(`item(s) ${itemList(failed)} failed`);
  if (unfinished.length > 0) reasons.push(`item(s) ${itemList(unfinished)} did not finish`);
  if (looking.length > 0) reasons.push(`look still pending for item(s) ${itemList(looking)}`);
  if (unknown.length > 0) reasons.push(`item(s) ${itemList(unknown)} have an unrecognised status`);
  if (withStatus("pass").length === 0) reasons.push("no automated item passed");
  return reasons;
}

/** The ratified report text, or the reasons it cannot be ratified. */
export function ratifyReport(text: string, input: RatifyInput): RatifyResult {
  const reasons = checkRatifiable({
    report: parseReport(text),
    runId: input.runId,
    currentHead: input.currentHead,
    changedFiles: input.changedFiles,
    currentClean: input.currentClean,
  });
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, text: setRatified(text, input.statement, input.date) };
}
