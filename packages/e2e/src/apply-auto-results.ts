import type { ItemStatus } from "./results.js";
import {
  AUTO_RESULT_PATTERN,
  AUTO_RESULT_STATES,
  parseUatScript,
  RUN_DATE_PATTERN,
  RUN_ID_PATTERN,
  TAG_CODES,
} from "./uat-tags.js";

export interface AutoOutcome {
  readonly item: number;
  readonly status: ItemStatus;
}

export interface ApplyInput {
  readonly text: string;
  readonly outcomes: readonly AutoOutcome[];
  /** Eight lowercase hex characters. */
  readonly runId: string;
  /** An ISO date, YYYY-MM-DD; passed in so the output is deterministic. */
  readonly date: string;
}

const MESSAGES = {
  form: "The run id or date is not in the expected form.",
  noItem: "The script has no item for an automated outcome.",
  owner: "An automated outcome cannot be written on an owner item.",
  status: "The outcome status is not an allowed auto-result state.",
  noSpec: "The item has no spec line to place its auto-result after.",
  duplicate: "The script lists an automated item more than once.",
} as const;

const SUMMARY_KEYS = ["auto-passed", "auto-failed", "owner-pending"] as const;

/** Counts only auto-results written by `runId`: an older run's line proves nothing about this one. */
function countSummary(text: string, runId: string): Record<(typeof SUMMARY_KEYS)[number], number> {
  const { items } = parseUatScript(text);
  let passed = 0;
  let failed = 0;
  let ownerPending = 0;
  for (const item of items) {
    if (item.runClass === "owner") {
      if (item.resultValue === null || item.resultValue.startsWith("[pending]")) ownerPending += 1;
      continue;
    }
    const match = item.autoResult === null ? null : AUTO_RESULT_PATTERN.exec(item.autoResult);
    if (match === null || match === undefined || match[2] !== runId) continue;
    if (match[1] === "pass") passed += 1;
    if (match[1] === "fail") failed += 1;
  }
  return { "auto-passed": passed, "auto-failed": failed, "owner-pending": ownerPending };
}

/**
 * Writes the runner's outcomes into a UAT script (D-09, D-46, T-05.2-21). Only auto-result lines
 * and the three summary counts change; every other line, including every owner result line, is
 * returned byte for byte. The date comes from the caller, so the output is deterministic.
 */
export function applyAutoResults(input: ApplyInput): string {
  if (!RUN_ID_PATTERN.test(input.runId) || !RUN_DATE_PATTERN.test(input.date)) {
    throw new Error(MESSAGES.form);
  }
  const parsed = parseUatScript(input.text);
  const crlf = input.text.includes("\r\n");
  const eol = crlf ? "\r" : "";
  const repeated = new Set(
    parsed.findings.filter((entry) => entry.code === TAG_CODES.itemDuplicate).map((e) => e.item),
  );
  const replace = new Map<number, string>();
  const insertAfter = new Map<number, string>();

  for (const outcome of input.outcomes) {
    const item = parsed.items.find((entry) => entry.number === outcome.item);
    if (item === undefined) throw new Error(MESSAGES.noItem);
    if (item.runClass === "owner") throw new Error(MESSAGES.owner);
    if (repeated.has(outcome.item)) throw new Error(MESSAGES.duplicate);
    if (outcome.status === "skipped-profile") continue;
    if (!(AUTO_RESULT_STATES as readonly string[]).includes(outcome.status)) {
      throw new Error(MESSAGES.status);
    }
    const line = `auto-result: ${outcome.status} @ ${input.runId} ${input.date}`;
    const existing = item.tagLines["auto-result"];
    if (existing !== undefined) {
      replace.set(existing, line);
      continue;
    }
    const spec = item.tagLines.spec;
    if (spec === undefined) throw new Error(MESSAGES.noSpec);
    insertAfter.set(spec, line);
  }

  const rewritten: string[] = [];
  input.text.split("\n").forEach((line, index) => {
    const replacement = replace.get(index);
    rewritten.push(replacement === undefined ? line : `${replacement}${eol}`);
    const added = insertAfter.get(index);
    if (added !== undefined) rewritten.push(`${added}${eol}`);
  });

  let text = rewritten.join("\n");
  const counts = countSummary(text, input.runId);
  const after = parseUatScript(text);
  const lines = text.split("\n");
  const missing: string[] = [];
  for (const key of SUMMARY_KEYS) {
    const at = after.summaryLines[key];
    if (at === undefined) missing.push(`${key}: ${counts[key]}${eol}`);
    else lines[at] = `${key}: ${counts[key]}${eol}`;
  }
  const keyed = Object.values(after.summaryLines);
  if (missing.length > 0 && keyed.length > 0) lines.splice(Math.max(...keyed) + 1, 0, ...missing);
  text = lines.join("\n");
  return text;
}
