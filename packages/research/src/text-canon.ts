// The canonical content-hash input (research Pattern 4). Hashing itself stays in the service so
// this package has no crypto: it only fixes the string that is hashed, so a hash can be
// recomputed from a raw note body.
//
// Canonical form: NFC, CRLF and lone CR to LF, trailing whitespace trimmed on every line, and
// exactly one trailing newline. The function is idempotent.

/** Drops the whitespace at the end of a line, scanning back from the end (no backtracking). */
function trimLineEnd(line: string): string {
  let end = line.length;
  while (end > 0 && /\s/.test(line.charAt(end - 1))) end -= 1;
  return line.slice(0, end);
}

export function canonicalHashInput(text: string): string {
  const lines = text.normalize("NFC").replace(/\r\n?/g, "\n").split("\n").map(trimLineEnd);
  const joined = lines.join("\n");
  let end = joined.length;
  while (end > 0 && joined.charCodeAt(end - 1) === 10) end -= 1;
  return `${joined.slice(0, end)}\n`;
}

// The whitespace the comparison form folds: the ASCII whitespace controls, NEL, and the Unicode
// space, line and paragraph separators. It is spelled out because the regex class \s also matches
// the byte order mark (a zero-width format character) and omits NEL, and a quote check must not
// treat an invisible character as a space.
const MATCH_WHITESPACE =
  /[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;

/**
 * The shared comparison form for the quote check and the text neutraliser (plan 07-07): NFC,
 * every whitespace run (newlines and tabs included) collapsed to one space, ends trimmed. It
 * changes no wording, case or punctuation and folds no zero-width, format or look-alike
 * character, so two strings that agree after it differ at most in whitespace and in
 * normalisation form. Idempotent.
 */
export function normaliseForMatch(text: string): string {
  const collapsed = text.normalize("NFC").replace(MATCH_WHITESPACE, " ");
  const start = collapsed.startsWith(" ") ? 1 : 0;
  const end =
    collapsed.length > start && collapsed.endsWith(" ") ? collapsed.length - 1 : collapsed.length;
  return collapsed.slice(start, end);
}
