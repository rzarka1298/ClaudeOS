// The final design of the sanitiser (plan 07-04): an ALLOWLIST extractor. Text is emitted only when
// the current element and every ancestor is a known content element and none carries a hiding
// signal. Everything else (unknown, custom, legacy, raw-text, template, media, form controls)
// drops its whole subtree and is counted. A frame closes only on its own end tag, and an element
// left open at the end of the input stays dropped.
import { describe, expect, it } from "vitest";
import { parseFeed } from "./feed.js";
import { CONTENT_ELEMENTS, htmlToText } from "./html-to-text.js";

const KEPT = "<p>kept</p>";

function dropped(markup: string): ReturnType<typeof htmlToText> {
  return htmlToText(`${KEPT}${markup}${KEPT}`);
}

describe("allowlist: elements that are not known content drop their whole subtree", () => {
  const UNKNOWN = [
    "marquee",
    "blink",
    "my-widget",
    "x-foo",
    "dialog",
    "portal",
    "fencedframe",
    "bgsound",
    "rb",
    "acronym",
    "slot",
    "search",
    "foreignobject",
    "annotation-xml",
  ];
  for (const tag of UNKNOWN) {
    it(`drops <${tag}> with its children and counts one hidden block`, () => {
      const result = dropped(`<${tag}>HID_A<b>HID_B</b></${tag}>`);
      expect(result.text).toBe("kept\nkept");
      expect(result.report.hiddenBlocks).toBe(1);
    });
  }

  it("drops an allowed element nested in an unknown one", () => {
    expect(dropped("<marquee><p>HID</p><div><b>HID</b></div></marquee>").text).toBe("kept\nkept");
  });

  it("keeps the siblings that follow an unknown element", () => {
    expect(htmlToText("<p>one</p><blink>HID</blink><p>two</p>").text).toBe("one\ntwo");
  });

  it("counts a nested unknown element once, at the outermost", () => {
    const result = dropped("<marquee><blink>HID</blink><x-foo>HID</x-foo></marquee>");
    expect(result.report.hiddenBlocks).toBe(1);
  });

  it("drops an unknown element that is left open at the end of the input", () => {
    const result = htmlToText(`${KEPT}<my-widget>HID<p>HID_B`);
    expect(result.text).toBe("kept");
  });

  it("drops an unknown element's content even when a later end tag names an outer element", () => {
    expect(htmlToText("<div><blink>HID</div>HID_B").text).toBe("");
  });

  it("drops unknown elements in feed html content and in xhtml content", () => {
    const html = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><content type="html">&lt;p&gt;kept&lt;/p&gt;&lt;my-widget&gt;HID&lt;/my-widget&gt;</content></entry></feed>`,
    );
    expect(html.entries[0]?.text).toBe("kept");
    expect(html.report.hiddenBlocks).toBe(1);
    const xhtml = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>kept</p><x:blink xmlns:x="urn:x">HID</x:blink><my-widget>HID</my-widget></div></content></entry></feed>`,
    );
    expect(xhtml.entries[0]?.text).toBe("kept");
    expect(xhtml.report.hiddenBlocks).toBe(2);
  });
});

describe("allowlist: known content elements show their text", () => {
  it("exports a fixed set that includes the structural, text-level and table elements", () => {
    for (const tag of [
      "html",
      "body",
      "main",
      "article",
      "section",
      "div",
      "span",
      "p",
      "h1",
      "h6",
      "ul",
      "ol",
      "li",
      "dl",
      "dt",
      "dd",
      "blockquote",
      "pre",
      "code",
      "em",
      "strong",
      "b",
      "i",
      "u",
      "small",
      "sub",
      "sup",
      "mark",
      "a",
      "table",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "td",
      "th",
      "figure",
      "figcaption",
      "br",
      "hr",
      "address",
      "time",
      "abbr",
      "cite",
      "q",
      "kbd",
      "samp",
      "var",
      "details",
      "summary",
    ]) {
      expect(CONTENT_ELEMENTS.has(tag), tag).toBe(true);
    }
    for (const tag of [
      "script",
      "style",
      "template",
      "noscript",
      "svg",
      "math",
      "iframe",
      "input",
      "textarea",
    ]) {
      expect(CONTENT_ELEMENTS.has(tag), tag).toBe(false);
    }
  });

  for (const tag of [
    "div",
    "span",
    "section",
    "em",
    "strong",
    "b",
    "i",
    "u",
    "small",
    "sub",
    "sup",
    "mark",
    "code",
    "kbd",
    "samp",
    "var",
    "abbr",
    "cite",
    "q",
    "time",
    "address",
    "blockquote",
    "figure",
    "figcaption",
    "details",
    "summary",
    "label",
    "font",
    "center",
  ]) {
    it(`shows the text of <${tag}>`, () => {
      const result = htmlToText(`<${tag}>SHOWN</${tag}>`);
      expect(result.text).toBe("SHOWN");
      expect(result.report.hiddenBlocks).toBe(0);
    });
  }

  it("shows a nested article of known elements", () => {
    const html =
      "<article><h1>Title</h1><p>One <em>two</em> <a href='https://e.invalid/'>three</a></p><ul><li>a</li><li>b</li></ul><table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table></article>";
    const result = htmlToText(html);
    expect(result.text).toBe("Title\nOne two three\na\nb\nh\nc");
    expect(result.report.linksDropped).toBe(1);
    expect(result.report.hiddenBlocks).toBe(0);
  });

  it("drops the head and unknown void elements without a count", () => {
    const result = htmlToText(
      '<html><head><title>T</title><meta charset="utf-8"><link rel="x" href="y"></head><body><p>shown</p><meta name="a"><link rel="b"></body></html>',
    );
    expect(result.text).toBe("shown");
    expect(result.report.hiddenBlocks).toBe(0);
  });
});

