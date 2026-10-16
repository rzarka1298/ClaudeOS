// The source delimiter (D-06, D-26, RSRCH-08). Each source is wrapped in one block:
//
//   <<<SRC id=<32 hex> nonce=<nonce>>>>
//   <text>
//   <<<END nonce=<nonce>>>>
//
// The nonce is chosen by the caller for each run (16 to 64 lowercase hex characters). Source text
// is attacker-controlled, so it is made unable to close, forge or reopen a block (security
// finding 1):
//
//   1. validation first: ids and nonce are checked and a DelimitError is thrown before anything
//      is composed;
//   2. the text is normalised: CR becomes LF, zero-width, bidi and control characters are removed,
//      and the result is NFKC, so fullwidth and compatibility forms read as plain characters;
//      the invisible fillers outside those categories (U+034F, U+FE00 to U+FE0F, U+115F,
//      U+1160, U+3164, U+FFA0, U+2800) are removed too, after every normalisation;
//   3. the NORMALISED text is scanned, on a length-preserving look-alike skeleton (Cyrillic and
//      Greek letters, angle quotation marks, non-Latin digits), case-insensitively and with any
//      whitespace between the brackets and the word, for `<<<SRC`, `<<<END` (with an adjacent
//      `nonce=...>>>` tail when there is one) and for the nonce itself; every hit is replaced by
//      a fixed visible marker that contains no angle bracket, in the normalised text, so what is
//      wrapped is exactly what was checked and legitimate non-Latin text is left alone;
//   4. steps 2 and 3 repeat until nothing is found, so a marker that re-forms across a scrubbed
//      boundary is caught on the next pass.
//
// parseDelimitedBlocks takes no nonce: it reads it from the first header and accepts only blocks
// that use the same one.

import { MARKER_REPLACEMENT, stripFillerChars, stripUnsafeChars } from "./plain-text.js";

export interface SourceText {
  readonly sourceId: string;
  readonly text: string;
}

export interface DelimitedBlock {
  readonly sourceId: string;
  readonly text: string;
}

/** What a scrubbed occurrence of the run nonce becomes. */
export const NONCE_REPLACEMENT = "[nonce removed]";

export type DelimitErrorCode = "invalid-source-id" | "invalid-nonce";

/** Thrown before anything is composed when an id or the nonce has the wrong shape. */
export class DelimitError extends Error {
  readonly code: DelimitErrorCode;
  constructor(code: DelimitErrorCode, message: string) {
    super(message);
    this.name = "DelimitError";
    this.code = code;
  }
}

export interface ScrubbedSourceText {
  /** The text that is wrapped: normalised, with every marker-like sequence replaced. */
  readonly text: string;
  /** Marker-like sequences and nonce occurrences replaced. */
  readonly scrubbed: number;
  /** Zero-width, bidi and control characters removed first. */
  readonly invisibleRemoved: number;
}

export interface DelimitedSources {
  readonly composed: string;
  readonly scrubbed: number;
}

const SOURCE_ID = /^[0-9a-f]{32}$/;
const NONCE = /^[0-9a-f]{16,64}$/;
const HEADER = /^<<<SRC id=([0-9a-f]{32}) nonce=([0-9a-f]{16,64})>>>$/;

function assertNonce(nonce: string): void {
  if (typeof nonce !== "string" || !NONCE.test(nonce)) {
    throw new DelimitError("invalid-nonce", "the nonce must be 16 to 64 lowercase hex characters");
  }
}

function assertSourceId(id: string): void {
  if (typeof id !== "string" || !SOURCE_ID.test(id)) {
    throw new DelimitError("invalid-source-id", "a source id must be 32 lowercase hex characters");
  }
}

// --- look-alike skeleton -----------------------------------------------------------------------

