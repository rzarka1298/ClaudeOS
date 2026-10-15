// Wave 1+2 review, Codex 2 and the style minors (plan 07-04): an inline style that a browser
// renders as invisible or off-screen, but that the filter did not read as hiding. Each style here
// is applied to a span carrying a marker; the marker must be dropped and the drop counted in
// hiddenBlocks. A second table holds ordinary styles that must keep their text, so the extension
// does not become a blanket "any style hides". Source is pure ASCII.
import { describe, expect, it } from "vitest";
import { parseFeed } from "./feed.js";
import { htmlToText } from "./html-to-text.js";

function run(style: string): ReturnType<typeof htmlToText> {
  return htmlToText(`<p>before</p><span style="${style}">MARK</span><p>after</p>`);
}

const HIDING: ReadonlyArray<readonly [name: string, style: string]> = [
  ["plain colour (allowlist)", "color:red"],
  ["black (allowlist)", "color:#000"],
  ["small type in em (allowlist)", "font-size:0.9em"],
  ["percentage type (allowlist)", "font-size:90%"],
  // Moved here by the second fix round: outside the style allowlist, so the element is dropped.
  ["half opacity (allowlist)", "opacity:0.5"],
  ["half opacity percent (allowlist)", "opacity:50%"],
  ["semi-transparent colour (allowlist)", "color:rgba(0,0,0,0.5)"],
  ["eight-digit hex with alpha (allowlist)", "color:#00000080"],
  ["text on a different background (allowlist)", "color:#ffffff;background-color:#000000"],
  ["a hanging indent (allowlist)", "text-indent:-1em"],
  ["a positive indent (allowlist)", "text-indent:2em"],
  ["relative position with an offset (allowlist)", "position:relative;left:10px"],
  ["absolute position with zero offsets (allowlist)", "position:absolute;top:0;left:0"],
  ["rotation (allowlist)", "transform:rotate(3deg)"],
  ["scaling up (allowlist)", "transform:scale(1.2)"],
  ["a small negative margin (allowlist)", "margin-left:-10px"],
  // opacity at or below zero (browsers clamp to zero)
  ["negative opacity", "opacity:-1"],
  ["negative percentage opacity", "opacity:-10%"],
  ["zero with a decimal point", "opacity:0.0"],
  ["zero percent opacity", "opacity:0%"],
  ["important zero opacity", "opacity:0 !important"],
  ["negative zero opacity", "opacity:-0"],
  ["tiny negative opacity", "opacity:-0.001"],
  // zero-alpha colours
  ["four-digit hex, alpha zero", "color:#0000"],
  ["eight-digit hex, alpha zero", "color:#ffffff00"],
  ["eight-digit hex, alpha zero, upper case", "color:#FFFFFF00"],
  ["rgba with a zero alpha", "color:rgba(255,255,255,0)"],
  ["rgba with a decimal zero alpha", "color:rgba(0,0,0,0.0)"],
  ["hsla with a zero alpha", "color:hsla(0,0%,100%,0)"],
  ["rgb with a slash alpha zero", "color:rgb(0 0 0 / 0)"],
  ["rgb with a slash alpha zero percent", "color:rgb(0 0 0 / 0%)"],
  ["oklch with a slash alpha zero", "color:oklch(1 0 0 / 0)"],
  ["the transparent keyword", "color:transparent"],
  ["text fill colour with a zero alpha", "-webkit-text-fill-color:#00000000"],
  // same colour as the background
  ["text colour equal to the background colour", "color:#ffffff;background-color:#ffffff"],
  ["short hex equal to long hex background", "color:#fff;background-color:#ffffff"],
  ["background shorthand equal to the colour", "color:white;background:white"],
  // tiny type
  ["one pixel type", "font-size:1px"],
  ["two pixel type", "font-size:2px"],
  ["fractional pixel type", "font-size:0.5px"],
  ["tiny em type", "font-size:0.05em"],
  ["tiny percent type", "font-size:1%"],
  // off-screen by text indent, position, translation, margin or inset
  ["negative text indent", "text-indent:-9999px"],
  ["negative text indent, small unit", "text-indent:-100em"],
  ["absolute with a negative left", "position:absolute;left:-9999px"],
  ["absolute with a negative right", "position:absolute;right:-5000px"],
  ["absolute with a large top", "position:absolute;top:99999px"],
  ["fixed with an offset", "position:fixed;bottom:-200px"],
  ["absolute with inset", "position:absolute;inset:-9999px"],
  ["translate function", "transform:translate(-9999px,0)"],
  ["translateX function", "transform:translateX(-200%)"],
  ["translate3d function", "transform:translate3d(0,-9999px,0)"],
  ["the translate property", "translate:-9999px 0"],
  ["negative right margin", "margin-right:-9999px"],
  ["negative bottom margin", "margin-bottom:-9999px"],
  ["negative margin shorthand", "margin:0 -9999px 0 0"],
  ["large negative left margin", "margin-left:-500px"],
  ["inset property", "inset:-9999px"],
  // clipping and collapsing
  ["clip rect", "clip:rect(0,0,0,0)"],
  ["clip-path inset", "clip-path:inset(100%)"],
  ["zero height with hidden overflow", "height:0;overflow:hidden"],
  ["zero width with hidden overflow", "width:0;overflow:hidden"],
  ["one pixel box with hidden overflow", "height:1px;width:1px;overflow:hidden"],
  ["scale property zero", "scale:0"],
];

const VISIBLE: ReadonlyArray<readonly [name: string, style: string]> = [
  ["opacity one", "opacity:1"],
  ["body type", "font-size:14px"],
  ["auto margins", "margin:0 auto"],
  ["a thin rule box", "height:1px"],
  ["bold and centred", "font-weight:bold;text-align:center"],
];

describe("inline styles that hide text are read as hiding", () => {
  for (const [name, style] of HIDING) {
    it(`drops text under ${name}: ${style}`, () => {
      const result = run(style);
      expect(result.text, style).toBe("before\nafter");
      expect(result.report.hiddenBlocks, style).toBeGreaterThanOrEqual(1);
    });
  }
});

describe("ordinary inline styles keep their text", () => {
  for (const [name, style] of VISIBLE) {
    it(`keeps text under ${name}: ${style}`, () => {
      const result = run(style);
      expect(result.text, style).toContain("MARK");
      expect(result.report.hiddenBlocks, style).toBe(0);
    });
  }
});

describe("the same styles in feed html", () => {
  it("hides a suspicious style inside an escaped html body", () => {
    const feed = parseFeed(
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><content type="html">&lt;p&gt;shown&lt;/p&gt;&lt;span style="opacity:-1"&gt;HIDDEN_MARK&lt;/span&gt;</content></entry></feed>',
    );
    expect(feed.entries[0]?.text).toBe("shown");
    expect(feed.report.hiddenBlocks).toBe(1);
  });
});
