// The streaming HTML sanitiser (D-06, D-26, RSRCH-08, research Pattern 2).
//
// A callback pass over htmlparser2 that never builds a tree. A stack of frames mirrors the
// parser's own element stack (implied closes arrive as onclosetag calls, void elements are never
// pushed), and `hiddenDepth` counts the open frames that hide their content, so text is emitted
// only while it is zero. Output is plain text: no attribute value is ever read into it (href,
// src and alt are never emitted), block elements are separated by newlines on open and close, and
// every removal is counted into the eight keys of SANITISE_REPORT_KEYS.
//
// What is dropped: script, style, template, noscript, textarea, comments and CDATA; elements
// hidden by the `hidden` or `aria-hidden` attributes, by `type=hidden` inputs or by an inline
// style (display none, visibility hidden, opacity 0, font-size 0, an off-screen offset, a
// transparent colour); media, embeds and form controls; the head. A main or article subtree is
// preferred when one is visible. Control and format characters are removed from text and counted.
//
// Honest limit: CSS delivered by a stylesheet or a class cannot be evaluated without rendering,
// so text hidden that way survives. The defence for that residue is the source delimiter and the
// tool-less summariser, not detection.
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

// --- inline style evaluation -------------------------------------------------------------------

const CSS_WIDE = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);

const DISPLAY_VISIBLE = new Set([
  "block",
  "inline",
  "inline-block",
  "flex",
  "inline-flex",
  "grid",
  "inline-grid",
  "table",
  "inline-table",
  "table-row",
  "table-cell",
  "table-row-group",
  "table-header-group",
  "table-footer-group",
  "table-column",
  "table-column-group",
  "table-caption",
  "list-item",
  "contents",
  "flow",
  "flow-root",
  "run-in",
  "ruby",
  "ruby-base",
  "ruby-text",
  "ruby-base-container",
  "ruby-text-container",
]);

const FONT_SIZE_KEYWORDS = new Set([
  "xx-small",
  "x-small",
  "small",
  "medium",
  "large",
  "x-large",
  "xx-large",
  "xxx-large",
  "smaller",
  "larger",
  "math",
]);

const LENGTH_UNITS = new Set([
  "px",
  "em",
  "rem",
  "pt",
  "pc",
  "cm",
  "mm",
  "in",
  "q",
  "ex",
  "ch",
  "vw",
  "vh",
  "vmin",
  "vmax",
  "%",
  "lh",
  "rlh",
  "cap",
  "ic",
  "svw",
  "svh",
  "lvw",
  "lvh",
  "dvw",
  "dvh",
]);

const OFFSET_PROPERTIES = new Set([
  "left",
  "right",
  "top",
  "bottom",
  "text-indent",
  "margin-left",
  "margin-top",
  "margin-inline-start",
]);

const LENGTH = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/;
const NUMBER_OR_PERCENT = /^[+-]?(?:\d+\.?\d*|\.\d+)%?$/;

interface Length {
  readonly size: number;
  readonly unit: string;
}

/** A length the filter can read: a number with a known unit, or a bare zero. Otherwise null. */
function parseLength(value: string): Length | null {
  const match = LENGTH.exec(value);
  if (match === null) return null;
  const size = Number.parseFloat(match[1] ?? "");
  const unit = match[2] ?? "";
  if (unit === "") return size === 0 ? { size, unit } : null;
  return LENGTH_UNITS.has(unit) ? { size, unit } : null;
}

/** A large negative offset that puts the box far outside the viewport. */
function farOffScreen(length: Length): boolean {
  if (length.size >= 0) return false;
  const distance = -length.size;
  const threshold = ["em", "rem", "vw", "vh", "%"].includes(length.unit) ? 100 : 1_000;
  return distance >= threshold;
}

function transparentColour(value: string): boolean {
  if (value === "transparent") return true;
  const match = /^(?:rgba?|hsla?)\((.*)\)$/.exec(value);
  if (match === null) return false;
  const args = (match[1] ?? "").split(/[\s,/]+/).filter((part) => part !== "");
  const alpha = args[3];
  return (
    args.length === 4 &&
    alpha !== undefined &&
    NUMBER_OR_PERCENT.test(alpha) &&
    Number.parseFloat(alpha) === 0
  );
}

/**
 * True when the style hides the element OR cannot be read. A value that is not plainly visible
 * (a variable, a calc, an unknown keyword or unit, a CSS escape) is treated as hidden: the cost
 * of a wrong guess is a dropped, counted block, not a hidden instruction reaching the model.
 */
