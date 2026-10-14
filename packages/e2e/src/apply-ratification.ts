import { AUTO_RESULT_PATTERN, parseUatScript, RUN_ID_PATTERN } from "./uat-tags.js";

/**
 * The Q1 result write (05.2-09, D-09, L-1, T-05.2-33): on ratification, a result line that is
 * still `[pending]` becomes `pass - auto run <run-id>` for an automated item whose auto-result is
 * a pass for that very run. Owner items, recorded results, other run ids, failures and items
 * without an auto-result are never touched, and only the two summary counts that must follow
 * (`passed` and `pending`) change besides the result lines. Pure and idempotent.
 */

const PENDING_RESULT = "result: [pending]";

export interface RatificationWrite {
  text: string;
  /** The item numbers whose result line was written. */
  items: number[];
}

// A CRLF script keeps its endings: compare without the carriage return and write it back.
const stripCr = (line: string): string => line.replace(/\r$/, "");
const endingOf = (line: string): string => (line.endsWith("\r") ? "\r" : "");

const MALFORMED = "The run id is not in the expected form.";
const SUMMARY = "The script summary counts cannot take these results.";

export function applyRatification(script: string, runId: string): RatificationWrite {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(MALFORMED);
  const parsed = parseUatScript(script);
  const lines = script.split("\n");
  const written: number[] = [];

  for (const item of parsed.items) {
    if (item.runClass === "owner" || item.resultLines !== 1 || item.autoResult === null) continue;
    const match = AUTO_RESULT_PATTERN.exec(item.autoResult);
    if (match === null || match[1] !== "pass" || match[2] !== runId) continue;
    for (let index = item.headingLine + 1; index < item.endLine; index += 1) {
      const line = lines[index] as string;
      if (stripCr(line) === PENDING_RESULT) {
        lines[index] = `result: pass - auto run ${runId}${endingOf(line)}`;
        written.push(item.number);
        break;
      }
    }
  }
  if (written.length === 0) return { text: script, items: [] };

  const passedAt = parsed.summaryLines.passed;
  const pendingAt = parsed.summaryLines.pending;
  if (passedAt !== undefined && pendingAt !== undefined) {
    const passed = Number(/^passed: (\d+)$/.exec(stripCr(lines[passedAt] as string))?.[1]);
    const pending = Number(/^pending: (\d+)$/.exec(stripCr(lines[pendingAt] as string))?.[1]);
    if (!Number.isInteger(passed) || !Number.isInteger(pending) || pending < written.length) {
      throw new Error(SUMMARY);
    }
    lines[passedAt] = `passed: ${passed + written.length}${endingOf(lines[passedAt] as string)}`;
    lines[pendingAt] =
      `pending: ${pending - written.length}${endingOf(lines[pendingAt] as string)}`;
  }
  return { text: lines.join("\n"), items: written };
}
