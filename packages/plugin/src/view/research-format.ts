import { neutraliseUntrustedText } from "@ccc/domain/approval-view.js";
import { formatTaskInstant } from "./tasks-format.js";

/**
 * Number and time formatting for the Research surfaces (UI-SPEC "Number and time
 * formatting", Phase 6 rule): counts through `Intl.NumberFormat("en")` and
 * plurals through `Intl.PluralRules`, never `1 sources`, `1 items` or
 * `1 model inferences`. Pure functions of their arguments.
 */

const NUMBER = new Intl.NumberFormat("en");
const PLURAL = new Intl.PluralRules("en");

/** `1,234`: grouped, never `1234`. */
export function formatCount(count: number): string {
  return NUMBER.format(count);
}

/** `1 source`, `3 sources`: the noun follows the English plural rule. */
export function countOf(count: number, singular: string, plural: string): string {
  return `${formatCount(count)} ${PLURAL.select(count) === "one" ? singular : plural}`;
}

export function sourcesText(count: number): string {
  return countOf(count, "source", "sources");
}

export function itemsText(count: number): string {
  return countOf(count, "item", "items");
}

export function inferencesText(count: number): string {
  return countOf(count, "model inference", "model inferences");
}

/**
 * `Oct 13, 9:02 AM`, with the year added when it is not the current one: an
 * instant on the owner's wall clock (the Phase 6 format, never a slash-separated
 * numeric date). A value that cannot be parsed is returned as given.
 */
export function formatRunTime(iso: string, nowMs: number, zone: string): string {
  return formatTaskInstant(iso, nowMs, zone);
}

/** The most source characters considered, and the output bound: far above any display cap. */
const SAFE_SOURCE_MAX = 20_000;
const SAFE_OUTPUT_MAX = 240_000;
const CONTROL_TOKEN_SPAN = /\[U\+[0-9A-F]{4,6}\]/g;

/**
 * One line of untrusted text made safe to show, whatever the caller did before: every control,
 * format, bidirectional, blank-looking and separator character becomes a visible `[U+XXXX]` token,
 * line breaks become spaces. Text the service already neutralised passes through unchanged (a
 * token is plain ASCII), so this is a second line of defence in the reader, not a second pass over
 * different text: a response that reaches the view without having been neutralised still cannot
 * reorder or hide anything (T-07-40).
 */
export function safeLine(text: string): string {
  return neutraliseUntrustedText(text, { max: SAFE_SOURCE_MAX, maxOutput: SAFE_OUTPUT_MAX }).text;
}

/**
 * {@link safeLine}, then the first `max` UTF-16 code units (the unit the schema caps count in)
 * without cutting a surrogate pair or a visible token in half, and whether anything was left out.
 * The caller says `Text shortened for display.` beside a shortened value.
 */
export function capText(text: string, max: number): { text: string; shortened: boolean } {
  const safe = safeLine(text);
  if (safe.length <= max) return { text: safe, shortened: false };
  let end = max;
  const last = safe.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  for (const token of safe.matchAll(CONTROL_TOKEN_SPAN)) {
    const start = token.index ?? 0;
    if (start < end && end < start + token[0].length) end = start;
  }
  return { text: safe.slice(0, end), shortened: true };
}
