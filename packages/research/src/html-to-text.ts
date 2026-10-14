// The streaming HTML sanitiser (D-06, RSRCH-08). This is the tracer skeleton: it drives a
// callback parse, never builds a tree, keeps text only, drops script and style subtrees and
// separates block elements with newlines. The hidden-content rules, the drop lists, the counts
// and the size limits arrive in the next task.

import { Parser } from "htmlparser2";

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

export interface HtmlToTextResult {
  readonly text: string;
  readonly report: SanitiseReport;
  readonly truncated: boolean;
}

export function emptyReport(): SanitiseReport {
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

const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
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
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tr",
  "ul",
]);

export function htmlToText(html: string): HtmlToTextResult {
  const parts: string[] = [];
  const dropped: string[] = [];
  const parser = new Parser({
    onopentag(name) {
      if (name === "script" || name === "style") dropped.push(name);
      if (BLOCK.has(name)) parts.push("\n");
    },
    onclosetag(name) {
      if (dropped.length > 0 && dropped[dropped.length - 1] === name) dropped.pop();
      if (BLOCK.has(name)) parts.push("\n");
    },
    ontext(data) {
      if (dropped.length === 0) parts.push(data.replace(/\s+/g, " "));
    },
  });
  parser.write(html);
  parser.end();
  const text = parts
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .filter((line, i, all) => line !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();
  return { text, report: emptyReport(), truncated: false };
}
