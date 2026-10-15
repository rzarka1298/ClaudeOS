// The streaming HTML sanitiser (D-06, D-26, RSRCH-08, research Pattern 2): an ALLOWLIST extractor.
//
// A callback pass over htmlparser2 that never builds a tree. A stack of frames mirrors the
// parser's own element stack, and `hiddenDepth` counts the open frames that drop their content, so
// text is emitted only while it is zero. Text shows only when the element and EVERY ancestor is in
// CONTENT_ELEMENTS (a fixed set of known content elements) and none carries a hiding signal. Any
// other element (unknown, custom, legacy, raw-text, template, noscript, svg, math, media, form
// controls) drops its whole subtree and is counted; an element left open at the end of the input
// stays dropped. A frame closes only on its own end tag.
//
// Hiding signals: the `hidden`, `inert`, `popover` and `slot` attributes; `aria-hidden` with any
// value other than `false`; the class tokens hidden, sr-only, invisible, d-none, display-none,
// visually-hidden and screen-reader-text; `type=hidden` inputs; and an inline style that is not
// plainly harmless. The style check is an ALLOWLIST: a style attribute keeps its element visible
// only if every declaration is in a small set (text-align, font-weight, font-style,
// text-decoration, text-transform, list-style-type, white-space, line-height 0.8 to 5 or 8 to 200
// px, font-size 8 to 72 px or an absolute keyword, font-family, border*, padding and margin in
// plain px up to 200 with a running total of 4,000 px down the nesting, non-zero width, height and
// max-width, display block/inline/inline-block/list-item/table*, opacity exactly 1) with a value
// the filter can read. Colours are NOT in the set: the page's default colours are known, so a
// colour or a background alone can already make text unreadable. Any other property, variable,
// calc, escape, comment, unparseable declaration, alpha channel, relative size or CSS-wide
// keyword, or a style over 2 KiB, drops the element and counts it. A false hit costs a counted,
// dropped block; there is no denylist to keep complete. The head is dropped without a count. The
// content of a closed details (past its first summary) is dropped and counted. A main
// or article subtree is preferred when one is visible (text outside it is dropped and counted as
// one hidden block). No attribute value is ever read into the output, block elements are separated
// by newlines, control and format characters are removed and counted, and every removal is counted
// into the eight keys of SANITISE_REPORT_KEYS.
//
// Every cap (depth 512, 100,000 elements, 1,000,000 input characters) drops the remainder and
// counts it; the page text cap of 20,000 characters cuts output after filtering. The parser is
// handed the input in 4 KiB pieces and no more once the sink has stopped, so the parser's own
// cost is bounded too. A parse that throws stops emitting.
//
// Where a browser and htmlparser2 build different trees the filter drops more, never less, and it
// prefers a coarse gate to emulating the browser. Whole-document gates: a marked section
// (`<![CDATA[`), frames, plaintext, xmp, svg, math, annotation-xml and ANY noscript anywhere in the
// input (a browser that runs scripts ends a noscript at the first literal `</noscript`, wherever
// it sits), and a raw-text start tag (style, script, title, textarea, iframe, xmp, noembed,
// noframes, plaintext) while a select is open, empty the page's text (counted once, `truncated`).
// Known cost, carried to the phase judge as lossy by design: the gate reads the raw input, so a
// page with an inline svg icon, a tag-manager noscript iframe, or the `<![CDATA[` that WordPress
// writes inside an inline script yields no text at all. Narrowing is one regular expression
// (`WHOLE_DOCUMENT_GATE`) and an owner decision.
//
// Partial gates: the filter records every frame the parser closed implicitly and, when anything
// hidden (or a closed details) is open and parser and browser are not KNOWN to agree (misnested
// formatting and the adoption agency, an end tag ignored behind a special element or outside its
// scope, a list item or form end tag, tables and their foster parenting, template content, a stale
// list of formatting elements or form pointer), drops the remainder, counts it and sets
// `truncated`. After any stop, a body, html or frameset start tag in what was never parsed, in the
// tokenizer's unfinished tail (a tag cut by the 4 KiB boundary) or anywhere after the stop position
// (raw text can swallow one) discards everything, and a later body or html start tag that hides
// by its OWN attributes wipes what was read. Visible markup that merely misnests is not dropped:
// there is nothing a browser could hide from a reader. The seeded differentials in
// html-implied-close.test.ts compare the filter with parse5 on generated documents.
//
// Honest limits: CSS delivered by a stylesheet cannot be evaluated without rendering, so text
// hidden that way survives unless the element also carries one of the recognised signals above
// (a class alone proves nothing, so only the common hiding utilities are recognised by name);
// text hidden by a colour that merely matches an unknown (stylesheet) background survives too. The
// defence for that residue is the source delimiter and the tool-less summariser, not detection.
//
// The filter runs on the SAME parse whose text it emits. The sanitiser is an event sink
// (`createMarkupSink`): htmlToText drives it from an HTML-mode parse, and the feed parser drives
// it directly from its own XML events for xhtml content, so nothing is ever re-serialised and
// parsed a second time. Element and attribute names are compared by their lowercase local name
// (`xhtml:script` is a script, `HIDDEN` is hidden), attribute values arrive entity-decoded, and
// a style value the filter cannot read is treated as hidden and counted.
//
// Untrusted text passes through this function exactly once. Callers must not feed its output back
// in: a decoded `&lt;script&gt;` is literal text here and stays literal.

import { Parser } from "htmlparser2";
import { countCommandLikeLines, stripUnsafeChars, truncateAtBoundary } from "./plain-text.js";

/** The eight counters that describe what the sanitiser removed (SC4 "described"). */
export const SANITISE_REPORT_KEYS = [
  "scripts",
  "styles",
  "comments",
  "hiddenBlocks",
  "mediaDropped",
  "linksDropped",
  "controlChars",
  "commandLikeLines",
] as const;

