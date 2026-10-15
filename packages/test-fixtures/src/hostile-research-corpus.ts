/**
 * The hostile research corpus (D-26, RSRCH-09, plan 07-04). Every entry is a full document, either
 * an HTML page or a feed, that an attacker controlling a fetched source could serve. The sweep
 * test (research-sanitiser-corpus.test.ts) runs each one through the sanitiser and the delimiter
 * and asserts it is delimited, stripped where active, counted, and never executed.
 *
 * Every invisible or look-alike character is written as an escape sequence, never as a raw
 * character, so this file reads the same in every editor. A test scans this file's own source.
 * All strings are synthetic: the hosts are reserved `.invalid` names and no real name, address or
 * path appears here.
 */

import type { SanitiseReportKey } from "@ccc/research";

/** The run nonce the corpus forges. The sweep delimits with the same value. */
export const HOSTILE_RESEARCH_NONCE = "0123456789abcdef0123456789abcdef";
/** The source id the sweep delimits with. */
export const HOSTILE_RESEARCH_SOURCE_ID = "fedcba9876543210fedcba9876543210";

export const HOSTILE_RESEARCH_CATEGORIES = [
  "injected-instructions",
  "forged-closing-delimiter",
  "script",
  "event-handler",
  "javascript-url",
  "hidden-css-text",
  "html-comment",
  "shell-commands",
  "markdown-image-beacon",
  "wikilink-embed",
  "bidi-override",
  "zero-width",
  "double-encoded-entities",
  "long-string",
  "delimiter-injection",
  "feed-field-bypass",
] as const;

export type HostileResearchCategory = (typeof HOSTILE_RESEARCH_CATEGORIES)[number];

export interface HostileResearchEntry {
  /** A stable name tests cite. */
  readonly name: string;
  readonly category: HostileResearchCategory;
  /** An HTML page runs through htmlToText; a feed runs through parseFeed. */
  readonly kind: "page" | "feed";
  /** The whole fetched document. */
  readonly document: string;
  /** Strings that must not appear (case-insensitive) in the delimited block or any entry field. */
  readonly forbidden: readonly string[];
  /** Strings that must survive in the delimited block. */
  readonly keeps: readonly string[];
  /** Sanitise report keys that must be above zero. */
  readonly counts: readonly SanitiseReportKey[];
  /** True when the document forges a delimiter or the run nonce. */
  readonly delimiterPayload?: true;
  /** Bounds on the length of the sanitised text. */
  readonly outputLength?: { readonly min: number; readonly max: number };
}

// Filled in with the implementation commit.
export const HOSTILE_RESEARCH_CORPUS: readonly HostileResearchEntry[] = [];
