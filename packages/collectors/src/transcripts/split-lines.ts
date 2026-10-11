/**
 * The byte-exact newline splitter shared by the Claude transcript parser and
 * the Codex rollout parser (plan 05.1-08, D-24). Extracted from
 * `parse.ts` with no behaviour change: lines are split on the `0x0A` byte,
 * only complete lines are decoded, and an over-long line is dropped while the
 * parser skips to its newline so the carry stays bounded.
 */

/**
 * The longest line kept for parsing. A partial line past this is dropped and
 * the rest of it skipped up to its newline (wave 2 review), so a pathological
 * transcript cannot grow the carry without bound. Generous on purpose: a
 * real assistant record carrying a large tool input is well under it.
 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * What one call hands the next: the trailing partial line's bytes, or, while
 * an over-long line is being skipped, no bytes and `skipping: true`.
 */
export interface TranscriptCarry {
  readonly bytes: Uint8Array;
  readonly skipping: boolean;
}

/** The carry of a fresh cursor (offset 0, or a restart at the stored offset). */
export const EMPTY_CARRY: TranscriptCarry = Object.freeze({
  bytes: new Uint8Array(0),
  skipping: false,
});

const decoder = new TextDecoder("utf-8");
const NEWLINE = 0x0a;

function concat(head: Uint8Array, tail: Uint8Array): Uint8Array {
  if (head.length === 0) return tail;
  const joined = new Uint8Array(head.length + tail.length);
  joined.set(head, 0);
  joined.set(tail, head.length);
  return joined;
}

export interface SplitLines {
  readonly lines: readonly string[];
  readonly carry: TranscriptCarry;
  readonly oversized: number;
}

/** Splits `carry + chunk` on newline bytes, dropping over-long lines; decodes complete lines only. */
export function splitLines(chunk: Uint8Array, carry: TranscriptCarry): SplitLines {
  const lines: string[] = [];
  let oversized = 0;
  let prefix = carry.bytes;
  let skipping = carry.skipping;
  let lineStart = 0;
  for (;;) {
    const newline = chunk.indexOf(NEWLINE, lineStart);
    if (newline === -1) break;
    if (skipping) {
      // The over-long line ends here; it was counted when the skip began.
      skipping = false;
    } else if (prefix.length + (newline - lineStart) > MAX_LINE_BYTES) {
      oversized += 1;
    } else {
      lines.push(decoder.decode(concat(prefix, chunk.subarray(lineStart, newline))));
    }
    prefix = EMPTY_CARRY.bytes;
    lineStart = newline + 1;
  }
  if (skipping) return { lines, carry: { bytes: EMPTY_CARRY.bytes, skipping: true }, oversized };
  const tailLength = prefix.length + (chunk.length - lineStart);
  if (tailLength > MAX_LINE_BYTES) {
    return { lines, carry: { bytes: EMPTY_CARRY.bytes, skipping: true }, oversized: oversized + 1 };
  }
  // Copied, so the carry never pins the caller's whole read buffer.
  const bytes = concat(prefix, chunk.slice(lineStart));
  return { lines, carry: { bytes, skipping: false }, oversized };
}