export type SanitiseReportKey = (typeof SANITISE_REPORT_KEYS)[number];
export type SanitiseReport = Readonly<Record<SanitiseReportKey, number>>;
export type MutableSanitiseReport = Record<SanitiseReportKey, number>;

export interface HtmlToTextResult {
  readonly text: string;
  readonly report: SanitiseReport;
  /** True when the depth cap or the page text cap cut the output. */
  readonly truncated: boolean;
}

/** A fresh report with every key at zero, in SANITISE_REPORT_KEYS order. */
export function newReport(): MutableSanitiseReport {
  return {
    scripts: 0,
    styles: 0,
    comments: 0,
    hiddenBlocks: 0,
    mediaDropped: 0,
    linksDropped: 0,
    controlChars: 0,
    commandLikeLines: 0,
  };
}

export function emptyReport(): SanitiseReport {
  return newReport();
}

/** Adds every count of `from` into `into`. */
export function addReport(into: MutableSanitiseReport, from: SanitiseReport): void {
  for (const key of SANITISE_REPORT_KEYS) into[key] += from[key];
}

/** Nesting deeper than this many open elements stops the parse and sets `truncated`. */
export const MAX_DEPTH = 512;
/** Page text is cut to this many characters. */
export const MAX_PAGE_CHARS = 20_000;
/** Input longer than this many characters is cut; the remainder is dropped and counted. */
export const MAX_INPUT_CHARS = 1_000_000;
/** More open elements than this stops the parse; the remainder is dropped and counted. */
export const MAX_NODES = 100_000;
/** A style attribute longer than this is treated as unreadable (hidden), never as visible. */
export const MAX_STYLE_CHARS = 2_048;
/** Collected text per bucket stops growing here, long before it could matter for memory. */
const COLLECT_CAP = 100_000;

/**
 * The allowlist: the only elements whose text is ever emitted. An element outside it (unknown,
 * custom, legacy, raw-text, template, svg, math, media, form controls) drops its whole subtree.
 * Void members (br, hr, wbr) only separate lines.
 */
export const CONTENT_ELEMENTS: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
  "big",
  "blockquote",
  "body",
  "br",
  "caption",
  "center",
  "cite",
  "code",
  "colgroup",
  "data",
  "dd",
  "del",
  "details",
  "dfn",
  "dir",
  "div",
  "dl",
  "dt",
  "em",
  "fieldset",
  "figcaption",
  "figure",
  "font",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "html",
  "i",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "main",
  "mark",
  "menu",
  "nav",
  "nobr",
  "ol",
  "p",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "tt",
  "u",
  "ul",
  "var",
  "wbr",
]);

export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "basefont",
  "br",
  "col",
  "command",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "isindex",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "caption",
  "dd",
  "details",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "ul",
]);

const CELL = new Set(["td", "th"]);

/** Content never rendered to a reader, dropped without a count. */
const SILENT_HIDDEN = new Set(["head", "title"]);

/** Content a browser does not render in place, dropped and counted as a hidden block. */
const HIDDEN_CONTAINERS = new Set(["template", "noscript"]);

/** Media, embeds and form controls: dropped with their content and counted. */
const MEDIA = new Set([
  "applet",
  "area",
  "audio",
  "button",
  "canvas",
  "datalist",
  "embed",
  "frame",
  "frameset",
  "iframe",
  "img",
  "input",
  "map",
  "math",
  "noembed",
  "noframes",
  "object",
  "picture",
  "select",
  "source",
  "svg",
  "textarea",
  "track",
  "video",
  "xmp",
]);

// --- inline style allowlist ----------------------------------------------------------------------
//
// A style attribute keeps its element visible only if EVERY declaration is a property from a small
// harmless set with a value the filter can read and that cannot hide text. Anything else (another
// property, a variable, calc, an escape, a comment, a declaration without a colon, opacity other
// than exactly 1, an alpha channel, a CSS-wide keyword, a text colour together with a background)
// hides the element: its subtree is dropped and counted. There is no denylist to keep complete.

const CSS_WIDE = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);

