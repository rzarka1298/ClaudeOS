// The deterministic extractive summariser (plan 07-07 Task 3, D-05, D-27, RSRCH-07).
//
// It answers in the summariser contract (one JSON object with an `items` array) from the
// delimited source blocks alone, so CI and automated UAT run the whole pipeline with no model and
// no network. It reads no clock and no random value: the same input gives the same string.
//
// Per source, in block order, it emits at most two items:
//
//   - a source-fact: the first sentence of the block text, quoted verbatim;
//   - an unverified-claim: the first line (the entry title), quoted verbatim.
//
// A quote must be able to verify (the domain minimums, whole-word edges, no address, no invisible
// character), so a short sentence or title is extended with the text that follows it until it
// can, and cut at a word boundary at the quote cap. Every candidate is run through the trusted
// stage on its own and kept only when it comes back with its kind and its quote unchanged, so
// the answer never contains an item that would be downgraded, and no inference is ever made. A
// source that cannot yield a verifiable quote yields no item. The text of a source is data: it is
// copied into JSON strings and never interpreted.
//
// Pure: no I/O, no clock, no node module.

import {
  REPORT_ITEM_QUOTE_MAX_LENGTH,
  REPORT_ITEM_QUOTE_MIN_LENGTH,
  REPORT_ITEM_QUOTE_MIN_WORDS,
  REPORT_ITEM_TEXT_MAX_LENGTH,
  REPORT_ITEMS_MAX,
} from "@ccc/domain";
import { validateSummariserOutput } from "./claims.js";
import { parseDelimitedBlocks } from "./delimit.js";
import { cutAtWord } from "./quote-match.js";
import { normaliseForMatch } from "./text-canon.js";

type ExtractedKind = "source-fact" | "unverified-claim";

/** A sentence ends at . ! or ? followed by whitespace or the end, or at a newline. */
const SENTENCE_END = /[.!?]+(?=\s|$)|\n/g;

/** The sentences and lines of a text, each normalised, in order. */
function units(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const pattern = new RegExp(SENTENCE_END.source, SENTENCE_END.flags);
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    const end = m[0] === "\n" ? m.index : m.index + m[0].length;
    const unit = normaliseForMatch(text.slice(start, end));
    if (unit !== "") out.push(unit);
    start = m.index + m[0].length;
  }
  const tail = normaliseForMatch(text.slice(start));
  if (tail !== "") out.push(tail);
  return out;
}

/** The first sentence, extended unit by unit (and then word by word) to the minimum, within the cap. */
function factQuote(normalised: string, parts: readonly string[]): string | null {
  if (parts.length === 0) return null;
  let quote = parts[0] ?? "";
  for (let i = 1; i < parts.length && !longEnough(quote); i += 1) quote = `${quote} ${parts[i]}`;
  return finish(normalised, quote);
}

/** The first line, extended word by word to the minimum, within the cap. */
function claimQuote(normalised: string, firstLine: string): string | null {
  return finish(normalised, firstLine);
}

function longEnough(quote: string): boolean {
  return (
    quote.length >= REPORT_ITEM_QUOTE_MIN_LENGTH &&
    quote.split(" ").length >= REPORT_ITEM_QUOTE_MIN_WORDS
  );
}

/** Extends a prefix of the normalised text to the minimum, cuts it at the cap, checks it is a prefix. */
function finish(normalised: string, start: string): string | null {
  if (!normalised.startsWith(start)) return null;
  let quote = start;
  while (!longEnough(quote) && quote.length < normalised.length) {
    const next = normalised.indexOf(" ", quote.length + 1);
    quote = next === -1 ? normalised : normalised.slice(0, next);
  }
  const cut = cutAtWord(quote, REPORT_ITEM_QUOTE_MAX_LENGTH);
  return cut === "" ? null : cut;
}

interface Candidate {
  readonly kind: ExtractedKind;
  readonly text: string;
  readonly quote: string;
}

function candidates(text: string): Candidate[] {
  const normalised = normaliseForMatch(text);
  if (normalised === "") return [];
  const parts = units(text);
  const firstLine = normaliseForMatch(text.trimStart().split("\n", 1)[0] ?? "");
  const out: Candidate[] = [];
  const fact = factQuote(normalised, parts);
  if (fact !== null) {
    out.push({
      kind: "source-fact",
      text: cutAtWord(parts[0] ?? fact, REPORT_ITEM_TEXT_MAX_LENGTH),
      quote: fact,
    });
  }
  const claim = firstLine === "" ? null : claimQuote(normalised, firstLine);
  if (claim !== null) {
    out.push({
      kind: "unverified-claim",
      text: cutAtWord(`Entry: ${firstLine}`, REPORT_ITEM_TEXT_MAX_LENGTH),
      quote: claim,
    });
  }
  return out;
}

function kept(id: string, sourceText: string, candidate: Candidate): boolean {
  const result = validateSummariserOutput(
    JSON.stringify({
      items: [
        {
          kind: candidate.kind,
          text: candidate.text,
          citedSourceIds: [id],
          quote: candidate.quote,
        },
      ],
    }),
    { sources: { [id]: sourceText } },
  );
  if (!result.ok || result.items.length !== 1) return false;
  const item = result.items[0];
  return item?.kind === candidate.kind && item.quote === candidate.quote;
}

export function extractiveSummary(input: string): string {
  const items: { kind: string; text: string; citedSourceIds: string[]; quote: string }[] = [];
  try {
    for (const block of parseDelimitedBlocks(input)) {
      for (const candidate of candidates(block.text)) {
        if (items.length >= REPORT_ITEMS_MAX) break;
        if (!kept(block.sourceId, block.text, candidate)) continue;
        items.push({
          kind: candidate.kind,
          text: candidate.text,
          citedSourceIds: [block.sourceId],
          quote: candidate.quote,
        });
      }
      if (items.length >= REPORT_ITEMS_MAX) break;
    }
  } catch {
    return '{"items":[]}';
  }
  return JSON.stringify({ items });
}
