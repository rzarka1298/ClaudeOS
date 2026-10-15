// Second wave 1+2 fix round: the inline style check is an ALLOWLIST. A style attribute keeps the
// element visible only if every declaration is in a small harmless set with a harmless value; any
// other property, any value that cannot be read (var(), calc(), an escape), opacity other than
// exactly 1, a text colour together with a background, an alpha channel or a CSS-wide keyword
// drops the element's subtree, counted in hiddenBlocks. This subsumes the old suspicious-style
// set. Source is pure ASCII.
import { describe, expect, it } from "vitest";
import { htmlToText } from "./html-to-text.js";

function run(style: string): ReturnType<typeof htmlToText> {
  return htmlToText(`<p>before</p><span style="${style}">MARK</span><p>after</p>`);
}

const KEPT: ReadonlyArray<readonly [name: string, style: string]> = [
  ["no style at all", ""],
  ["only a stray semicolon", ";"],
  ["text alignment", "text-align:center"],
  ["bold", "font-weight:bold"],
  ["a numeric weight", "font-weight:600"],
  ["italic", "font-style:italic"],
  ["underline", "text-decoration:underline"],
  ["text transform", "text-transform:uppercase"],
  ["list style", "list-style-type:disc"],
  ["line height normal", "line-height:normal"],
  ["unitless line height", "line-height:1.5"],
  ["white space", "white-space:pre-wrap"],
  ["a border", "border:1px solid #ccc"],
  ["a bottom border", "border-bottom:2px dashed gray"],
  ["padding", "padding:4px 8px"],
  ["margin", "margin:0 auto"],
  ["margin under 100 pixels", "margin-left:40px"],
  ["width", "width:50%"],
  ["height", "height:20px"],
  ["max-width", "max-width:600px"],
  ["display block", "display:block"],
  ["display inline-block", "display:inline-block"],
  ["display table-cell", "display:table-cell"],
  ["display list-item", "display:list-item"],
  ["opacity exactly one", "opacity:1"],
  ["body type", "font-size:14px"],
  ["a type keyword", "font-size:large"],
  ["a font family", "font-family:Georgia, 'Times New Roman', serif"],
  ["several harmless declarations", "font-weight:bold;text-align:left;padding:2px"],
  ["an important harmless declaration", "font-weight:bold !important"],
];

const DROPPED: ReadonlyArray<readonly [name: string, style: string]> = [
  // not in the set at all
  ["position", "position:relative;left:10px"],
  ["absolute position", "position:absolute;top:0;left:0"],
  ["a transform", "transform:rotate(3deg)"],
  ["a scale", "transform:scale(1.2)"],
  ["a text indent", "text-indent:2em"],
  ["a hanging indent", "text-indent:-1em"],
  ["overflow", "overflow:auto"],
  ["z-index", "z-index:5"],
  ["float", "float:left"],
  ["a vendor property", "-webkit-text-stroke:1px red"],
  ["a mask", "mask-image:linear-gradient(transparent,transparent)"],
  ["a filter", "filter:blur(500px)"],
  ["zoom", "zoom:0.001"],
  ["letter spacing", "letter-spacing:-1em"],
  ["clip", "clip:rect(0,0,0,0)"],
  ["clip-path", "clip-path:inset(100%)"],
  ["a custom property", "--x:1"],
  ["visibility", "visibility:visible"],
  ["an unknown property", "frobnicate:yes"],
  ["an unknown property marked important", "frobnicate:yes !important"],
  // values that cannot be read
  ["a variable", "font-weight:var(--w)"],
  ["calc", "width:calc(100% - 10px)"],
  ["a CSS escape", "font-weight:\\62old"],
  ["a declaration without a colon", "bold"],
  ["a declaration without a property", ":bold"],
  ["a value over the style cap", `font-weight:bold;${"a".repeat(2_100)}`],
  // colours are outside the allowlist entirely (second wave 3 round)
  ["a literal colour", "color:red"],
  ["a hex colour", "color:#333"],
  ["an rgb colour", "color:rgb(10,20,30)"],
  ["a background colour alone", "background-color:#eee"],
  ["a dark background alone", "background-color:black"],
  ["a system colour", "color:canvas"],
  ["a system background", "background-color:canvastext"],
  ["a light colour alone", "color:#fff"],
  // display values that hide their children
  ["display table-column", "display:table-column"],
  ["display table-column-group", "display:table-column-group"],
  // relative or out-of-range type and line height
  ["type in em", "font-size:0.9em"],
  ["type in rem", "font-size:1.2rem"],
  ["type as a percentage", "font-size:90%"],
  ["a relative type keyword", "font-size:smaller"],
  ["a relative type keyword, larger", "font-size:larger"],
  ["type under 8 pixels", "font-size:7px"],
  ["type over 72 pixels", "font-size:73px"],
  ["huge type", "font-size:99999px"],
  ["a line height under 0.8", "line-height:0.5"],
  ["a tiny line height", "line-height:0.0001"],
  ["a line height over 5", "line-height:50"],
  ["a line height in em", "line-height:1.5em"],
  // sizes with an upper bound
  ["a huge border", "border-top:100000px solid"],
  ["a border of 201 pixels", "border:201px solid"],
  ["padding of 201 pixels", "padding:201px"],
  ["margin of 300 pixels", "margin:0 300px"],
  ["margin in em", "margin-left:2em"],
  ["padding as a percentage", "padding:10%"],
  // values that hide
  ["display none", "display:none"],
  ["display flex", "display:flex"],
  ["opacity below one", "opacity:0.99"],
  ["opacity half", "opacity:0.5"],
  ["opacity zero", "opacity:0"],
  ["opacity negative", "opacity:-1"],
  ["opacity as a percentage", "opacity:50%"],
  ["a variable opacity", "opacity:var(--o)"],
  ["zero width", "width:0"],
  ["zero height", "height:0"],
  ["a negative margin", "margin-left:-10px"],
  ["a margin of 100 pixels", "margin-left:100px"],
  ["a huge padding", "padding:5000px"],
  ["a zero line height", "line-height:0"],
  ["a negative line height", "line-height:-1"],
  ["tiny type", "font-size:1px"],
  ["zero type", "font-size:0"],
  ["a transparent colour", "color:transparent"],
  ["a colour with an alpha channel", "color:rgba(0,0,0,0.5)"],
  ["a hex colour with alpha", "color:#00000080"],
  ["a slash alpha", "color:rgb(0 0 0 / 50%)"],
  ["currentcolor", "color:currentcolor"],
  ["a CSS-wide colour", "color:inherit"],
  ["initial colour", "color:initial"],
  ["a transparent background", "background-color:transparent"],
  ["a background with alpha", "background-color:rgba(0,0,0,0.5)"],
  ["a background image", "background:url(x.png)"],
  ["a background shorthand", "background:white"],
  ["a text colour with a different background", "color:#fff;background-color:#000"],
  ["a text colour with a background in any form", "color:red;background:blue"],
  ["the same text and background colour", "color:#fff;background-color:#ffffff"],
  ["a border colour that is transparent but a var", "border-color:var(--c)"],
];

