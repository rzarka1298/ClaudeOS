/**
 * The named hostile strings every approval test shares: the neutraliser, the
 * engine, the view builder and the plugin tests (D-24, T-06-08). Every
 * invisible or look-alike character is written as an escape sequence, never as
 * a raw character, so this file reads the same in every editor and a reviewer
 * can see exactly which code point is meant. A test scans this file's own
 * source for raw non-ASCII characters.
 *
 * Angle brackets are assembled from their character codes, so the file holds no
 * literal markup. All strings are synthetic: no real name, address, path or
 * link appears here.
 *
 * Exported from the full barrel only. It is test data, not product code, so the
 * browser barrel leaves it out.
 */

export interface HostileCorpusEntry {
  /** A stable name tests cite. */
  readonly name: string;
  /** The hostile input. */
  readonly text: string;
  /** The visible tokens a one-line neutralisation must show for it, in `[U+XXXX]` form. */
  readonly tokens: readonly string[];
  /** True when the neutraliser must return the text unchanged (it holds nothing hidden). */
  readonly identical?: true;
}

const LT = String.fromCharCode(0x3c);
const GT = String.fromCharCode(0x3e);

export const HOSTILE_CORPUS: readonly HostileCorpusEntry[] = [
  {
    name: "markdown-emphasis",
    text: "**bold** and _italic_ and `code`",
    tokens: [],
    identical: true,
  },
  {
    name: "markdown-link",
    text: "[click here](https://example.invalid/path)",
    tokens: [],
    identical: true,
  },
  {
    name: "html-tag",
    text: `${LT}b${GT}bold${LT}/b${GT} ${LT}a href="x"${GT}link${LT}/a${GT}`,
    tokens: [],
    identical: true,
  },
  {
    name: "script-element",
    text: `${LT}script${GT}alert(1)${LT}/script${GT}`,
    tokens: [],
    identical: true,
  },
  { name: "right-to-left-override", text: "invoice\u202egpj.exe", tokens: ["[U+202E]"] },
  { name: "isolate", text: "a\u2067b\u2069c", tokens: ["[U+2067]", "[U+2069]"] },
  { name: "bidi-embedding", text: "a\u202ab\u202cc", tokens: ["[U+202A]", "[U+202C]"] },
  { name: "arabic-letter-mark", text: "a\u061cb", tokens: ["[U+061C]"] },
  { name: "zero-width-space", text: "pay\u200bment", tokens: ["[U+200B]"] },
  {
    name: "zero-width-joiner-emoji",
    text: "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}",
    tokens: ["[U+200D]"],
  },
  { name: "byte-order-mark", text: "\ufeffstart", tokens: ["[U+FEFF]"] },
  { name: "soft-hyphen", text: "ap\u00adprove", tokens: ["[U+00AD]"] },
  { name: "hangul-filler", text: "x\u3164y", tokens: ["[U+3164]"] },
  { name: "halfwidth-hangul-filler", text: "x\uffa0y", tokens: ["[U+FFA0]"] },
  { name: "braille-blank", text: "x\u2800y", tokens: ["[U+2800]"] },
  { name: "combining-grapheme-joiner", text: "x\u034fy", tokens: ["[U+034F]"] },
  { name: "no-break-space", text: "a\u00a0b", tokens: ["[U+00A0]"] },
  { name: "ideographic-space", text: "a\u3000b", tokens: ["[U+3000]"] },
  { name: "em-space", text: "a\u2003b", tokens: ["[U+2003]"] },
  { name: "line-separator", text: "a\u2028b", tokens: [] },
  { name: "tag-character", text: "a\u{e0041}b", tokens: ["[U+E0041]"] },
  { name: "lone-surrogate", text: "a\ud800b", tokens: ["[U+D800]"] },
  { name: "variation-selector-16", text: "a\uFE0Fb", tokens: ["[U+FE0F]"] },
  { name: "variation-selector-1", text: "a\uFE00b", tokens: ["[U+FE00]"] },
  { name: "variation-selector-supplement", text: "a\u{E0100}b", tokens: ["[U+E0100]"] },
  { name: "mongolian-free-variation-selector", text: "a\u180Bb", tokens: ["[U+180B]"] },
  { name: "mongolian-free-variation-selector-4", text: "a\u180Fb", tokens: ["[U+180F]"] },
  { name: "private-use-bmp", text: "a\uE000b", tokens: ["[U+E000]"] },
  { name: "private-use-plane-15", text: "a\u{F0000}b", tokens: ["[U+F0000]"] },
  { name: "unassigned-bmp", text: "a\u0378b", tokens: ["[U+0378]"] },
  { name: "noncharacter-last", text: "a\u{10FFFF}b", tokens: ["[U+10FFFF]"] },
  { name: "long-5000", text: "x".repeat(5000), tokens: [] },
  { name: "label-system", text: "System", tokens: [], identical: true },
  { name: "newlines", text: "line one\r\nline two\rline three\nline four", tokens: [] },
  { name: "nul-and-del", text: "a\u0000b\u007fc", tokens: ["[U+0000]", "[U+007F]"] },
  { name: "escape-and-tab", text: "a\u001b[31mb\tc", tokens: ["[U+001B]", "[U+0009]"] },
];

/** The corpus entry with this name, or a thrown error: a test that cites a missing entry is wrong. */
export function corpusText(name: string): string {
  const entry = HOSTILE_CORPUS.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no hostile corpus entry named ${name}`);
  return entry.text;
}
