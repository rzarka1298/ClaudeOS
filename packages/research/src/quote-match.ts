// The one quote-match predicate (plan 07-07, blocker 2, D-15, research Pattern 6).
//
// A quotation counts as found in a source only through `quoteInSource`: both sides are put in the
// quote comparison form (`normaliseForQuoteMatch`: a line break stays a hard boundary, so a quote
// never crosses a line or block), the quote must be substantial (the domain minimum
// of characters and of real words, a word being a token with a letter or digit), and it must occur
// with its first and last characters on token boundaries of the source, and hold no control,
// format or bidi character. The trusted stage uses it
// to verify a model's quote and again to re-verify the stored one, and every later stage (provenance, plan 07-14)
// calls the SAME function on the SAME evidence text, so no stage can accept a quote
// another would refuse. The vault writer cannot import this package; the contract that a stored
// quote verifies is upheld upstream, by claims.ts, before anything reaches the writer.
//
// Pure: no I/O, no clock, no node module.

import { REPORT_ITEM_QUOTE_MIN_LENGTH, REPORT_ITEM_QUOTE_MIN_WORDS } from "@ccc/domain";
import { normaliseForQuoteMatch } from "./text-canon.js";

const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
// A token is made of letters, digits and marks, and of the invisible format characters (soft hyphen,
// zero-width space, joiners, word joiner, byte order mark) and connector punctuation that bind or
// hide inside it: a quote edge next to one of them is inside the token.
const WORD_CHARACTER = /[\p{L}\p{N}\p{M}\p{Cf}\p{Pc}]/u;
// What a verifying quote never holds: control, format, line and paragraph separator and surrogate
// characters (bidi controls and zero-width characters among them) and a line break.
const NEVER_IN_A_QUOTE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

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

/**
 * Cuts a string in the comparison form at the last word boundary within the limit. Never splits
 * a surrogate pair. Callers that must not lose a trailing qualifier do not cut at all (the
 * trusted stage downgrades an over-cap quote instead of storing a prefix of it).
 */
export function cutAtWord(normalised: string, limit: number): string {
  if (normalised.length <= limit) return normalised;
  const space = normalised.lastIndexOf(" ", limit);
  if (space > 0) return normalised.slice(0, space);
  let end = limit;
  if (isHighSurrogate(normalised.charCodeAt(end - 1))) end -= 1;
  return normalised.slice(0, Math.max(0, end));
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The whole code point that ends at `index` (exclusive), or "" at the start. */
function codePointBefore(text: string, index: number): string {
  if (index <= 0) return "";
  if (index >= 2 && isLowSurrogate(text.charCodeAt(index - 1))) {
    if (isHighSurrogate(text.charCodeAt(index - 2))) return text.slice(index - 2, index);
  }
  return text.charAt(index - 1);
}

/** The whole code point that starts at `index`, or "" at the end. */
function codePointAfter(text: string, index: number): string {
  if (index >= text.length) return "";
  const code = text.codePointAt(index);
  return code === undefined ? "" : String.fromCodePoint(code);
}

const JOINERS: ReadonlySet<string> = new Set(["'", "\u2019", "-", "\u2010", ".", ","]);
const SIGNS: ReadonlySet<string> = new Set(["-", "\u2212", "+"]);
const DIGIT = /\p{N}/u;

function isWord(codePoint: string): boolean {
  return codePoint !== "" && WORD_CHARACTER.test(codePoint);
}

/**
 * True when a cut between the code point `before` and the code point `after` falls inside one
 * token: between two word characters; across an apostrophe, hyphen, period or comma that joins two
 * word characters (won't, non-compliant, 2.4.1, 1,000); or between a sign and the digit it
 * belongs to (-40). `beforeBefore` and `afterAfter` are the code points one further out.
 */
function cutsToken(
  beforeBefore: string,
  before: string,
  after: string,
  afterAfter: string,
): boolean {
  if (isWord(before) && isWord(after)) return true;
  if (isWord(before) && JOINERS.has(after) && isWord(afterAfter)) return true;
  if (JOINERS.has(before) && isWord(beforeBefore) && isWord(after)) return true;
  if (SIGNS.has(before) && DIGIT.test(after)) return true;
  return false;
}

/**
 * The index of the first occurrence of the quote in the source whose edges sit on token
 * boundaries (a quote may not start or stop inside a token, which could drop a negation or a
 * sign), or -1. Code-point aware: a surrogate pair is never split. Both arguments are already in
 * the comparison form.
 */
export function findWholeWord(source: string, quote: string): number {
  if (quote === "") return -1;
  for (let at = source.indexOf(quote); at !== -1; at = source.indexOf(quote, at + 1)) {
    const end = at + quote.length;
    if (isLowSurrogate(source.charCodeAt(at)) && isHighSurrogate(source.charCodeAt(at - 1)))
      continue;
    if (isHighSurrogate(source.charCodeAt(end - 1)) && isLowSurrogate(source.charCodeAt(end)))
      continue;
    const beforeCp = codePointBefore(source, at);
    const firstCp = codePointAfter(quote, 0);
    const startsInside = cutsToken(
      codePointBefore(source, at - beforeCp.length),
      beforeCp,
      firstCp,
      codePointAfter(quote, firstCp.length),
    );
    const lastCp = codePointBefore(quote, quote.length);
    const afterCp = codePointAfter(source, end);
    const stopsInside = cutsToken(
      codePointBefore(quote, quote.length - lastCp.length),
      lastCp,
      afterCp,
      codePointAfter(source, end + afterCp.length),
    );
    if (!startsInside && !stopsInside) return at;
  }
  return -1;
}

/** `quoteInSource` for text already in the comparison form (the trusted stage caches its sources). */
export function quoteInNormalisedSource(
  normalisedSource: string,
  normalisedQuote: string,
): boolean {
  return (
    isSubstantialQuote(normalisedQuote) &&
    !NEVER_IN_A_QUOTE.test(normalisedQuote) &&
    findWholeWord(normalisedSource, normalisedQuote) !== -1
  );
}

/**
 * True when the quote is a substantial, whole-word, verbatim quotation of the source after the
 * shared normalisation. The only definition of "verified" in the pipeline.
 */
export function quoteInSource(sourceText: string, quote: string): boolean {
  return quoteInNormalisedSource(normaliseForQuoteMatch(sourceText), normaliseForQuoteMatch(quote));
}
