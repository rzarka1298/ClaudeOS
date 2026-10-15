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

/**
 * The shared comparison form for the quote check and the text neutraliser (plan 07-07): NFC,
 * every whitespace run (newlines and tabs included) collapsed to one space, ends trimmed. It
 * changes no wording and no case.
 */
export function normaliseForMatch(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}
