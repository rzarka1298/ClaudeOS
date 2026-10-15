// Neutralising one span of untrusted model text (plan 07-07, D-06, RSRCH-08, research Pitfall 7).
//
// Model text is stored plain. Before it is stored:
//
//   1. control, format, line-separator, paragraph-separator and lone-surrogate characters, and the
//      invisible fillers, are removed and counted (the character classes are the domain
//      predicate `hasDisallowedTextCharacter`, not a second copy); tab, newline and the other
//      whitespace controls become spaces and are not counted; a line or paragraph separator
//      becomes a space and is counted;
//   2. NFC is applied and every whitespace run collapses to one space (`normaliseForMatch`);
//   3. every URL-like substring is replaced by ADDRESS_REMOVED_MARKER and counted: a scheme
//      followed by a colon and a slash or backslash, the named schemes that need no slashes
//      (`javascript:`, `data:`, `obsidian:` ...), and `www.` hosts. Addresses reach a report only
//      from fetch-stage source references (RSRCH-08). A compatibility-form spelling (fullwidth
//      letters, say) is caught by checking the NFKC form too, and the text is stored in that form
//      only when it hid an address;
//   4. the result is cut at the length limit on a character boundary and the cut is reported.
//
// Markdown, wikilinks, embeds and HTML are NOT removed here: they stay literal characters and the
// vault writer escapes them later (07-08). The scan is linear: a colon looks back over its own
// run of scheme characters only, and nothing is re-scanned.
//
// Pure: no I/O, no clock, no node module.

import { hasDisallowedTextCharacter } from "@ccc/domain";
import { stripFillerChars, truncateAtBoundary } from "./plain-text.js";
import { normaliseForMatch } from "./text-canon.js";

/** What a URL-like substring becomes. The vault writer escapes Markdown later; nothing here links. */
export const ADDRESS_REMOVED_MARKER = "[address removed]";

export interface NeutralisedSpan {
  readonly text: string;
  readonly addressesRemoved: number;
  readonly controlCharsRemoved: number;
  /** True when the text was cut at the length limit. */
  readonly truncated: boolean;
}

/** Schemes that make an active address without any slash. */
const SLASHLESS_SCHEMES: ReadonlySet<string> = new Set([
  "javascript",
  "data",
  "vbscript",
  "file",
  "obsidian",
  "mailto",
  "tel",
  "sms",
  "blob",
  "about",
  "view-source",
]);

/** Whitespace controls that read as a space, not as a removal. */
const SPACE_CONTROLS: ReadonlySet<string> = new Set(["\t", "\n", "\v", "\f", "\r", "\u0085"]);

const MAX_FOLD_PASSES = 4;

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isSchemeChar(code: number): boolean {
  return (
    isLetter(code) ||
    (code >= 48 && code <= 57) ||
    code === 43 || // +
    code === 45 || // -
    code === 46 // .
  );
}

/** Characters that end an address: whitespace and the closers and quotes that wrap one in markup. */
const ADDRESS_END = new Set(["<", ">", '"', "'", "`", "]", "}", "|"]);

/** Punctuation that belongs to the sentence around an address, not to the address. */
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);

function addressEnd(text: string, from: number): number {
  let end = from;
  let depth = 0;
  while (end < text.length) {
    const ch = text.charAt(end);
    if (/\s/u.test(ch) || ADDRESS_END.has(ch)) break;
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
    end += 1;
  }
  while (end > from && TRAILING_PUNCTUATION.has(text.charAt(end - 1))) end -= 1;
  return end;
}

interface Replaced {
  readonly text: string;
  readonly count: number;
}

/** `scheme:` followed by a slash or backslash, and the named slashless schemes. */
function replaceSchemes(text: string): Replaced {
  let out = "";
  let cursor = 0;
  let from = 0;
  let count = 0;
  for (;;) {
    const colon = text.indexOf(":", from);
    if (colon === -1) break;
    from = colon + 1;
    // The scheme is the run of scheme characters just before the colon, from its first letter.
    let start = colon;
    while (start > cursor && isSchemeChar(text.charCodeAt(start - 1))) start -= 1;
    while (start < colon && !isLetter(text.charCodeAt(start))) start += 1;
    if (start === colon) continue;
    const next = text.charAt(colon + 1);
    const slashed = (next === "/" || next === "\\") && colon - start >= 2;
    const named =
      next !== "" &&
      !/\s/u.test(next) &&
      SLASHLESS_SCHEMES.has(text.slice(start, colon).toLowerCase());
    if (!slashed && !named) continue;
    const end = addressEnd(text, colon + 1);
    out += text.slice(cursor, start) + ADDRESS_REMOVED_MARKER;
    cursor = end;
    from = end;
    count += 1;
  }
  return { text: out + text.slice(cursor), count };
}

const WWW_HOST_START = /(?<![\p{L}\p{N}])www\.[\p{L}\p{N}]/giu;

/** `www.` hosts, which an editor links without a scheme. */
function replaceWwwHosts(text: string): Replaced {
  const pattern = new RegExp(WWW_HOST_START.source, WWW_HOST_START.flags);
  let out = "";
  let cursor = 0;
  let count = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const end = addressEnd(text, match.index);
    out += text.slice(cursor, match.index) + ADDRESS_REMOVED_MARKER;
    cursor = end;
    pattern.lastIndex = end;
    count += 1;
  }
  return { text: out + text.slice(cursor), count };
}

function replaceAddresses(text: string): Replaced {
  const schemes = replaceSchemes(text);
  const hosts = replaceWwwHosts(schemes.text);
  return { text: hosts.text, count: schemes.count + hosts.count };
}

/** Replaces addresses, also those spelled in a compatibility form that folds to a real one. */
function neutraliseAddresses(text: string): Replaced {
  let current = text;
  let total = 0;
  for (let pass = 0; pass < MAX_FOLD_PASSES; pass += 1) {
    const direct = replaceAddresses(current);
    current = direct.text;
    total += direct.count;
    const folded = current.normalize("NFKC");
    if (folded === current) break;
    const probe = replaceAddresses(folded);
    if (probe.count === 0) break;
    current = probe.text;
    total += probe.count;
  }
  return { text: current, count: total };
}

function removeUnsafeCharacters(text: string): { text: string; removed: number } {
  let removed = 0;
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (SPACE_CONTROLS.has(ch)) {
      out += " ";
    } else if (ch === " " || ch === " ") {
      out += " ";
      removed += 1;
    } else if (hasDisallowedTextCharacter(ch) || (code >= 0xd800 && code <= 0xdfff)) {
      removed += 1;
    } else {
      out += ch;
    }
  }
  const unfilled = stripFillerChars(out);
  removed += out.length - unfilled.length;
  return { text: unfilled, removed };
}

export function neutraliseUntrustedSpan(text: string, maxLength: number): NeutralisedSpan {
  const characters = removeUnsafeCharacters(text.normalize("NFC"));
  const normalised = normaliseForMatch(characters.text);
  const addresses = neutraliseAddresses(normalised);
  const cut = truncateAtBoundary(addresses.text, Math.max(0, maxLength));
  return {
    text: cut.trimEnd(),
    addressesRemoved: addresses.count,
    controlCharsRemoved: characters.removed,
    truncated: cut.length < addresses.text.length,
  };
}