/** Anything the filter will not evaluate: a function that resolves later, an escape, a comment. */
const UNREADABLE_VALUE = /var\(|calc\(|env\(|attr\(|url\(|image-set\(|expression|\\|\/\*|!/;

const KEYWORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  "text-align": new Set(["left", "right", "center", "justify", "start", "end"]),
  "font-style": new Set(["normal", "italic", "oblique"]),
  "text-transform": new Set(["none", "uppercase", "lowercase", "capitalize"]),
  "list-style-type": new Set([
    "disc",
    "circle",
    "square",
    "decimal",
    "decimal-leading-zero",
    "lower-alpha",
    "upper-alpha",
    "lower-roman",
    "upper-roman",
    "lower-latin",
    "upper-latin",
    "none",
  ]),
  "white-space": new Set(["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"]),
  // table-column and table-column-group are NOT here: their children are not rendered at all.
  display: new Set([
    "block",
    "inline",
    "inline-block",
    "list-item",
    "table",
    "inline-table",
    "table-row",
    "table-cell",
    "table-row-group",
    "table-header-group",
    "table-footer-group",
    "table-caption",
  ]),
};

const DECORATION_WORDS = new Set([
  "none",
  "underline",
  "overline",
  "line-through",
  "solid",
  "double",
  "dotted",
  "dashed",
  "wavy",
]);

/** Absolute type keywords only: smaller and larger are relative and compound down the tree. */
const FONT_SIZE_WORDS = new Set([
  "xx-small",
  "x-small",
  "small",
  "medium",
  "large",
  "x-large",
  "xx-large",
]);

const SIDES = new Set(["", "-top", "-right", "-bottom", "-left"]);

/** Padding, margin and border lengths are px only and at most this many. */
const MAX_OFFSET_PX = 200;
/**
 * The padding, margin and border pixels summed over an element and all its ancestors may not pass
 * this: nested offsets add up and would move the text out of view.
 */
export const MAX_STYLE_LOAD = 4_000;

const NUMBER = /^[0-9]+(?:\.[0-9]+)?$|^\.[0-9]+$/;
const PIXELS = /^([0-9]+(?:\.[0-9]+)?|\.[0-9]+)px$/;

/** A length in pixels, or null for anything else (a relative unit, a keyword, a calc). */
function pixels(token: string): number | null {
  if (token === "0") return 0;
  const match = PIXELS.exec(token);
  return match === null ? null : Number.parseFloat(match[1] ?? "");
}

/** A non-negative offset (padding, margin) of at most MAX_OFFSET_PX pixels. */
function smallOffset(token: string, allowAuto: boolean): boolean {
  if (token === "auto") return allowAuto;
  const size = pixels(token);
  return size !== null && size <= MAX_OFFSET_PX;
}

/** A box size that is not about zero: auto, none (max-width), a percentage above 0 or 1px and more. */
function usableSize(token: string, allowNone: boolean): boolean {
  if (token === "auto") return true;
  if (token === "none") return allowNone;
  const percent = /^([0-9]+(?:\.[0-9]+)?|\.[0-9]+)%$/.exec(token);
  if (percent !== null) return Number.parseFloat(percent[1] ?? "") >= 1;
  const size = pixels(token);
  return size !== null && size >= 1;
}

/** Absolute type a reader can read: a small keyword set, or 8 to 72 pixels. */
function readableFontSize(token: string): boolean {
  if (FONT_SIZE_WORDS.has(token)) return true;
  const size = pixels(token);
  return size !== null && size >= 8 && size <= 72;
}

function lineHeightOk(value: string): boolean {
  if (value === "normal") return true;
  if (NUMBER.test(value)) {
    const number = Number.parseFloat(value);
    return number >= 0.8 && number <= 5;
  }
  const size = pixels(value);
  return size !== null && size >= 8 && size <= MAX_OFFSET_PX;
}

/** A border value: lengths in px (at most 200), 0, plain words and #hex colours; nothing else. */
function borderOk(value: string): boolean {
  return value.split(" ").every((token) => {
    if (/^[a-z]+(?:-[a-z]+)*$/.test(token) || /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(token)) {
      return true;
    }
    const size = pixels(token);
    return size !== null && size <= MAX_OFFSET_PX;
  });
}

function declarationOk(property: string, value: string): boolean {
  const keywords = KEYWORDS[property];
  if (keywords !== undefined) return keywords.has(value);
  if (property === "font-weight") {
    if (["normal", "bold", "bolder", "lighter"].includes(value)) return true;
    return /^[0-9]{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= 1000;
  }
  if (property === "text-decoration") {
    return value.split(" ").every((word) => DECORATION_WORDS.has(word));
  }
  if (property === "line-height") return lineHeightOk(value);
  if (property === "font-size") return readableFontSize(value);
  if (property === "font-family") return /^[a-z0-9 ,'"_.-]+$/.test(value);
  if (property === "opacity") return value === "1" || value === "1.0" || value === "100%";
  if (property === "width" || property === "height") return usableSize(value, false);
  if (property === "max-width") return usableSize(value, true);
  if (property.startsWith("border")) return borderOk(value);
  for (const base of ["padding", "margin"]) {
    if (property.startsWith(base) && SIDES.has(property.slice(base.length))) {
      const tokens = value.split(" ");
      return (
        tokens.length >= 1 &&
        tokens.length <= 4 &&
        tokens.every((token) => smallOffset(token, base === "margin"))
      );
    }
  }
  return false;
}

/** The pixels a declaration adds to the nested load (padding, margin, border lengths). */
function declarationLoad(property: string, value: string): number {
  if (
    !(
      property.startsWith("border") ||
      property.startsWith("padding") ||
      property.startsWith("margin")
    )
  ) {
    return 0;
  }
  let sum = 0;
  for (const token of value.split(" ")) sum += pixels(token) ?? 0;
  return sum;
}

/**
 * The nested load of a style attribute (pixels of padding, margin and border), or null when the
 * style is not entirely in the allowlist and cannot hide the element. Null means the element is
 * dropped: a property outside the set (colours are outside it), a value that cannot be read, or a
 * value out of range.
 */
function styleLoad(style: string): number | null {
  const lower = style.toLowerCase();
  const stripped = lower.replace(/!\s*important\s*(?=;|$)/g, "");
  if (UNREADABLE_VALUE.test(stripped)) return null;
  let load = 0;
  for (const declaration of stripped.split(";")) {
    if (declaration.trim() === "") continue;
    const colon = declaration.indexOf(":");
    if (colon < 0) return null;
    const property = declaration.slice(0, colon).trim();
    const value = declaration
      .slice(colon + 1)
      .trim()
      .replace(/\s+/g, " ");
    if (property === "" || value === "") return null;
    if (CSS_WIDE.has(value)) return null;
    if (!declarationOk(property, value)) return null;
    load += declarationLoad(property, value);
  }
  return load;
}

function styleIsHarmless(style: string): boolean {
  return styleLoad(style) !== null;
}

/** The lowercase local part of an element or attribute name: `XHTML:Script` becomes `script`. */
function localName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1).toLowerCase();
}

const HIDING_CLASSES = new Set([
  "hidden",
  "sr-only",
  "invisible",
  "d-none",
  "display-none",
  "visually-hidden",
  "screen-reader-text",
]);

/**
 * Hiding signals. A stylesheet cannot be evaluated without rendering, so a class alone proves
 * nothing; only the common hiding utilities are recognised by name.
 */
function hiddenByAttributes(attribs: Readonly<Record<string, string>>): boolean {
  for (const [rawName, value] of Object.entries(attribs)) {
    const name = localName(rawName);
    if (name === "hidden" || name === "inert" || name === "popover" || name === "slot") return true;
    if (name === "aria-hidden" && value.trim().toLowerCase() !== "false") return true;
    if (name === "class") {
      for (const token of value.toLowerCase().split(/\s+/)) {
        if (HIDING_CLASSES.has(token)) return true;
      }
    }
    // A style too long to read is unreadable, and unreadable is hidden.
    if (name === "style" && (value.length > MAX_STYLE_CHARS || !styleIsHarmless(value)))
      return true;
  }
  return false;
}

function attributeValue(
  attribs: Readonly<Record<string, string>>,
  wanted: string,
): string | undefined {
  for (const [rawName, value] of Object.entries(attribs)) {
    if (localName(rawName) === wanted) return value;
  }
  return undefined;
}

// --- the sanitiser -----------------------------------------------------------------------------

interface Frame {
  readonly name: string;
  readonly hides: boolean;
  readonly preferred: boolean;
  /** Padding, margin and border pixels summed over this element and its ancestors. */
  readonly load: number;
  /** A details element without `open`: only its first summary shows. */
  readonly closedDetails?: boolean;
  summarySeen?: boolean;
  countedText?: boolean;
}

/** Raw-text and similar start tags that a browser ignores while a select is open. */
const RAW_TEXT_UNDER_SELECT = new Set([
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);

/** The sanitiser as an event sink: feed it open, close, text and comment events, then finish. */
export interface MarkupSink {
  open(name: string, attribs: Readonly<Record<string, string>>): void;
  /**
   * `implied` is true when the parser closed the element because another tag or the end of input
   * did (or because of a trailing slash, which `selfClosing` says: the close came straight from
   * the element's own start tag).
   */
  close(name: string, implied?: boolean, selfClosing?: boolean): void;
  text(data: string): void;
  comment(): void;
  /** The caller could not finish its parse: stop emitting, keep what was already decided. */
  abort(): void;
  /** True once the sink has stopped deciding: a caller can stop writing input. */
  done(): boolean;
  /** The caller cut the input short: the remainder is dropped and counted as a hidden block. */
  dropRemainder(): void;
  /**
   * The remainder the caller did not parse holds a second body or html start tag, which in a
   * browser merges its attributes into the document element: nothing already read can be
   * trusted, so everything is discarded, counted, and the output is flagged truncated.
   */
  discard(): void;
  finish(): HtmlToTextResult;
}

export interface MarkupSinkOptions {
  /**
   * XML events: every element has an explicit close and none is void, so `<img>text</img>`
   * hides its child text. HTML mode (the default) knows the void elements.
   */
  readonly xml?: boolean;
}

// --- implicit closes: where the parser's stack and a browser's may differ ---------------------------
//
// htmlparser2 keeps one stack of open elements and closes through it. A browser's tree builder
// differs in more ways than a list can name (formatting elements are re-opened, an end tag is
// ignored behind a special element or outside its scope, a form control or a table part has its
// own insertion mode, a quirks-mode table does not close a paragraph). So the filter does not
// try to model the browser. It records every frame closed implicitly (a run, ending at the next
// event) and then decides, conservatively, whether parser and browser certainly agree:
//
//   - a run ended by an END TAG for an outer element (the end tag popped through the run);
//   - a run ended by a START TAG (the new element closed what was open).
//
// If anything hidden is involved (a hidden element is open before the run, which includes the
// run's own frames and the element the end tag names) and the pair is not on the short list below
// where both trees are known to agree, the filter drops the remainder of the document and counts
// it. Dropping too much is a counted loss; showing what a reader never sees is the defect.

/** Elements a browser's end tag cannot reach across, or whose insertion mode ignores end tags. */
const NEVER_POPPED = new Set([
  "annotation-xml",
  "applet",
  "body",
  "button",
  "datalist",
  "desc",
  "form",
  "foreignobject",
  "frame",
  "frameset",
  "head",
  "html",
  "marquee",
  "math",
  "mi",
  "mn",
  "mo",
  "ms",
  "mtext",
  "noscript",
  "object",
  "optgroup",
  "option",
  "select",
  "svg",
  "table",
  "template",
  "textarea",
]);

/** Table parts: closed by the table rules, not the generic ones. */
const TABLE_PARTS = new Set(["caption", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr"]);

/**
 * End tags whose browser rule is "pop until this element", for elements that no start tag ever
 * closes in a browser. The others (a paragraph, a list item, a heading, a table part, a form
 * control) can be closed earlier by a start tag that htmlparser2 does not treat as closing, so
 * parser and browser may disagree on whether the end tag still has anything to close.
 */
const STABLE_POP_UNTIL_END_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "center",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "header",
  "hgroup",
  "main",
  "menu",
  "nav",
  "ol",
  "pre",
  "section",
  "summary",
  "ul",
]);

/** The HTML "special" category: an ordinary end tag is ignored when one lies between. */
const SPECIAL = new Set([
  "address",
  "applet",
  "area",
  "article",
  "aside",
  "base",
  "basefont",
  "bgsound",
  "blockquote",
  "body",
  "br",
  "button",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dir",
  "div",
  "dl",
  "dt",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "iframe",
  "img",
  "input",
  "keygen",
  "li",
  "link",
  "listing",
  "main",
  "marquee",
  "menu",
  "meta",
  "nav",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "ol",
  "p",
  "param",
  "plaintext",
  "pre",
  "script",
  "search",
  "section",
  "select",
  "source",
  "style",
  "summary",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul",
  "wbr",
  "xmp",
]);

/** Elements the browser's adoption-agency algorithm re-opens after a misnested end tag. */
const FORMATTING = new Set([
  "a",
  "b",
  "big",
  "code",
  "em",
  "font",
  "i",
  "nobr",
  "s",
  "small",
  "strike",
  "strong",
  "tt",
  "u",
]);

/** Start tags that close an open paragraph in parser and browser alike (not a quirks-mode table). */
const PARAGRAPH_CLOSERS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "ul",
]);

/**
 * HTML start tags that break out of svg or math content in a browser: the foreign element is
 * popped and the tag opens in HTML. So an HTML element inside svg that parser reports as closed
 * by the end of its svg may still be open in the browser, and a trailing slash does not close it.
 */
const FOREIGN_BREAKOUT = new Set([
  "b",
  "big",
  "blockquote",
  "body",
  "br",
  "center",
  "code",
  "dd",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "font",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "hr",
  "i",
  "img",
  "li",
  "listing",
  "menu",
  "meta",
  "nobr",
  "ol",
  "p",
  "pre",
  "ruby",
  "s",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "table",
  "tt",
  "u",
  "ul",
  "var",
]);

/** Start tags that make a browser close an open paragraph, and with it the formatting inside. */
const BROWSER_PARAGRAPH_CLOSERS = new Set([
  ...PARAGRAPH_CLOSERS,
  "center",
  "dd",
  "dir",
  "dt",
  "li",
  "listing",
  "menu",
  "plaintext",
  "summary",
  "table",
  "xmp",
]);

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** Insertion modes other than "in body": a table, a template or foreign content is open. */
const MODE_TRIGGERS = new Set([
  "colgroup",
  "math",
  "svg",
  "table",
  "tbody",
  "template",
  "tfoot",
  "thead",
  "tr",
]);

/** Inside these the insertion mode is back to the body rules (a cell, a caption). */
const MODE_RESETS = new Set(["applet", "caption", "marquee", "object", "td", "th"]);

type InsertionMode = "body" | "select" | "other";

/**
 * The innermost insertion mode that is not the body's. A start tag or an end tag then means
 * something else (a form or a paragraph start tag inside a table does not close what the body
 * rules say, and a select ignores nearly everything). `names` run from the innermost frame out.
 */
function insertionMode(names: Iterable<string>): InsertionMode {
  for (const name of names) {
    if (MODE_RESETS.has(name)) return "body";
    if (name === "select") return "select";
    if (MODE_TRIGGERS.has(name)) return "other";
  }
  return "body";
}

interface ClosedFrame {
  readonly name: string;
  readonly hides: boolean;
}

/**
 * A frame the parser closed because a start tag opened. True only for pairs where the browser
 * closes the same element: the same sibling kind, a block closing a paragraph, a body closing the
 * head. Anything else is not known to agree.
 */
function startTagClosesAlike(closed: string, opened: string): boolean {
  if (closed === "p") return PARAGRAPH_CLOSERS.has(opened);
  if (closed === "li") return opened === "li";
  if (closed === "dd" || closed === "dt") return opened === "dd" || opened === "dt";
  // Outside a select only an option is closed by an option or optgroup start tag.
  if (closed === "option") return opened === "option" || opened === "optgroup";
  if (closed === "head") return opened === "body";
  if (HEADINGS.has(closed)) return HEADINGS.has(opened);
  if (closed === "tr") return opened === "tr";
  if (closed === "td" || closed === "th") {
    return opened === "td" || opened === "th" || opened === "tr";
  }
  if (closed === "thead" || closed === "tbody") return opened === "tbody" || opened === "tfoot";
  return false;
}

/**
 * An end tag popped through `run` before closing `end`. True only when a browser pops exactly the
 * same elements and re-opens none of them as hidden.
 */
function endTagPopsAlike(end: string, run: readonly ClosedFrame[]): boolean {
  // The select insertion mode ignores most end tags, but its own end tag pops its options.
  if (end === "select") return run.every((f) => f.name === "option" || f.name === "optgroup");
  // `</body>` and `</html>` pop nothing in a browser; a paragraph, a list item, a heading, a table
  // part, a form control or a formatting element may already be closed there, and a formatting
  // end tag runs the adoption agency. None of these is known to agree with the parser.
  if (
    end === "body" ||
    end === "html" ||
    end === "table" ||
    NEVER_POPPED.has(end) ||
    TABLE_PARTS.has(end) ||
    FORMATTING.has(end) ||
    (SPECIAL.has(end) && !STABLE_POP_UNTIL_END_TAGS.has(end))
  ) {
    return false;
  }
  for (const frame of run) {
    if (NEVER_POPPED.has(frame.name) || TABLE_PARTS.has(frame.name)) return false;
    // A hidden formatting element popped by an end tag is re-opened, hidden, for the next text.
    if (frame.hides && FORMATTING.has(frame.name)) return false;
  }
  if (STABLE_POP_UNTIL_END_TAGS.has(end)) return true;
  // The generic end tag (span, label, an unknown element) is ignored behind a special element.
  return run.every((f) => !SPECIAL.has(f.name));
}

const MAX_SCRIPT_TRACK = 100_000;

/** True when a `<script` start follows a `<!--` in script text (linear: two indexOf scans). */
function isDoubleEscaped(text: string): boolean {
  const open = text.indexOf("<!--");
  if (open < 0) return false;
  for (let at = text.indexOf("<script", open + 4); at >= 0; at = text.indexOf("<script", at + 7)) {
    const next = text.charAt(at + 7);
    if (next === "/" || next === ">" || (next !== "" && /\s/.test(next))) return true;
  }
  return false;
}

export function createMarkupSink(options: MarkupSinkOptions = {}): MarkupSink {
  const xml = options.xml === true;
  const report = newReport();
  const frames: Frame[] = [];
  const all: string[] = [];
  const preferred: string[] = [];
  let allLength = 0;
  let preferredLength = 0;
  let hiddenDepth = 0;
  let preDepth = 0;
  let preferredDepth = 0;
  let preferredSeen = false;
  // Text was emitted outside every main/article subtree (counted if a region is preferred).
  let outsideSeen = false;
  let truncated = false;
  // Once set, nothing more is emitted or counted. Every "cannot decide" path ends here.
  let stopped = false;
  // Frames closed implicitly since the last event that was not an implied close, and whether
  // anything hidden was open before the first of them (see startTagClosesAlike).
  let run: ClosedFrame[] = [];
  let runHidden = false;
  let formattingPending = false;
  let formPending = false;
  // Open closed-details frames: content a browser keeps hidden until it is expanded, so a run of
  // implied closes inside one is hidden context for the misnest gates.
  let closedDetailsDepth = 0;
  // The whole document was wiped (and counted) already: a second discard counts nothing.
  let discarded = false;
  let scriptText = "";
  let nodes = 0;

  function emit(piece: string): void {
    if (allLength < COLLECT_CAP) {
      all.push(piece);
      allLength += piece.length;
    }
    if (preferredDepth > 0 && preferredLength < COLLECT_CAP) {
      preferred.push(piece);
      preferredLength += piece.length;
    }
    if (preferredDepth === 0 && piece.trim() !== "") outsideSeen = true;
  }

  /** Stop emitting for good: the filter cannot say what a reader would see from here on. */
  function failClosed(): void {
    stopped = true;
    truncated = true;
  }

  /** A cap was reached: drop everything from here on, count it once, and say the output is cut. */
  function dropRemainder(): void {
    if (stopped) return;
    report.hiddenBlocks += 1;
    failClosed();
  }

  function guard(action: () => void): void {
    if (stopped) return;
    try {
      action();
    } catch {
      failClosed();
    }
  }

  /** After a stop: a body or html start tag that hides still hides everything read before. */
  function lateDocumentTag(rawName: string, attribs: Readonly<Record<string, string>>): void {
    try {
      const name = localName(rawName);
      if ((name === "body" || name === "html") && hiddenByAttributes(attribs)) {
        discardDocument();
      }
    } catch {
      // Already stopped: nothing more to decide.
    }
  }

  function wipeDocument(): void {
    all.length = 0;
    preferred.length = 0;
    allLength = 0;
    preferredLength = 0;
    stopped = true;
    truncated = true;
  }

  /** Drop the whole document's text, count it once, flag it truncated. */
  function discardDocument(): void {
    if (!discarded) report.hiddenBlocks += 1;
    discarded = true;
    wipeDocument();
  }

  /** True when `targets` is open with a formatting element above it (a browser closes both). */
  function holdsFormattingUnder(targets: readonly string[]): boolean {
    let formattingSeen = false;
    for (let at = frames.length - 1; at >= 0; at -= 1) {
      const name = frames[at]?.name ?? "";
      if (targets.includes(name)) return formattingSeen;
      if (FORMATTING.has(name)) formattingSeen = true;
    }
    return false;
  }

  /** A start tag ended the run of implied closes: do parser and browser close the same things? */
  function settleRun(opened: string): void {
    if (run.length === 0) return;
    const closed = run;
    run = [];
    if (!runHidden) return;
    const names = [...closed.map((f) => f.name), ...frames.map((f) => f.name).reverse()];
    // A formatting element re-opened inside the hidden frame is what the browser would be
    // looking at (not the frame itself), and a form start tag is ignored while a form closed
    // implicitly still counts as the browser's current form: neither is modelled, so neither is
    // trusted.
    const mode = insertionMode(names);
    const selectPair =
      mode === "select" &&
      closed.every((f) => f.name === "option") &&
      (opened === "option" || opened === "optgroup");
    if (
      formattingPending ||
      (opened === "form" && formPending) ||
      mode === "other" ||
      (mode === "select" && !selectPair) ||
      !closed.every((f) => startTagClosesAlike(f.name, opened))
    ) {
      dropRemainder();
    }
  }

  function onOpen(rawName: string, attribs: Readonly<Record<string, string>>): void {
    const name = localName(rawName);
    // A browser ignores these start tags inside a select, but the parser switches to raw text and
    // swallows what follows (end tags, hiding start tags, a document tag): the whole page goes.
    // (A textarea start tag has already closed the select in the parser's stack: see `run`.)
    if (
      !stopped &&
      !xml &&
      RAW_TEXT_UNDER_SELECT.has(name) &&
      (frames.some((frame) => frame.name === "select") ||
        run.some((frame) => frame.name === "select"))
    ) {
      run = [];
      discardDocument();
      return;
    }
    settleRun(name);
    if (stopped) {
      lateDocumentTag(rawName, attribs);
      return;
    }
    // A browser closes an open paragraph, list item or definition at some start tags where the
    // parser does not (it only closes the element on top), popping the formatting elements
    // between; those stay in the active formatting list and are re-opened by the next text.
    if (BROWSER_PARAGRAPH_CLOSERS.has(name) && holdsFormattingUnder(["p"]))
      formattingPending = true;
    if (name === "li" && holdsFormattingUnder(["li"])) formattingPending = true;
    if ((name === "dd" || name === "dt") && holdsFormattingUnder(["dd", "dt"])) {
      formattingPending = true;
    }
    const isVoid = !xml && VOID_ELEMENTS.has(name);
    nodes += 1;
    if ((!isVoid && frames.length >= MAX_DEPTH) || nodes > MAX_NODES) {
      dropRemainder();
      return;
    }

    let hides = false;
    let counted: "hiddenBlocks" | "mediaDropped" | "linksDropped" | null = null;
    // Inside a closed details only the first summary shows until the reader expands it.
    const parent = frames[frames.length - 1];
    // The padding, margin and border pixels of this element and everything above it.
    const styleText = attributeValue(attribs, "style");
    const ownLoad =
      (parent?.load ?? 0) + (styleText === undefined ? 0 : (styleLoad(styleText) ?? 0));
    // Only a body or html tag's OWN hiding attributes wipe the document, not hiding it inherits.
    const ownHides = (name === "body" || name === "html") && hiddenByAttributes(attribs);
    let hiddenByDetails = false;
    if (parent?.closedDetails === true) {
      if (name === "summary" && parent.summarySeen !== true) parent.summarySeen = true;
      else hiddenByDetails = true;
    }
    if (hiddenByDetails) {
      hides = true;
      counted = "hiddenBlocks";
    } else if (name === "script") {
      report.scripts += 1;
      hides = true;
    } else if (name === "style") {
      report.styles += 1;
      hides = true;
    } else if (name === "plaintext") {
      // Everything after a plaintext start tag is its text: nothing more is decided.
      hides = true;
      counted = "hiddenBlocks";
    } else if (hiddenByAttributes(attribs) || ownLoad > MAX_STYLE_LOAD) {
      hides = true;
      counted = "hiddenBlocks";
    } else if (
      name === "input" &&
      (attributeValue(attribs, "type") ?? "").trim().toLowerCase() === "hidden"
    ) {
      hides = true;
      counted = "hiddenBlocks";
    } else if (SILENT_HIDDEN.has(name)) {
      hides = true;
    } else if (HIDDEN_CONTAINERS.has(name)) {
      hides = true;
      counted = "hiddenBlocks";
    } else if (MEDIA.has(name)) {
      hides = true;
      counted = "mediaDropped";
    } else if (!CONTENT_ELEMENTS.has(name)) {
      // Not known content: the whole subtree is dropped (an unknown void element has none).
      hides = true;
      if (!isVoid) counted = "hiddenBlocks";
    } else if (name === "a" && attributeValue(attribs, "href") !== undefined) {
      counted = "linksDropped";
    }
    if (counted !== null && hiddenDepth === 0) report[counted] += 1;

    if (name === "plaintext") {
      stopped = true;
      return;
    }
    if (ownHides) {
      // A later body or html start tag merges its attributes into the first one: the whole
      // document is hidden, including what was emitted before. (Counted above.)
      discarded = true;
      wipeDocument();
      return;
    }

    if (BLOCK.has(name)) emit("\n");
    if (isVoid) return;

    const isPreferred = (name === "main" || name === "article") && hiddenDepth === 0 && !hides;
    frames.push({
      name,
      hides,
      preferred: isPreferred,
      load: ownLoad,
      ...(name === "details" && attributeValue(attribs, "open") === undefined
        ? { closedDetails: true }
        : {}),
    });
    if (name === "script") scriptText = "";
    if (name === "details" && attributeValue(attribs, "open") === undefined) {
      closedDetailsDepth += 1;
    }
    if (hides) hiddenDepth += 1;
    if (name === "pre") preDepth += 1;
    if (isPreferred) {
      preferredDepth += 1;
      preferredSeen = true;
    }
  }

  function onClose(rawName: string, implied: boolean, selfClosing: boolean): void {
    const name = localName(rawName);
    if (!xml && VOID_ELEMENTS.has(name)) return;
    // Only the frame on top can be closed, and only by its own name. A stray close is ignored.
    const top = frames[frames.length - 1];
    if (top === undefined || top.name !== name) return;
    if (run.length === 0) runHidden = hiddenDepth > 0 || closedDetailsDepth > 0;
    if (top.closedDetails === true) closedDetailsDepth -= 1;
    // A trailing slash closes the element in XML and inside svg/math, except that an HTML tag
    // inside svg/math breaks out of it in a browser and the slash is then ignored.
    const selfClosed = implied && selfClosing && (xml || !FOREIGN_BREAKOUT.has(top.name));
    frames.pop();
    if (top.hides) hiddenDepth -= 1;
    if (top.name === "pre") preDepth -= 1;
    if (BLOCK.has(top.name)) emit("\n");
    else if (CELL.has(top.name)) emit(" ");
    if (top.preferred) preferredDepth -= 1;

    if (top.name === "script" && isDoubleEscaped(scriptText)) {
      // A double-escaped script ends only at its second end tag; the parser ended it at the first.
      failClosed();
      return;
    }
    if (implied && !selfClosed) {
      // A formatting element closed this way stays in a browser's list of active formatting
      // elements and is re-opened by the next text.
      if (FORMATTING.has(top.name)) formattingPending = true;
      if (top.name === "form") formPending = true;
      run.push({ name: top.name, hides: top.hides });
      return;
    }
    // An explicit end tag that popped through other frames: a browser may ignore it, pop less,
    // or re-open what it popped. If anything hidden is involved and the two are not known to
    // agree, nothing more can be decided.
    const popped = run;
    run = [];
    if (popped.length > 0 && runHidden) {
      const names = [
        ...popped.map((f) => f.name),
        top.name,
        ...frames.map((f) => f.name).reverse(),
      ];
      const mode = insertionMode(names);
      const selectPair =
        top.name === "select" && popped.every((f) => f.name === "option" || f.name === "optgroup");
      if (
        mode === "other" ||
        (mode === "select" && !selectPair) ||
        !endTagPopsAlike(top.name, popped)
      ) {
        dropRemainder();
      }
    }
    // `</form>` removes the form from the browser's stack without closing what it holds. A
    // formatting element closed earlier is re-opened inside the form by the next text and stays
    // open after it, so the form's hiding would outlive the end tag there.
    if (top.name === "form" && top.hides && formattingPending) dropRemainder();
    // A formatting end tag is consumed by the nearest entry of that name in the browser's list of
    // active formatting elements, which may be one that was closed earlier; the element that
    // hides then stays open there.
    if (FORMATTING.has(top.name) && top.hides && formattingPending) dropRemainder();
  }

  function onText(data: string): void {
    settleRun("");
    const top = frames[frames.length - 1];
    if (top?.closedDetails === true && hiddenDepth === 0) {
      // Text directly inside a closed details is hidden until it is expanded.
      if (data.trim() !== "" && top.countedText !== true) {
        top.countedText = true;
        report.hiddenBlocks += 1;
      }
      return;
    }
    if (hiddenDepth > 0) {
      if (frames[frames.length - 1]?.name === "script" && scriptText.length < MAX_SCRIPT_TRACK) {
        scriptText += data.toLowerCase();
      }
      return;
    }
    const stripped = stripUnsafeChars(data);
    report.controlChars += stripped.removed;
    const piece =
      preDepth > 0
        ? stripped.text.replace(/\r\n|\r/g, "\n").replace(/[^\S\n]+/g, " ")
        : stripped.text.replace(/\s+/g, " ");
    if (piece !== "") emit(piece);
  }

  return {
    open: (name, attribs) => {
      if (stopped) {
        lateDocumentTag(name, attribs);
        return;
      }
      guard(() => onOpen(name, attribs));
    },
    close: (name, implied = false, selfClosing = false) =>
      guard(() => onClose(name, implied, selfClosing)),
    text: (data) => guard(() => onText(data)),
    comment: () =>
      guard(() => {
        settleRun("");
        report.comments += 1;
      }),
    abort: failClosed,
    done: () => stopped,
    discard: discardDocument,
    dropRemainder: () => {
      try {
        dropRemainder();
      } catch {
        failClosed();
      }
    },

    finish() {
      const preferredText = preferred.join("");
      const usePreferred = preferredSeen && preferredText.trim() !== "";
      // Text outside the preferred region is dropped; it is counted as one hidden block.
      if (usePreferred && outsideSeen) report.hiddenBlocks += 1;
      const chosen = usePreferred ? preferredText : all.join("");
      let text = chosen
        .split("\n")
        .map((line) => line.replace(/[ \t]+/g, " ").trim())
        .filter((line) => line !== "")
        .join("\n");
      let cut = truncated;
      if (text.length > MAX_PAGE_CHARS) {
        text = truncateAtBoundary(text, MAX_PAGE_CHARS).trimEnd();
        cut = true;
      }
      report.commandLikeLines = countCommandLikeLines(text);
      return { text, report, truncated: cut };
    },
  };
}

/** Input is handed to a parser in pieces of about this many characters. */
export const WRITE_CHUNK_CHARS = 4_096;

/**
 * Hands `input` to `write` in pieces of about WRITE_CHUNK_CHARS characters (never splitting a
 * surrogate pair) and stops as soon as `stop()` is true. Returns how many characters were written.
 */
export function writeInChunks(
  write: (chunk: string) => void,
  input: string,
  stop: () => boolean,
): number {
  let at = 0;
  while (at < input.length && !stop()) {
    let end = Math.min(at + WRITE_CHUNK_CHARS, input.length);
    const last = input.charCodeAt(end - 1);
    if (end < input.length && last >= 0xd800 && last <= 0xdbff) end += 1;
    write(input.slice(at, end));
    at = end;
  }
  return at;
}

/** A body or html start tag (case-insensitive), as the HTML tokenizer would see it. */
const DOCUMENT_TAG = /<(?:body|html|frameset)/i;

/**
 * Constructs where htmlparser2 and a browser disagree in ways that are not worth emulating: a
 * marked section (`<![CDATA[`), frames, plaintext, xmp, svg, math and annotation-xml. A document
 * holding one is not read at all: its text is empty, counted once, and flagged truncated. (Plain
 * script, style, noscript and template are handled by the sink and stay as they were.)
 */
const WHOLE_DOCUMENT_GATE = /<!\[|<(?:frame|plaintext|xmp|math|svg|noscript)|annotation-xml/i;

export function htmlToText(html: string): HtmlToTextResult {
  const sink = createMarkupSink();
  if (WHOLE_DOCUMENT_GATE.test(html)) {
    sink.discard();
    return sink.finish();
  }
  let inCdata = false;
  let lastOpenStart = -1;
  // Where in the input the sink stopped: what follows may hold a document tag the parser
  // swallowed as raw text, so the scan for one starts here.
  let stopIndex = -1;
  const markStop = (): void => {
    if (stopIndex < 0 && sink.done()) stopIndex = Math.max(0, parser.startIndex);
  };
  // A browser-like HTML parse, not XML: entities decode once, tag and attribute names are
  // lowercased, a self-closing slash is ignored (`<script/>` opens a script), and the raw-text
  // elements (script, style, textarea, title, xmp, iframe, noembed, noframes) keep their content
  // as text.
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        lastOpenStart = parser.startIndex;
        sink.open(name, attribs);
        markStop();
      },
      onclosetag(name, isImplied) {
        // A close that carries its own start tag's position came from a trailing slash.
        sink.close(name, isImplied, parser.startIndex === lastOpenStart);
        markStop();
      },
      ontext(data) {
        if (!inCdata) sink.text(data);
        markStop();
      },
      oncomment() {
        sink.comment();
        markStop();
      },
      onprocessinginstruction(name) {
        if (name.toLowerCase() !== "!doctype") sink.comment();
        markStop();
      },
      oncdatastart() {
        sink.comment();
        inCdata = true;
        markStop();
      },
      oncdataend() {
        inCdata = false;
      },
    },
    {
      xmlMode: false,
      decodeEntities: true,
      lowerCaseTags: true,
      lowerCaseAttributeNames: true,
      recognizeSelfClosing: false,
      recognizeCDATA: false,
    },
  );
  // An input past the cap is cut here, before any parsing; the cut-off remainder is counted.
  const input = html.length > MAX_INPUT_CHARS ? truncateAtBoundary(html, MAX_INPUT_CHARS) : html;
  let written = 0;
  try {
    // Small pieces, and no more once the sink has stopped: htmlparser2 keeps building its element
    // stack for whatever it is given, at a cost that grows with the square of the depth, so the
    // parser must not be handed input nobody will read.
    written = writeInChunks(
      (chunk) => parser.write(chunk),
      input,
      () => sink.done(),
    );
    if (written === input.length && !sink.done()) parser.end();
  } catch {
    // Half a parse is not a decision: keep what was already decided and say it was cut.
    sink.abort();
  }
  if (input.length < html.length) sink.dropRemainder();
  // What was never parsed (a cap, or the sink stopped) may still carry a document-level tag, and
  // so may the tail the tokenizer was holding: a tag cut by the write boundary (`<bo` | `dy
  // hidden>`) never completed. The scan starts at the last `<` before the boundary.
  if (sink.done() || written < html.length) {
    const tail = html.lastIndexOf("<", Math.max(0, written - 1));
    const tailStart = tail < 0 ? written : Math.min(tail, written);
    const from = stopIndex >= 0 ? Math.min(tailStart, stopIndex) : tailStart;
    if (DOCUMENT_TAG.test(html.slice(from))) sink.discard();
  }
  return sink.finish();
}
