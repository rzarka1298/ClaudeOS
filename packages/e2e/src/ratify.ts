import type { ParsedReport } from "./report-io.js";

export interface RatifyInput {
  runId: string;
  statement: string;
  /** An ISO date, YYYY-MM-DD. */
  date: string;
  currentHead: string;
  /** Files changed since the run's HEAD, or null when they could not be listed. */
  changedFiles: string[] | null;
}

export type RatifyResult = { ok: true; text: string } | { ok: false; reasons: string[] };

export function checkRatifiable(_input: {
  report: ParsedReport;
  runId: string;
  currentHead: string;
  changedFiles: string[] | null;
}): string[] {
  throw new Error("checkRatifiable is not implemented yet (typed skeleton)");
}

export function ratifyReport(_text: string, _input: RatifyInput): RatifyResult {
  throw new Error("ratifyReport is not implemented yet (typed skeleton)");
}
