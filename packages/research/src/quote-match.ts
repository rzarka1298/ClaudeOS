// The one quote-match predicate (plan 07-07, blocker 2, D-15, research Pattern 6).
//
// A quotation counts as found in a source only through `quoteInSource`: both sides are put in the
// shared comparison form (`normaliseForMatch`), the quote must be substantial (the domain minimum
// of characters and of real words, a word being a token with a letter or digit), and it must occur
// with its first and last characters on word boundaries of the source. The trusted stage uses it
// to verify a model's quote and again to re-verify the stored one, and every later stage (the
// vault writer's rendering check, provenance) calls the SAME function on the SAME sanitised source
// text, so no stage can accept a quote another would refuse.
//
// Pure: no I/O, no clock, no node module.

import { REPORT_ITEM_QUOTE_MIN_LENGTH, REPORT_ITEM_QUOTE_MIN_WORDS } from "@ccc/domain";
import { normaliseForMatch } from "./text-canon.js";

const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const WORD_CHARACTER = /[\p{L}\p{N}\p{M}]/u;

/**
 * Long enough, and with enough real words, to verify anything (the minimums live in the domain).
 * The argument is already in the comparison form. A token counts as a word only when it carries a
 * letter or a digit, so a run of punctuation never verifies.
 */
export function isSubstantialQuote(normalised: string): boolean {
  if (normalised.length < REPORT_ITEM_QUOTE_MIN_LENGTH) return false;
  let words = 0;
  for (const token of normalised.split(" ")) {
    if (HAS_LETTER_OR_DIGIT.test(token)) words += 1;
  }
  return words >= REPORT_ITEM_QUOTE_MIN_WORDS;
}

/** Cuts a string in the comparison form at the last word boundary within the limit. */
export function cutAtWord(normalised: string, limit: number): string {
  if (normalised.length <= limit) return normalised;
  const space = normalised.lastIndexOf(" ", limit);
  return space > 0 ? normalised.slice(0, space) : normalised.slice(0, limit);
}

/**
 * The index of the first occurrence of the quote in the source whose edges sit on word
 * boundaries (a quote may not start or stop inside a word, which could drop a negation), or -1.
 * Both arguments are already in the comparison form.
 */
export function findWholeWord(source: string, quote: string): number {
  if (quote === "") return -1;
  const first = quote.charAt(0);
  const last = quote.charAt(quote.length - 1);
  for (let at = source.indexOf(quote); at !== -1; at = source.indexOf(quote, at + 1)) {
    const before = at === 0 ? "" : (Array.from(source.slice(Math.max(0, at - 2), at)).pop() ?? "");
    const after = source.charAt(at + quote.length);
    const startsMidWord =
      before !== "" && WORD_CHARACTER.test(before) && WORD_CHARACTER.test(first);
    const stopsMidWord = after !== "" && WORD_CHARACTER.test(after) && WORD_CHARACTER.test(last);
    if (!startsMidWord && !stopsMidWord) return at;
  }
  return -1;
}

/** `quoteInSource` for text already in the comparison form (the trusted stage caches its sources). */
export function quoteInNormalisedSource(
  normalisedSource: string,
  normalisedQuote: string,
): boolean {
  return (
    isSubstantialQuote(normalisedQuote) && findWholeWord(normalisedSource, normalisedQuote) !== -1
  );
}

/**
 * True when the quote is a substantial, whole-word, verbatim quotation of the source after the
 * shared normalisation. The only definition of "verified" in the pipeline.
 */
export function quoteInSource(sourceText: string, quote: string): boolean {
  return quoteInNormalisedSource(normaliseForMatch(sourceText), normaliseForMatch(quote));
}
