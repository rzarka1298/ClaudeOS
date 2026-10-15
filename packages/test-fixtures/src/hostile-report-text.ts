/**
 * Hostile report text (plan 07-08, D-06, RSRCH-08, research Pitfall 7, T-07-19). Every entry is a
 * span of text that would do something if an Obsidian note rendered it unescaped: fetch a beacon
 * image, transclude a private note, link out, open a callout, comment, fence or table, run a
 * Dataview or Templater expression, or smuggle an invisible character.
 *
 * Two sibling lists:
 *
 * - HOSTILE_REPORT_TEXTS: single-line spans that satisfy the domain's plain-line rule (at most 80
 *   characters, so each fits every field: topic, finding text, quote, source title, author,
 *   unavailable-source label). The sweep writes each one through the report, raw and wiki writers.
 * - HOSTILE_REPORT_RAW_SPANS: spans no schema would accept (line breaks, bidi and zero-width
 *   characters). They only ever reach the escape helper directly, which must still make them one
 *   inert line.
 *
 * Every invisible or look-alike character is written as an escape sequence, never as a raw
 * character, so this file reads the same in every editor; a test scans this file's own source.
 * All strings are synthetic: hosts are reserved `.invalid` names.
 */

export interface HostileReportText {
  /** A stable kebab-case name tests cite. */
  readonly name: string;
  readonly text: string;
}

const t = (name: string, text: string): HostileReportText => ({ name, text });

export const HOSTILE_REPORT_TEXTS: readonly HostileReportText[] = [
  t("image-beacon", "![x](https://evil.invalid/p.png)"),
  t("image-beacon-reference", "![x][r] [r]: https://evil.invalid/p.png"),
  t("image-beacon-title", '![x](https://evil.invalid/p.png "t")'),
  t("wikilink", "[[Private]]"),
  t("wikilink-alias", "[[Private|shown]]"),
  t("wikilink-heading-block", "[[Private#Heading^block]]"),
  t("embed", "![[Private]]"),
  t("embed-size", "![[Private.png|100]]"),
  t("markdown-link", "[click](https://evil.invalid/)"),
  t("javascript-link", "[click](javascript:alert(1))"),
  t("obsidian-link", "[open](obsidian://open?vault=v&file=x)"),
  t("autolink", "<https://evil.invalid/a>"),
  t("bare-address", "https://evil.invalid/a and www.evil.invalid"),
  t("html-image", "<img src=x onerror=alert(1)>"),
  t("html-script", "<script>alert(1)</script>"),
  t("html-iframe", '<iframe src="https://evil.invalid/"></iframe>'),
  t("html-comment", "<!-- hidden -->"),
  t("html-entity", "&lt;script&gt; &#60; &#x3c;"),
  t("obsidian-comment", "%%hidden comment%%"),
  t("tag", "#secret/tag #another"),
  t("callout", "> [!warning] fold"),
  t("callout-folded", "> [!note]- fold"),
  t("heading", "# Heading"),
  t("list-marker", "- item"),
  t("ordered-marker", "1. item"),
  t("thematic-break", "---"),
  t("setext-underline", "==="),
  t("table-row", "| a | b |"),
  t("table-delimiter", "| --- | --- |"),
  t("code-span", "`code` and ``double``"),
  t("backtick-fence", "```js alert(1) ```"),
  t("tilde-fence", "~~~ fence"),
  t("math-block", "$$ \\sqrt{x} $$"),
  t("math-inline", "$x^2$"),
  t("footnote", "[^1] and [^1]: note"),
  t("reference-definition", "[ref]: https://evil.invalid/ref"),
  t("emphasis", "**bold** _italic_ ~~strike~~ ==mark=="),
  t("block-id", "paragraph ^block-id"),
  t("dataview-inline", "`= this.file.name` and `$= dv.pages()`"),
  t("templater", "<% tp.file.title %> {{variable}}"),
  t("trailing-backslash", "ends with a backslash \\"),
  t("pre-escaped", "already \\[\\[escaped\\]\\] and \\\\"),
  t("punctuation-run", "*".repeat(60)),
  t("fullwidth-brackets", "\uff3b\uff3bPrivate\uff3d\uff3d \uff01\uff3bx\uff3d"),
  t("backslash-newline-literal", "a\\nb"),
];

export const HOSTILE_REPORT_RAW_SPANS: readonly HostileReportText[] = [
  t("newlines", "line one\n![x](https://evil.invalid/p.png)\n[[Private]]"),
  t("crlf", "a\r\nb\rc"),
  t("separators", "a\u2028b\u2029c\u0085d"),
  t("bidi-override", "safe\u202etxet\u202c"),
  t("bidi-isolate", "a\u2066b\u2069"),
  t("zero-width", "[\u200b[Private]\u200b]"),
  t("control-characters", "a\u0000b\u0007c\u007fd"),
  t("fence-after-newline", "text\n~~~\n```\n<script>"),
  t("heading-after-newline", "text\n# heading\n- list\n> quote"),
];