// One UTF-16 unit in, one out, so an index in the skeleton is the same index in the text.
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  // angle brackets and quotation marks
  "\u2039": "<",
  "\u00AB": "<",
  "\u27E8": "<",
  "\u3008": "<",
  "\u300A": "<",
  "\u276E": "<",
  "\u02C2": "<",
  "\u203A": ">",
  "\u00BB": ">",
  "\u27E9": ">",
  "\u3009": ">",
  "\u300B": ">",
  "\u276F": ">",
  "\u02C3": ">",
  // Cyrillic letters
  \u0410: "A",
  \u0412: "B",
  \u0415: "E",
  \u0405: "S",
  \u0421: "C",
  \u0430: "a",
  \u0435: "e",
  \u0441: "c",
  \u0455: "s",
  \u0501: "d",
  // Greek letters
  \u0391: "A",
  \u0392: "B",
  \u0395: "E",
  \u039D: "N",
  \u03A1: "P",
  \u03BF: "o",
  // Arabic-Indic and extended digits
  "\u0660": "0",
  "\u0661": "1",
  "\u0662": "2",
  "\u0663": "3",
  "\u0664": "4",
  "\u0665": "5",
  "\u0666": "6",
  "\u0667": "7",
  "\u0668": "8",
  "\u0669": "9",
  "\u06F0": "0",
  "\u06F1": "1",
  "\u06F2": "2",
  "\u06F3": "3",
  "\u06F4": "4",
  "\u06F5": "5",
  "\u06F6": "6",
  "\u06F7": "7",
  "\u06F8": "8",
  "\u06F9": "9",
};

// Further look-alikes by code point (Cherokee, Lisu, Canadian syllabics, Armenian, ornament
// brackets), so this source holds no raw character and no escape for them.
const MORE_LOOK_ALIKES: ReadonlyArray<readonly [letter: string, codePoints: readonly number[]]> = [
  ["E", [0x13ac, 0xa4f0, 0x15f4]],
  ["N", [0x144e]],
  ["D", [0x13a0, 0xa4d3, 0x15de]],
  ["S", [0x13da, 0xa4e2, 0x054f, 0x1515]],
  ["R", [0x13d2, 0xa4e3, 0x1587]],
  ["C", [0x13df, 0xa4da, 0x1455]],
  ["<", [0x1438, 0x276c, 0x2770]],
  [">", [0x1433, 0x276d, 0x2771]],
];
const ALL_LOOK_ALIKES: Record<string, string> = { ...LOOK_ALIKES };
for (const [letter, codePoints] of MORE_LOOK_ALIKES) {
  for (const code of codePoints) ALL_LOOK_ALIKES[String.fromCharCode(code)] = letter;
}

const LOOK_ALIKE_CHARS = new RegExp(`[${Object.keys(ALL_LOOK_ALIKES).join("")}]`, "g");

function skeleton(text: string): string {
  return text.replace(LOOK_ALIKE_CHARS, (c) => ALL_LOOK_ALIKES[c] ?? c);
}

// `<<<SRC` or `<<<END`, with any whitespace between the brackets and the word, optionally
// followed by an adjacent `...>>>` tail on the same line (the header or footer remainder).
const MARKER_SOURCE = "<\\s*<\\s*<\\s*(?:s\\s*r\\s*c|e\\s*n\\s*d)(?:[^\\n<>]{0,200}?>\\s*>\\s*>)?";

const MAX_PASSES = 1_000;

/**
 * Normalises source text and replaces every delimiter-like sequence and the nonce with a fixed
 * visible marker, to a fixed point. The returned text is what gets wrapped.
 */
export function scrubSourceText(text: string, nonce: string): ScrubbedSourceText {
  assertNonce(nonce);
  return scrub(text, nonce);
}

/**
 * THE evidence text of a source (07-FIX3A, F3): exactly the string the summariser is shown inside
 * the source's delimited block, which is `scrubSourceText(text, nonce).text` (invisible characters
 * removed, NFKC, every marker-like sequence and the run nonce replaced). It is the only text a
 * quote is verified against, through `quoteInSource` / `quoteInNormalisedSource`:
 *
 *   - the trusted stage (`validateSummariserOutput`) verifies each quote against the evidence
 *     text of each cited source (it applies this function to the sources it is given);
 *   - the extractive double quotes the evidence text of each block;
 *   - the vault raw note stores the evidence text as the snapshot body (the service passes it to
 *     `writeRawSourceNote`; vault-repo cannot import this package), so a stored quote re-verifies
 *     against the stored snapshot;
 *   - provenance (plan 07-14) re-verifies quotes against the raw note's body text.
 *
 * Verifying against any other form (the pre-NFKC text, say) would wrongly refuse a correct quote
 * (a ligature shown as its plain letters) or accept one the model never saw.
 *
 * Idempotent: the evidence text of an evidence text is itself. The nonce is optional because a
 * nonce only changes text that contains the run nonce, which a source that was already wrapped
 * cannot; pass it wherever the run nonce is known.
 *
 * @throws {DelimitError} when a nonce is given and has the wrong shape.
 */
