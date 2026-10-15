// Text helpers shared by the HTML sanitiser and the feed fields. Pure string work: no parser, no
// I/O. Nothing here interprets markup, so it can run on text that is already sanitised.

/**
 * Control, format, line-separator, paragraph-separator and lone-surrogate characters. Tab, line
 * feed and carriage return are whitespace, not removals. The category escapes keep this source
 * file free of raw invisible characters.
 */
const UNSAFE_CHARS = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;

/**
 * Invisible characters outside the control/format categories that still split a token without
 * showing: combining grapheme joiner, variation selectors, Hangul fillers and the blank braille
 * cell. Removed from the view the delimiter scrub checks (and from what it wraps).
 */
const FILLER_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x034f, 0x034f],
  [0xfe00, 0xfe0f],
  [0x115f, 0x1160],
  [0x3164, 0x3164],
  [0xffa0, 0xffa0],
  [0x2800, 0x2800],
];
const FILLER_CHARS = new RegExp(
  `[${FILLER_RANGES.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join("")}]`,
  "g",
);

/** Removes the filler characters above. */
export function stripFillerChars(text: string): string {
  return text.replace(FILLER_CHARS, "");
}

export interface StrippedText {
  readonly text: string;
  readonly removed: number;
}

/** Removes the characters that can hide or reorder text (bidi, zero-width, controls) and counts them. */
export function stripUnsafeChars(text: string): StrippedText {
  let removed = 0;
  const stripped = text.replace(UNSAFE_CHARS, () => {
    removed += 1;
    return "";
  });
  return { text: stripped, removed };
}

/** Cuts to at most `max` UTF-16 units without leaving half of a surrogate pair. */
export function truncateAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Collapses every whitespace run, newlines included, to one space. */
export function collapseToOneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Collapses horizontal whitespace per line, trims each line and drops blank lines. */
export function collapseLines(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

const COMMAND_PATTERNS: readonly RegExp[] = [
  /^\$\s+\S/,
  /^sudo\s+\S/,
  /^(?:curl|wget)\s+\S/,
  /\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b/,
  /\brm\s+-[A-Za-z]*[rRfF]/,
  /`\s*(?:sudo|rm|curl|wget|bash|sh|chmod|nc|python3?|node)\s/,
  /\$\(\s*(?:curl|wget|sudo|rm|bash|sh|nc)\b/,
];

/** A line that reads like a shell command. Such lines are kept as text and only counted. */
export function isCommandLikeLine(line: string): boolean {
  const trimmed = line.trim();
  return COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function countCommandLikeLines(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (isCommandLikeLine(line)) count += 1;
  }
  return count;
}

/** What a delimiter-like token becomes. It contains no angle bracket, so it cannot re-form one. */
export const MARKER_REPLACEMENT = "[delimiter removed]";

// "<<<" then SRC or END, with any whitespace between the brackets and the word. The text is folded
// to NFKC first so fullwidth and compatibility forms read as the plain characters.
// The words may be spelled with whitespace between their letters (`E N D`).
const DELIMITER_TOKEN = /<\s*<\s*<\s*(?:s\s*r\s*c|e\s*n\s*d)/gi;

export interface NeutralisedText {
  readonly text: string;
  readonly count: number;
}

/**
 * Replaces delimiter openers and closers with a fixed visible marker. Callers pass text whose
 * zero-width and bidi characters are already stripped. The result is NFKC, so what is returned is
 * what was checked.
 */
export function neutraliseDelimiterTokens(text: string): NeutralisedText {
  let current = stripFillerChars(text.normalize("NFKC"));
  let count = 0;
  for (let pass = 0; pass < 8; pass += 1) {
    let found = 0;
    const next = current.replace(DELIMITER_TOKEN, () => {
      found += 1;
      return MARKER_REPLACEMENT;
    });
    if (found === 0) return { text: current, count };
    count += found;
    current = stripFillerChars(next.normalize("NFKC"));
  }
  return { text: current, count };
}
