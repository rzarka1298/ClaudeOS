// The deterministic extractive summariser (plan 07-07 Task 3, D-05, D-27, RSRCH-07).
//
// It answers in the summariser contract (one JSON object with an `items` array) from the
// delimited source blocks alone, so CI and automated UAT run the whole pipeline with no model and
// no network. It reads no clock and no random value: the same input gives the same string.
//
// Per source, in block order, it emits at most two items:
//
//   - a source-fact: the first sentence of the first line that can yield a verifying quote,
//     quoted verbatim;
//   - an unverified-claim: the first line (the entry title), quoted verbatim.
//
// A quote must be able to verify (the domain minimums, whole-word edges, no address, no invisible
// character), so a short sentence or title is extended with the text that follows it until it
// can (within its own line: a quote never crosses a line or block boundary), and cut at a word
// boundary at the quote cap. Every candidate is run through the trusted
// stage on its own and kept only when it comes back with its kind and its quote unchanged, so
// the answer never contains an item that would be downgraded, and no inference is ever made. A
// source that cannot yield a verifiable quote yields no item. The text of a source is data: it is
// copied into JSON strings and never interpreted.
//
// Pure: no I/O, no clock, no node module.

import {
  REPORT_ITEM_QUOTE_MAX_LENGTH,
  REPORT_ITEM_TEXT_MAX_LENGTH,
  REPORT_ITEMS_MAX,
} from "@ccc/domain";
import { validateSummariserOutput } from "./claims.js";
import { evidenceText, parseDelimitedBlocks } from "./delimit.js";
import { cutAtWord, isSubstantialQuote } from "./quote-match.js";
import { normaliseForQuoteMatch } from "./text-canon.js";

type ExtractedKind = "source-fact" | "unverified-claim";

/** A sentence ends at . ! or ? followed by whitespace or the end. */
const SENTENCE_END = /[.!?]+(?=\s|$)/g;

/** The sentences of one line, each normalised, in order. */
function units(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  const pattern = new RegExp(SENTENCE_END.source, SENTENCE_END.flags);
  for (let m = pattern.exec(line); m !== null; m = pattern.exec(line)) {
    const end = m.index + m[0].length;
    const unit = normaliseForQuoteMatch(line.slice(start, end));
    if (unit !== "") out.push(unit);
    start = end;
  }
  const tail = normaliseForQuoteMatch(line.slice(start));
  if (tail !== "") out.push(tail);
  return out;
}

/**
 * The first sentence of a line, extended sentence by sentence (and then word by word) within the
 * line to the minimum, within the cap. A quote never crosses a line: the comparison form keeps a
 * line break as a hard boundary.
 */
function factQuote(line: string, parts: readonly string[]): string | null {
  if (parts.length === 0) return null;
  let quote = parts[0] ?? "";
  for (let i = 1; i < parts.length && !isSubstantialQuote(quote); i += 1) {
    quote = `${quote} ${parts[i]}`;
  }
  return finish(line, quote);
}

/** Extends a prefix of the line to the minimum word by word, cuts it at the cap, checks it is a prefix. */
function finish(line: string, start: string): string | null {
  if (!line.startsWith(start)) return null;
  let quote = start;
  while (!isSubstantialQuote(quote) && quote.length < line.length) {
    const next = line.indexOf(" ", quote.length + 1);
    quote = next === -1 ? line : line.slice(0, next);
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
  const lines = normaliseForQuoteMatch(text)
    .split("\n")
    .filter((line) => line !== "");
  const out: Candidate[] = [];
  // A source-fact: the first sentence of the first line that can yield a verifying quote.
  for (const line of lines) {
    const parts = units(line);
    const fact = factQuote(line, parts);
    if (fact === null || !isSubstantialQuote(fact)) continue;
    out.push({
      kind: "source-fact",
      text: cutAtWord(parts[0] ?? fact, REPORT_ITEM_TEXT_MAX_LENGTH),
      quote: fact,
    });
    break;
  }
  // An unverified-claim: the first line (the entry title), when it can verify on its own.
  const firstLine = lines[0];
  const claim = firstLine === undefined ? null : finish(firstLine, firstLine);
  if (firstLine !== undefined && claim !== null) {
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
      // The evidence text (the string the model is shown, idempotent on a scrubbed block) is the
      // one text every quote here is taken from and verified against.
      const evidence = evidenceText(block.text);
      for (const candidate of candidates(evidence)) {
        if (items.length >= REPORT_ITEMS_MAX) break;
        if (!kept(block.sourceId, evidence, candidate)) continue;
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