describe("allowlist: hiding signals drop the subtree", () => {
  const SIGNALS: ReadonlyArray<readonly [string, string]> = [
    ["inert", "<div inert>HID</div>"],
    ["inert with a value", '<div inert="">HID</div>'],
    ["popover", "<div popover>HID</div>"],
    ["popover with a value", '<div popover="manual">HID</div>'],
    ["slot", '<div slot="x">HID</div>'],
    ["an empty aria-hidden", '<div aria-hidden="">HID</div>'],
    ["aria-hidden with a nonsense value", '<div aria-hidden="yes">HID</div>'],
    ["aria-hidden on a bare attribute", "<div aria-hidden>HID</div>"],
    ["class hidden", '<div class="hidden">HID</div>'],
    ["class sr-only", '<span class="sr-only">HID</span>'],
    ["class invisible", '<span class="invisible">HID</span>'],
    ["class d-none", '<div class="d-none">HID</div>'],
    ["class display-none", '<div class="display-none">HID</div>'],
    ["class visually-hidden", '<span class="visually-hidden">HID</span>'],
    ["class screen-reader-text", '<span class="screen-reader-text">HID</span>'],
    ["a hiding class among others", '<div class="card  sr-only  wide">HID</div>'],
    ["a hiding class in capitals", '<div class="SR-ONLY">HID</div>'],
    ["a hiding class with a tab", '<div class="a\thidden">HID</div>'],
    ["a zero width", '<div style="width:0">HID</div>'],
    ["a zero height", '<div style="height:0px">HID</div>'],
    ["a zero max height", '<div style="max-height:0">HID</div>'],
    ["a zero line height", '<div style="line-height:0">HID</div>'],
    ["a clip rectangle", '<div style="clip:rect(0,0,0,0)">HID</div>'],
    ["a clip path", '<div style="clip-path:inset(100%)">HID</div>'],
    ["a zero scale", '<div style="transform:scale(0)">HID</div>'],
    ["a zero-opacity filter", '<div style="filter:opacity(0)">HID</div>'],
    ["hidden content visibility", '<div style="content-visibility:hidden">HID</div>'],
    ["a transparent text fill", '<div style="-webkit-text-fill-color:transparent">HID</div>'],
    ["a zero font shorthand", '<div style="font:0/0 serif">HID</div>'],
  ];
  for (const [name, markup] of SIGNALS) {
    it(`drops ${name}`, () => {
      const result = dropped(markup);
      expect(result.text).toBe("kept\nkept");
      expect(result.report.hiddenBlocks).toBe(1);
    });
  }

  const HARMLESS: readonly string[] = [
    '<div aria-hidden="false">SHOWN</div>',
    '<div aria-hidden=" FALSE ">SHOWN</div>',
    '<div class="hidden-text">SHOWN</div>',
    '<div class="not-hidden card">SHOWN</div>',
    '<div class="visible">SHOWN</div>',
    '<div style="height:20px;width:50%">SHOWN</div>',
    '<div style="clip:auto;clip-path:none">SHOWN</div>',
    '<div style="transform:rotate(3deg)">SHOWN</div>',
    '<div style="line-height:1.5">SHOWN</div>',
    '<div style="content-visibility:auto">SHOWN</div>',
    '<div lang="en" dir="ltr" id="x" title="t" data-a="1">SHOWN</div>',
  ];
  for (const markup of HARMLESS) {
    it(`keeps ${markup}`, () => {
      const result = htmlToText(markup);
      expect(result.text).toBe("SHOWN");
      expect(result.report.hiddenBlocks).toBe(0);
    });
  }
});

describe("allowlist: frames close only on their own end tag", () => {
  it("does not let an end tag for another element end a dropped subtree", () => {
    const result = htmlToText("<marquee>HID</div></p></span>HID_B</marquee>VIS");
    expect(result.text).toBe("VIS");
  });

  it("keeps an unknown element dropped until its own end tag, however many elements close inside", () => {
    const result = htmlToText("<blink><p>HID</p><div>HID</div></blink>VIS");
    expect(result.text).toBe("VIS");
  });
});