function styleHides(style: string): boolean {
  // CSS escapes (\6e for n) cannot be evaluated without a CSS parser.
  if (style.includes("\\")) return true;
  const cleaned = style.replace(/\/\*[\s\S]*?\*\//g, "").toLowerCase();
  for (const declaration of cleaned.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim();
    const value = declaration
      .slice(colon + 1)
      .replace(/!\s*important/g, "")
      .trim();
    if (value === "") continue;
    if (property === "display") {
      if (value === "none") return true;
      const tokens = value.split(/\s+/);
      if (!tokens.every((token) => DISPLAY_VISIBLE.has(token) || CSS_WIDE.has(token))) return true;
    } else if (property === "visibility") {
      if (!(value === "visible" || CSS_WIDE.has(value))) return true;
    } else if (property === "opacity") {
      if (CSS_WIDE.has(value)) continue;
      if (!NUMBER_OR_PERCENT.test(value) || Number.parseFloat(value) === 0) return true;
    } else if (property === "font-size") {
      if (CSS_WIDE.has(value) || FONT_SIZE_KEYWORDS.has(value)) continue;
      const length = parseLength(value);
      if (length === null || length.size === 0) return true;
    } else if (property === "color") {
      if (transparentColour(value)) return true;
    } else if (OFFSET_PROPERTIES.has(property)) {
      if (CSS_WIDE.has(value) || value === "auto") continue;
      const length = parseLength(value);
      if (length === null || farOffScreen(length)) return true;
    }
  }
  return false;
}

/** The lowercase local part of an element or attribute name: `XHTML:Script` becomes `script`. */
function localName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1).toLowerCase();
}

