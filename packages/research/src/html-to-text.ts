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
/** A style attribute longer than this is not pattern-matched. */
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
  "object",
  "picture",
  "select",
  "source",
  "svg",
  "textarea",
  "track",
  "video",
]);

// --- inline style evaluation -------------------------------------------------------------------

const ZERO_NUMBER = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/;

function isZero(value: string): boolean {
  const match = ZERO_NUMBER.exec(value);
  return match !== null && Number.parseFloat(match[1] ?? "") === 0;
}

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

/** A large negative offset that puts the box far outside the viewport. */
function isOffScreen(value: string): boolean {
  const match = /^-\s*(\d+\.?\d*|\.\d+)\s*([a-z%]*)$/.exec(value);
  if (match === null) return false;
  const size = Number.parseFloat(match[1] ?? "");
  const unit = match[2] ?? "";
  const threshold = unit === "em" || unit === "rem" || unit === "vw" || unit === "vh" ? 100 : 1_000;
  return size >= threshold;
}

function styleHides(style: string): boolean {
  const cleaned = style.replace(/\/\*[\s\S]*?\*\//g, "").toLowerCase();
  for (const declaration of cleaned.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim();
    const value = declaration
      .slice(colon + 1)
      .replace(/!\s*important/g, "")
      .trim();
    if (property === "display" && value === "none") return true;
    if (property === "visibility" && (value === "hidden" || value === "collapse")) return true;
    if (property === "opacity" && isZero(value)) return true;
    if (property === "font-size" && isZero(value)) return true;
    if (property === "color" && value === "transparent") return true;
    if (OFFSET_PROPERTIES.has(property) && isOffScreen(value)) return true;
  }
  return false;
}

function hiddenByAttributes(attribs: Readonly<Record<string, string>>): boolean {
  if (attribs.hidden !== undefined) return true;
  const aria = attribs["aria-hidden"];
  if (aria !== undefined && aria.trim().toLowerCase() === "true") return true;
  const style = attribs.style;
  return style !== undefined && style.length <= MAX_STYLE_CHARS && styleHides(style);
}

// --- the sanitiser -----------------------------------------------------------------------------

interface Frame {
  readonly name: string;
  readonly hides: boolean;
  readonly preferred: boolean;
}

export function htmlToText(html: string): HtmlToTextResult {
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
  let stopped = false;
  let inCdata = false;

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

  const parser = new Parser({
    onopentag(name, attribs) {
      if (stopped) return;
      const isVoid = VOID_ELEMENTS.has(name);
      if (!isVoid && frames.length >= MAX_DEPTH) {
        truncated = true;
        stopped = true;
        return;
      }

      let hides = false;
      let counted: "hiddenBlocks" | "mediaDropped" | "linksDropped" | null = null;
      if (name === "script") {
        report.scripts += 1;
        hides = true;
      } else if (name === "style") {
        report.styles += 1;
        hides = true;
      } else if (hiddenByAttributes(attribs)) {
        hides = true;
        counted = "hiddenBlocks";
      } else if (name === "input" && (attribs.type ?? "").trim().toLowerCase() === "hidden") {
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
      } else if (name === "a" && attribs.href !== undefined) {
        counted = "linksDropped";
      }
      if (counted !== null && hiddenDepth === 0) report[counted] += 1;

      if (BLOCK.has(name)) emit("\n");
      if (isVoid) return;

      const isPreferred = (name === "main" || name === "article") && hiddenDepth === 0 && !hides;
      frames.push({ name, hides, preferred: isPreferred });
      if (hides) hiddenDepth += 1;
      if (name === "pre") preDepth += 1;
      if (isPreferred) {
        preferredDepth += 1;
        preferredSeen = true;
      }
    },

    onclosetag(name) {
      if (stopped || VOID_ELEMENTS.has(name)) return;
      const frame = frames.pop();
      if (frame === undefined) return;
      if (frame.hides) hiddenDepth -= 1;
      if (frame.name === "pre") preDepth -= 1;
      if (BLOCK.has(frame.name)) emit("\n");
      else if (CELL.has(frame.name)) emit(" ");
      if (frame.preferred) preferredDepth -= 1;
    },

    ontext(data) {
      if (stopped || inCdata || hiddenDepth > 0) return;
      const stripped = stripUnsafeChars(data);
      report.controlChars += stripped.removed;
      const piece =
        preDepth > 0
          ? stripped.text.replace(/\r\n|\r/g, "\n").replace(/[^\S\n]+/g, " ")
          : stripped.text.replace(/\s+/g, " ");
      if (piece !== "") emit(piece);
    },

    oncomment() {
      if (!stopped) report.comments += 1;
    },

    oncdatastart() {
      if (stopped) return;
      report.comments += 1;
      inCdata = true;
    },

    oncdataend() {
      inCdata = false;
    },
  });
  parser.write(html);
  parser.end();

  const preferredText = preferred.join("");
  const chosen = preferredSeen && preferredText.trim() !== "" ? preferredText : all.join("");
  let text = chosen
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
  if (text.length > MAX_PAGE_CHARS) {
    text = truncateAtBoundary(text, MAX_PAGE_CHARS).trimEnd();
    truncated = true;
  }
  report.commandLikeLines = countCommandLikeLines(text);
  return { text, report, truncated };
}
