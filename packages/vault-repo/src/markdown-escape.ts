import { hasDisallowedTextCharacter } from "@ccc/domain";

/**
 * Keeping untrusted text inert in an Obsidian note (plan 07-08; D-06, RSRCH-08, research
 * Pitfall 7, UI-SPEC R4 rule 2).
 *
 * A note body is rendered, so text that came from a fetched page or a model could otherwise fetch
 * a beacon image (`![](https://...)`), transclude a private note (`![[Private]]`), link out, open a
 * callout or comment, or start a fence. Three helpers cover every place untrusted text reaches a
 * body:
 *
 * - {@link escapeMarkdownText}: a span of prose. A backslash goes before EVERY ASCII punctuation
 *   character, which CommonMark guarantees renders that character literally, and every line break
 *   collapses to a space, so one span is always one line;
 * - {@link inlineCode}: an address or a path, inside a code span whose fence is longer than any
 *   backtick run in it. Addresses are shown, never linked;
 * - {@link fenceUntrustedBlock}: a whole snapshot, inside a tilde fence longer than any tilde run
 *   in it. The text stays byte for byte, so its hash can be recomputed from the note.
 *
 * Escaping happens here, at vault-serialisation time, and not earlier: the stored report items
 * and the reader's view model carry plain text (UI-SPEC R4 rule 2). Pure; no I/O.
 */

/** Every ASCII punctuation character CommonMark lets a backslash escape. */
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

/** Whitespace `\s` does not cover, and the one next-line control that reads as a line break. */
const EXTRA_SPACE = new Set(["\u0085"]);

/**
 * Collapses every whitespace run, line break and separator to one space, drops control, format and
 * bidi characters, and trims. The result is one line with no character an editor could hide.
 */
function collapseToOneLine(text: string): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of text) {
    if (/\s/u.test(ch) || EXTRA_SPACE.has(ch)) {
      pendingSpace = true;
      continue;
    }
    if (hasDisallowedTextCharacter(ch)) continue;
    if (pendingSpace && out !== "") out += " ";
    pendingSpace = false;
    out += ch;
  }
  return out;
}

/**
 * Escapes one untrusted span of prose so it renders as the same text and does nothing else.
 *
 * Line breaks and other whitespace collapse to single spaces; control, format and bidi characters
 * are removed; then every ASCII punctuation character gets a backslash. Images, wikilinks, embeds,
 * HTML, autolinks, tags, comments, math, callouts, lists, headings and table pipes all need an
 * unescaped punctuation character, so none can start. Address-like text loses its scheme
 * separators to the same escaping.
 */
export function escapeMarkdownText(text: string): string {
  let out = "";
  for (const ch of collapseToOneLine(text)) {
    out += ASCII_PUNCTUATION.test(ch) ? `\\${ch}` : ch;
  }
  return out;
}

/**
 * Wraps `text` in an inline code span. The fence is one backtick longer than the longest backtick
 * run inside the text, and one space pads each side so a backtick at either end cannot merge with
 * the fence. Line breaks collapse, so the span never leaves its line.
 */
export function inlineCode(text: string): string {
  const line = collapseToOneLine(text);
  let longest = 0;
  let run = 0;
  for (const ch of line) {
    run = ch === "`" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  const fence = "`".repeat(longest + 1);
  return `${fence} ${line} ${fence}`;
}

/** The info string of a fenced snapshot: plain text, never a language a renderer would run. */
export const UNTRUSTED_FENCE_INFO = "text";

/** The shortest tilde fence. */
const MIN_FENCE_LENGTH = 3;

/**
 * Puts `text` inside a tilde fence that no line of the text can close: the fence is longer than
 * the longest run of tildes anywhere in the text (minimum three). The text is written unchanged;
 * a newline is added before the closing fence only when the text does not end with one. Returns
 * the opening line, the text and the closing line, ending with a newline.
 */
export function fenceUntrustedBlock(text: string): string {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    run = ch === "~" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  const fence = "~".repeat(Math.max(MIN_FENCE_LENGTH, longest + 1));
  const closing = text.endsWith("\n") ? "" : "\n";
  return `${fence}${UNTRUSTED_FENCE_INFO}\n${text}${closing}${fence}\n`;
}