function hiddenByAttributes(attribs: Readonly<Record<string, string>>): boolean {
  for (const [rawName, value] of Object.entries(attribs)) {
    const name = localName(rawName);
    if (name === "hidden") return true;
    if (name === "aria-hidden" && value.trim().toLowerCase() === "true") return true;
    // A style too long to read is unreadable, and unreadable is hidden.
    if (name === "style" && (value.length > MAX_STYLE_CHARS || styleHides(value))) return true;
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
}

/** The sanitiser as an event sink: feed it open, close, text and comment events, then finish. */
export interface MarkupSink {
  open(name: string, attribs: Readonly<Record<string, string>>): void;
  /** `implied` is true when the parser closed the element because another tag or the end of input did. */
  close(name: string, implied?: boolean): void;
  text(data: string): void;
  comment(): void;
  /** The caller could not finish its parse: stop emitting, keep what was already decided. */
  abort(): void;
  /** The caller cut the input short: the remainder is dropped and counted as a hidden block. */
  dropRemainder(): void;
  finish(): HtmlToTextResult;
}

export interface MarkupSinkOptions {
  /**
   * XML events: every element has an explicit close and none is void, so `<img>text</img>`
   * hides its child text. HTML mode (the default) knows the void elements.
   */
  readonly xml?: boolean;
}

// Elements an end tag cannot reach across: when the browser meets `</div>` with one of these
// between the current node and the div, it ignores the end tag, but htmlparser2 closes them all.
const SCOPE_BOUNDARY = new Set([
  "applet",
  "caption",
  "html",
  "marquee",
  "object",
  "table",
  "td",
  "template",
  "th",
]);

/** Table structure elements are closed by their own scoping rules, not the generic one. */
const TABLE_STRUCTURE = new Set([
  "caption",
  "col",
  "colgroup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
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

const MAX_SCRIPT_TRACK = 100_000;

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
  let truncated = false;
  // Once set, nothing more is emitted or counted. Every "cannot decide" path ends here.
  let stopped = false;
  // Implied closes since the last open or explicit close, for the browser/parser differentials.
  let crossedBoundary = false;
  let closedHidden = false;
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

  function wipeDocument(): void {
    all.length = 0;
    preferred.length = 0;
    allLength = 0;
    preferredLength = 0;
    stopped = true;
  }

  function onOpen(rawName: string, attribs: Readonly<Record<string, string>>): void {
    const name = localName(rawName);
    const isVoid = !xml && VOID_ELEMENTS.has(name);
    nodes += 1;
    if ((!isVoid && frames.length >= MAX_DEPTH) || nodes > MAX_NODES) {
      dropRemainder();
      return;
    }
    crossedBoundary = false;
    closedHidden = false;

    let hides = false;
    let counted: "hiddenBlocks" | "mediaDropped" | "linksDropped" | null = null;
    if (name === "script") {
      report.scripts += 1;
      hides = true;
    } else if (name === "style") {
      report.styles += 1;
      hides = true;
    } else if (name === "plaintext") {
      // Everything after a plaintext start tag is its text: nothing more is decided.
      hides = true;
      counted = "hiddenBlocks";
    } else if (hiddenByAttributes(attribs)) {
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
    } else if (name === "a" && attributeValue(attribs, "href") !== undefined) {
      counted = "linksDropped";
    }
    if (counted !== null && hiddenDepth === 0) report[counted] += 1;

    if (name === "plaintext") {
      stopped = true;
      return;
    }
    if ((name === "body" || name === "html") && hides && counted === "hiddenBlocks") {
      // A later body or html start tag merges its attributes into the first one: the whole
      // document is hidden, including what was emitted before.
      wipeDocument();
      return;
    }

    if (BLOCK.has(name)) emit("\n");
    if (isVoid) return;

    const isPreferred = (name === "main" || name === "article") && hiddenDepth === 0 && !hides;
    frames.push({ name, hides, preferred: isPreferred });
    if (name === "script") scriptText = "";
    if (hides) hiddenDepth += 1;
    if (name === "pre") preDepth += 1;
    if (isPreferred) {
      preferredDepth += 1;
      preferredSeen = true;
    }
  }

  function onClose(rawName: string, implied: boolean): void {
    const name = localName(rawName);
    if (!xml && VOID_ELEMENTS.has(name)) return;
    // Only the frame on top can be closed, and only by its own name. A stray close is ignored.
    const top = frames[frames.length - 1];
    if (top === undefined || top.name !== name) return;
    frames.pop();
    if (top.hides) hiddenDepth -= 1;
    if (top.name === "pre") preDepth -= 1;
    if (BLOCK.has(top.name)) emit("\n");
    else if (CELL.has(top.name)) emit(" ");
    if (top.preferred) preferredDepth -= 1;

    if (top.name === "script" && /<!--[\s\S]*?<script[\s/>]/.test(scriptText)) {
      // A double-escaped script ends only at its second end tag; the parser ended it at the first.
      failClosed();
      return;
    }
    if (implied) {
      if (SCOPE_BOUNDARY.has(top.name)) crossedBoundary = true;
      if (top.hides) closedHidden = true;
      return;
    }
    // An explicit end tag that, in a browser, would be ignored (it reaches across a scope
    // boundary) or would re-open a formatting element leaves hidden content open there but
    // closed here. If hiding is involved, nothing more can be decided.
    const crossing = crossedBoundary && !TABLE_STRUCTURE.has(top.name);
    const reopening = FORMATTING.has(top.name) && closedHidden;
    if ((crossing || reopening) && (top.hides || hiddenDepth > 0 || closedHidden)) failClosed();
    crossedBoundary = false;
    closedHidden = false;
  }

  function onText(data: string): void {
    if (hiddenDepth > 0) {
      if (frames[frames.length - 1]?.name === "script" && scriptText.length < MAX_SCRIPT_TRACK) {
        scriptText += data.toLowerCase();
      }
      return;
    }
    crossedBoundary = false;
    closedHidden = false;
    const stripped = stripUnsafeChars(data);
    report.controlChars += stripped.removed;
    const piece =
      preDepth > 0
        ? stripped.text.replace(/\r\n|\r/g, "\n").replace(/[^\S\n]+/g, " ")
        : stripped.text.replace(/\s+/g, " ");
    if (piece !== "") emit(piece);
  }

  return {
    open: (name, attribs) => guard(() => onOpen(name, attribs)),
    close: (name, implied = false) => guard(() => onClose(name, implied)),
    text: (data) => guard(() => onText(data)),
    comment: () =>
      guard(() => {
        report.comments += 1;
      }),
    abort: failClosed,
    dropRemainder: () => {
      try {
        dropRemainder();
      } catch {
        failClosed();
      }
    },

    finish() {
      const preferredText = preferred.join("");
      const chosen = preferredSeen && preferredText.trim() !== "" ? preferredText : all.join("");
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

export function htmlToText(html: string): HtmlToTextResult {
  const sink = createMarkupSink();
  let inCdata = false;
  // A browser-like HTML parse, not XML: entities decode once, tag and attribute names are
  // lowercased, a self-closing slash is ignored (`<script/>` opens a script), and the raw-text
  // elements (script, style, textarea, title, xmp, iframe, noembed, noframes) keep their content
  // as text.
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        sink.open(name, attribs);
      },
      onclosetag(name, isImplied) {
        sink.close(name, isImplied);
      },
      ontext(data) {
        if (!inCdata) sink.text(data);
      },
      oncomment() {
        sink.comment();
      },
      onprocessinginstruction(name) {
        if (name.toLowerCase() !== "!doctype") sink.comment();
      },
      oncdatastart() {
        sink.comment();
        inCdata = true;
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
  try {
    parser.write(input);
    parser.end();
  } catch {
    // Half a parse is not a decision: keep what was already decided and say it was cut.
    sink.abort();
  }
  if (input.length < html.length) sink.dropRemainder();
  return sink.finish();
}
