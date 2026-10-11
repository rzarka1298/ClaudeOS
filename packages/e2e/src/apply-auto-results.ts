import type { ItemStatus } from "./results.js";
import {
  AUTO_RESULT_PATTERN,
  AUTO_RESULT_STATES,
  parseUatScript,
  RUN_DATE_PATTERN,
  RUN_ID_PATTERN,
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
} as const;

const SUMMARY_KEYS = ["auto-passed", "auto-failed", "owner-pending"] as const;

function countSummary(text: string): Record<(typeof SUMMARY_KEYS)[number], number> {
  const { items } = parseUatScript(text);
  let passed = 0;
  let failed = 0;
  let ownerPending = 0;
  for (const item of items) {
    if (item.runClass === "owner") {
      if (item.resultValue === null || item.resultValue.startsWith("[pending]")) ownerPending += 1;
      continue;
    }
    const state = item.autoResult === null ? null : AUTO_RESULT_PATTERN.exec(item.autoResult)?.[1];
    if (state === "pass") passed += 1;
    if (state === "fail") failed += 1;
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
  const replace = new Map<number, string>();
  const insertAfter = new Map<number, string>();

  for (const outcome of input.outcomes) {
    const item = parsed.items.find((entry) => entry.number === outcome.item);
    if (item === undefined) throw new Error(MESSAGES.noItem);
    if (item.runClass === "owner") throw new Error(MESSAGES.owner);
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
    rewritten.push(replace.get(index) ?? line);
    const added = insertAfter.get(index);
    if (added !== undefined) rewritten.push(added);
  });

  let text = rewritten.join("\n");
  const counts = countSummary(text);
  const after = parseUatScript(text);
  const lines = text.split("\n");
  const missing: string[] = [];
  for (const key of SUMMARY_KEYS) {
    const at = after.summaryLines[key];
    if (at === undefined) missing.push(`${key}: ${counts[key]}`);
    else lines[at] = `${key}: ${counts[key]}`;
  }
  const keyed = Object.values(after.summaryLines);
  if (missing.length > 0 && keyed.length > 0) lines.splice(Math.max(...keyed) + 1, 0, ...missing);
  text = lines.join("\n");
  return text;
}