export function evidenceText(text: string, nonce?: string): string {
  if (nonce !== undefined) assertNonce(nonce);
  return scrub(text, nonce ?? null).text;
}

function scrub(text: string, nonce: string | null): ScrubbedSourceText {
  const stripped = stripUnsafeChars(text.replace(/\r\n?/g, "\n"));
  const pattern = new RegExp(
    nonce === null ? `(?:${MARKER_SOURCE})` : `(?:${MARKER_SOURCE})|(${nonce})`,
    "gi",
  );
  // NFKC can turn a compatibility filler into a plain one (U+3164 becomes U+1160), so the fillers
  // are removed after every normalisation, and the first pass is on the filler-free view.
  let current = stripFillerChars(stripped.text.normalize("NFKC"));
  let scrubbed = 0;

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const view = skeleton(current);
    pattern.lastIndex = 0;
    let out = "";
    let cursor = 0;
    let found = 0;
    for (let match = pattern.exec(view); match !== null; match = pattern.exec(view)) {
      out += current.slice(cursor, match.index);
      out += match[1] === undefined ? MARKER_REPLACEMENT : NONCE_REPLACEMENT;
      cursor = match.index + match[0].length;
      found += 1;
    }
    if (found === 0) return { text: current, scrubbed, invisibleRemoved: stripped.removed };
    out += current.slice(cursor);
    scrubbed += found;
    current = stripFillerChars(out.normalize("NFKC"));
  }
  // Unreachable in practice: each pass removes at least one angle bracket run. If it is ever
  // reached, no angle bracket survives.
  return {
    text: current.replace(/[<>]/g, " "),
    scrubbed,
    invisibleRemoved: stripped.removed,
  };
}

/** Wraps each source in a block and reports how many marker-like sequences were scrubbed. */
export function delimitSourcesWithReport(
  sources: readonly SourceText[],
  nonce: string,
): DelimitedSources {
  assertNonce(nonce);
  for (const source of sources) assertSourceId(source.sourceId);
  let scrubbed = 0;
  const blocks = sources.map((source) => {
    const result = scrubSourceText(source.text, nonce);
    scrubbed += result.scrubbed;
    return `<<<SRC id=${source.sourceId} nonce=${nonce}>>>\n${result.text}\n<<<END nonce=${nonce}>>>`;
  });
  return { composed: blocks.join("\n"), scrubbed };
}

export function delimitSources(sources: readonly SourceText[], nonce: string): string {
  return delimitSourcesWithReport(sources, nonce).composed;
}

/**
 * Recovers the blocks of a composed text. The nonce is read from the first header; a block with
 * a different nonce is ignored, as is a header that is malformed or has no footer.
 */
export function parseDelimitedBlocks(composed: string): readonly DelimitedBlock[] {
  const blocks: DelimitedBlock[] = [];
  let nonce: string | null = null;
  let cursor = 0;
  let footerAt = -2;
  while (cursor < composed.length) {
    const lineEnd = composed.indexOf("\n", cursor);
    const line = lineEnd === -1 ? composed.slice(cursor) : composed.slice(cursor, lineEnd);
    const header = HEADER.exec(line);
    if (header === null || lineEnd === -1) {
      cursor = lineEnd === -1 ? composed.length : lineEnd + 1;
      continue;
    }
    const headerNonce = header[2] ?? "";
    if (nonce === null) nonce = headerNonce;
    if (headerNonce !== nonce) {
      cursor = lineEnd + 1;
      continue;
    }
    const bodyStart = lineEnd + 1;
    const footer = `\n<<<END nonce=${nonce}>>>`;
    // The footer position is reused until the cursor passes it: a text with many headers and
    // one footer must not be searched again from every header.
    if (footerAt < bodyStart) footerAt = composed.indexOf(footer, bodyStart);
    const bodyEnd = footerAt;
    if (bodyEnd === -1) break;
    const after = bodyEnd + footer.length;
    if (after < composed.length && composed[after] !== "\n") {
      cursor = lineEnd + 1;
      continue;
    }
    blocks.push({ sourceId: header[1] ?? "", text: composed.slice(bodyStart, bodyEnd) });
    cursor = after;
  }
  return blocks;
}