describe("an element whose style is entirely in the allowlist keeps its text", () => {
  for (const [name, style] of KEPT) {
    it(`keeps text under ${name}: ${style.slice(0, 60)}`, () => {
      const result = run(style);
      expect(result.text, style).toContain("MARK");
      expect(result.report.hiddenBlocks, style).toBe(0);
    });
  }
});

describe("any other style drops the element, counted", () => {
  for (const [name, style] of DROPPED) {
    it(`drops text under ${name}: ${style.slice(0, 60)}`, () => {
      const result = run(style);
      expect(result.text, style).toBe("before\nafter");
      expect(result.report.hiddenBlocks, style).toBeGreaterThanOrEqual(1);
    });
  }
});

describe("Codex 3: CSS-wide keywords are not literal colours", () => {
  // Lossy by design under the allowlist: the element is dropped and counted, never kept on the
  // strength of two equal strings.
  for (const style of [
    "color:initial;background-color:initial",
    "color:inherit;background-color:inherit",
    "color:unset;background-color:unset",
  ]) {
    it(`drops ${style} (and says so)`, () => {
      const result = htmlToText(`<article style="${style}">Visible article</article><p>after</p>`);
      expect(result.text).toBe("after");
      expect(result.report.hiddenBlocks).toBe(1);
    });
  }
});

describe("compounding and nesting", () => {
  it("drops three nested opacity 0.1 elements", () => {
    const open = '<div style="opacity:0.1">'.repeat(3);
    expect(htmlToText(`<p>shown</p>${open}LEAK`).text).toBe("shown");
  });

  it("drops ten nested relative font sizes", () => {
    const nest = (style: string, depth: number): string =>
      `${`<span style="${style}">`.repeat(depth)}LEAK${"</span>".repeat(depth)}`;
    for (const style of ["font-size:60%", "font-size:0.6em", "font-size:smaller"]) {
      expect(htmlToText(`<p>shown</p>${nest(style, 10)}`).text, style).toBe("shown");
    }
  });

  it("drops text once nested margins and padding add up past the budget", () => {
    const nest = (depth: number): string =>
      `${'<div style="margin-left:100px;padding-left:100px">'.repeat(depth)}LEAK${"</div>".repeat(depth)}`;
    expect(htmlToText(`<p>shown</p>${nest(5)}`).text).toContain("LEAK");
    expect(htmlToText(`<p>shown</p>${nest(40)}`).text).toBe("shown");
  });

  it("keeps a nest of harmless styles", () => {
    const result = htmlToText(
      '<div style="text-align:center"><span style="font-weight:bold">bold</span></div>',
    );
    expect(result.text).toBe("bold");
  });
});
