// The canonical content-hash input (research Pattern 4). Hashing itself stays in the service so
// this package has no crypto: it only fixes the string that is hashed, so a hash can be
// recomputed from a raw note body.
//
// Canonical form: NFC, CRLF and lone CR to LF, trailing whitespace trimmed on every line, and
// exactly one trailing newline. The function is idempotent.

export function canonicalHashInput(text: string): string {
  const lines = text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+$/, ""));
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
