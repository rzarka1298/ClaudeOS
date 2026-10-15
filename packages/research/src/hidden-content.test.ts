// Security finding 4 (plan 07-04): the hidden-content filter must see what a reader's browser
// would hide. The filter runs on the SAME parse tree whose text is emitted (a single parse: page
// markup through htmlparser2 in HTML mode, xhtml feed content through the XML events of the feed
// parse itself, never re-serialised), entities are decoded before any test, attribute names and
// values are matched without regard to case, spacing, comments or entity spelling, namespace
// prefixes on element names are ignored, and a style value the filter cannot read is treated as
// hidden and counted, not as visible.
import { describe, expect, it } from "vitest";
import { parseFeed, renderFeedText } from "./feed.js";
import { htmlToText } from "./html-to-text.js";

const KEPT = "<p>kept</p>";
const ALSO = "<p>also kept</p>";

function pageText(markup: string): ReturnType<typeof htmlToText> {
  return htmlToText(`${KEPT}${markup}${ALSO}`);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inHtmlContent(markup: string): ReturnType<typeof parseFeed> {
  return parseFeed(
    `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><content type="html">${escapeXml(`${KEPT}${markup}${ALSO}`)}</content></entry></feed>`,
  );
}

function inXhtmlContent(inner: string): ReturnType<typeof parseFeed> {
  return parseFeed(
    `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:h="http://www.w3.org/1999/xhtml">${KEPT}${inner}${ALSO}</div></content></entry></feed>`,
  );
}

/** Elements whose content a reader never sees, in the spellings an attacker would try. */
const HIDDEN_ELEMENTS: ReadonlyArray<readonly [string, string]> = [
  ["an empty hidden attribute", '<div hidden="">HID</div>'],
  ["a bare hidden attribute in capitals", "<div HIDDEN>HID</div>"],
  ["mixed-case element and attribute names", "<DIV HiDdEn>HID</DIV>"],
  ["spaces around the equals sign", '<div hidden = "">HID</div>'],
  ["a newline before the attribute", "<div\nhidden>HID</div>"],
  ["hidden with a value", "<div hidden=hidden>HID</div>"],
  ["hidden with the value false", '<div hidden="false">HID</div>'],
  ["hidden until found", '<div hidden="until-found">HID</div>'],
  ["another attribute first", '<div data-x="1" class="y" hidden>HID</div>'],
  ["aria-hidden in capitals", '<div ARIA-HIDDEN="TRUE">HID</div>'],
  ["aria-hidden with spaces", '<div aria-hidden=" true ">HID</div>'],
  ["aria-hidden unquoted", "<div aria-hidden=true>HID</div>"],
  ["aria-hidden in single quotes with a capital", "<div aria-hidden = 'True'>HID</div>"],
  ["display none with spaces", '<div style="display : none">HID</div>'],
  ["display none in capitals", '<div style="DISPLAY:NONE">HID</div>'],
  ["display none important", '<div style="display:none!important">HID</div>'],
  ["display none with a spaced important", '<div style="display:none ! important">HID</div>'],
  ["display none with a trailing semicolon", '<div style="display:none;">HID</div>'],
  ["display none with a comment in the value", '<div style="display:/*c*/none">HID</div>'],
  ["display none after a comment", '<div style="/* c */display:none">HID</div>'],
  ["display none in single quotes", "<div style='display:none'>HID</div>"],
  ["display none unquoted", "<div style=display:none>HID</div>"],
  ["display none with a colon entity", '<div style="display&#58;none">HID</div>'],
  ["display none with a named colon entity", '<div style="display&colon;none">HID</div>'],
  ["display none with a hex entity letter", '<div style="display:&#x6e;one">HID</div>'],
  ["visibility hidden in capitals", '<div style="Visibility:Hidden">HID</div>'],
  ["visibility hidden with spaces", '<div style="visibility : hidden">HID</div>'],
  ["visibility collapse", '<div style="visibility:collapse">HID</div>'],
  ["opacity zero", '<div style="opacity:0">HID</div>'],
  ["opacity zero point zero", '<div style="opacity:0.0">HID</div>'],
  ["opacity zero percent", '<div style="opacity:0%">HID</div>'],
  ["opacity double zero", '<div style="opacity:00">HID</div>'],
  ["opacity zero important", '<div style="opacity : 0 !important">HID</div>'],
  ["font size zero", '<div style="font-size:0">HID</div>'],
  ["font size zero pixels", '<div style="font-size:0px">HID</div>'],
  ["font size zero em", '<div style="font-size:0em">HID</div>'],
  ["font size zero point zero points", '<div style="font-size:0.0pt">HID</div>'],
  ["font size zero in capitals with important", '<div style="FONT-SIZE : 0 !important">HID</div>'],
  ["a far left offset", '<div style="left:-9999px">HID</div>'],
  ["a far right offset in em", '<div style="right:-10000em">HID</div>'],
  ["a far text indent", '<div style="text-indent:-9999px">HID</div>'],
  ["a far left margin", '<div style="margin-left:-5000px">HID</div>'],
  ["a transparent colour", '<div style="color:transparent">HID</div>'],
  ["a zero-alpha colour", '<div style="color:rgba(0,0,0,0)">HID</div>'],
  [
    "hidden among visible declarations",
    '<div style="color:red;font-weight:bold;display:none">HID</div>',
  ],
  ["nested hidden content", '<div hidden><p>HID</p><div style="display:none">HID</div></div>'],
];

/** Style values the filter cannot read: hidden and counted, never assumed visible. */
const UNSAFE_STYLES: ReadonlyArray<readonly [string, string]> = [
  ["display:flex (outside the style allowlist)", "display:flex"],
  ["display:block flow (outside the style allowlist)", "display:block flow"],
  ["opacity:0.5 (outside the style allowlist)", "opacity:0.5"],
  ["opacity:50% (outside the style allowlist)", "opacity:50%"],
  ["opacity:inherit (outside the style allowlist)", "opacity:inherit"],
  ["visibility:visible (outside the style allowlist)", "visibility:visible"],
  ["left:-5px (outside the style allowlist)", "left:-5px"],
  ["left:-999px (outside the style allowlist)", "left:-999px"],
  ["left:auto (outside the style allowlist)", "left:auto"],
  ["margin-left:-20px (outside the style allowlist)", "margin-left:-20px"],
  ["text-indent:2em (outside the style allowlist)", "text-indent:2em"],
  ["color:rgba(0,0,0,0.5) (outside the style allowlist)", "color:rgba(0,0,0,0.5)"],
  ["width:calc(100% - 4px) (outside the style allowlist)", "width:calc(100% - 4px)"],
  [
    "position:absolute;top:0;left:0 (outside the style allowlist)",
    "position:absolute;top:0;left:0",
  ],
  [
    "font-weight:bold;background:url(x.png) (outside the style allowlist)",
    "font-weight:bold;background:url(x.png)",
  ],
  ["not a declaration at all (outside the style allowlist)", "not a declaration at all"],
  ["a variable in display", "display:var(--x)"],
  ["an unknown display keyword", "display:foo"],
  ["a css escape in a keyword", "display:\\6e one"],
  ["a css escape in a property", "dis\\70lay:none"],
  ["an escape in visibility", "visibility:\\68idden"],
  ["a calc in opacity", "opacity:calc(0)"],
  ["a variable in opacity", "opacity:var(--o)"],
  ["a calc in font size", "font-size:calc(0px)"],
  ["a unitless font size", "font-size:12"],
  ["an unknown unit in font size", "font-size:0zz"],
  ["a calc in an offset", "left:calc(-9999px)"],
  ["a variable in a margin", "margin-left:var(--m)"],
  ["an unknown visibility keyword", "visibility:invisible"],
];

/** Styles that hide nothing. */
const VISIBLE_STYLES: readonly string[] = [
  "display:block",
  "display:inline-block;color:red",
  "opacity:1",
  "font-size:12px",
  "font-size:1.2em",
  "font-size:larger",
  "font-size:100%",
  "color:red",
  "",
  "   ",
  ";;;",
];

describe("finding 4: hidden elements in page markup", () => {
  for (const [name, markup] of HIDDEN_ELEMENTS) {
    it(`never emits the text of ${name}, and counts one hidden block`, () => {
      const result = pageText(markup);
      expect(result.text).toBe("kept\nalso kept");
      expect(result.report.hiddenBlocks).toBe(1);
    });
  }

  for (const [name, style] of UNSAFE_STYLES) {
    it(`treats ${name} as hidden and counts it`, () => {
      const result = pageText(`<div style="${style}">HID</div>`);
      expect(result.text).toBe("kept\nalso kept");
      expect(result.report.hiddenBlocks).toBe(1);
    });
  }

  for (const style of VISIBLE_STYLES) {
    it(`keeps the text of style ${JSON.stringify(style)}`, () => {
      const result = pageText(`<div style="${style}">SHOWN</div>`);
      expect(result.text).toBe("kept\nSHOWN\nalso kept");
      expect(result.report.hiddenBlocks).toBe(0);
    });
  }

  it("does not decode entities after filtering: escaped markup stays literal text", () => {
    const result = pageText("<p>&lt;div hidden&gt;LITERAL&lt;/div&gt;</p>");
    expect(result.text).toBe("kept\n<div hidden>LITERAL</div>\nalso kept");
    expect(result.report.hiddenBlocks).toBe(0);
  });

  it("decodes an entity inside an attribute before testing it", () => {
    const result = pageText('<div aria-hidden="&#116;rue">HID</div><div hidden="&quot;">HID</div>');
    expect(result.text).toBe("kept\nalso kept");
    expect(result.report.hiddenBlocks).toBe(2);
  });

  it("uses the first of a repeated attribute, as a browser does", () => {
    const result = pageText('<div style="display:block" style="display:none">SHOWN</div>');
    expect(result.text).toBe("kept\nSHOWN\nalso kept");
  });
});

describe("finding 4: namespace-prefixed element names in page markup", () => {
  const PREFIXED: ReadonlyArray<readonly [string, string, Partial<Record<string, number>>]> = [
    ["a prefixed script", "<x:script>HID()</x:script>", { scripts: 1 }],
    ["a prefixed script in capitals", "<X:SCRIPT>HID()</X:SCRIPT>", { scripts: 1 }],
    ["a prefixed style", "<h:style>.a{}HID</h:style>", { styles: 1 }],
    ["a prefixed template", "<x:template>HID</x:template>", { hiddenBlocks: 1 }],
    ["a prefixed noscript", "<x:noscript>HID</x:noscript>", { hiddenBlocks: 1 }],
    ["a prefixed textarea", "<x:textarea>HID</x:textarea>", { mediaDropped: 1 }],
    ["a prefixed iframe", "<x:iframe>HID</x:iframe>", { mediaDropped: 1 }],
    ["a prefixed head", "<x:head><x:title>HID</x:title></x:head>", {}],
    ["a prefixed hidden div", "<xhtml:div hidden>HID</xhtml:div>", { hiddenBlocks: 1 }],
    [
      "a prefixed div with a hidden style",
      '<x:div style="display:none">HID</x:div>',
      { hiddenBlocks: 1 },
    ],
  ];

  for (const [name, markup, counts] of PREFIXED) {
    it(`drops ${name}`, () => {
      const result = pageText(markup);
      expect(result.text).toBe("kept\nalso kept");
      for (const [key, value] of Object.entries(counts)) {
        expect(result.report[key as keyof typeof result.report], key).toBe(value);
      }
    });
  }

  it("counts a prefixed image and a prefixed anchor like the plain ones", () => {
    const result = pageText(
      '<x:img src="https://e.invalid/a.png"><x:a href="https://e.invalid/b">anchor</x:a>',
    );
    expect(result.text).toBe("kept\nanchor\nalso kept");
    expect(result.report.mediaDropped).toBe(1);
    expect(result.report.linksDropped).toBe(1);
  });

  it("treats a prefixed block element as a block", () => {
    expect(pageText("<x:p>one</x:p><x:p>two</x:p>").text).toBe("kept\none\ntwo\nalso kept");
  });

  it("reads a prefixed attribute name by its local name", () => {
    const result = pageText(
      '<div xhtml:hidden="hidden">HID</div><div xhtml:style="display:none">HID</div>',
    );
    expect(result.text).toBe("kept\nalso kept");
    expect(result.report.hiddenBlocks).toBe(2);
  });
});

describe("finding 4: hidden content in feed html content", () => {
  for (const [name, markup] of HIDDEN_ELEMENTS) {
    it(`drops ${name} in type html content`, () => {
      const parsed = inHtmlContent(markup);
      expect(parsed.entries[0]?.text).toBe("kept\nalso kept");
      expect(parsed.report.hiddenBlocks).toBe(1);
    });
  }

  for (const [name, style] of UNSAFE_STYLES) {
    it(`treats ${name} as hidden in type html content`, () => {
      const parsed = inHtmlContent(`<div style="${style}">HID</div>`);
      expect(parsed.entries[0]?.text).toBe("kept\nalso kept");
      expect(parsed.report.hiddenBlocks).toBe(1);
    });
  }

  it("keeps entity-encoded markup literal when it was encoded twice", () => {
    const parsed = inHtmlContent("<p>&lt;div hidden&gt;LITERAL&lt;/div&gt;</p>");
    expect(parsed.entries[0]?.text).toBe("kept\n<div hidden>LITERAL</div>\nalso kept");
    expect(parsed.report.hiddenBlocks).toBe(0);
  });

  it("filters markup that arrived as nested CDATA in content:encoded", () => {
    const parsed = parseFeed(
      `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>C</title><content:encoded><![CDATA[<p>kept</p><div hidden>HID_A</div><![CDATA[<div hidden>HID_B</div>]]>]]></content:encoded></item></channel></rss>`,
    );
    const text = parsed.entries[0]?.text ?? "";
    expect(text).not.toContain("HID_A");
    // A CDATA section in HTML content is read differently by a browser: the whole field is
    // dropped (second wave 1+2 fix round) instead of keeping "kept".
    expect(text).toBe("");
    expect(parsed.report.hiddenBlocks).toBeGreaterThanOrEqual(1);
    expect(text).not.toContain("<div");
  });
});

describe("finding 4: xhtml feed content is filtered on the parse it was read from", () => {
  const XHTML_HIDDEN: ReadonlyArray<readonly [string, string, number]> = [
    ["a prefixed hidden div", '<xhtml:div hidden="hidden">HID</xhtml:div>', 1],
    ["an attribute name in capitals", '<div HIDDEN="">HID</div>', 1],
    ["an empty hidden attribute", '<div hidden="">HID</div>', 1],
    ["mixed-case names and a capitalised style", '<DIV Style="Display:None">HID</DIV>', 1],
    ["a spaced visibility style", '<div STYLE="visibility : hidden">HID</div>', 1],
    ["aria-hidden in capitals", '<div aria-hidden="TRUE">HID</div>', 1],
    ["a prefixed span with opacity zero", '<h:span style="opacity:0">HID</h:span>', 1],
    ["an entity in the style", '<div style="display&#58;none">HID</div>', 1],
    ["a variable in the style", '<div style="display:var(--x)">HID</div>', 1],
    ["a css escape in the style", '<div style="display:\\6e one">HID</div>', 1],
    ["font size zero", '<div style="font-size:0">HID</div>', 1],
    ["an off-screen offset", '<div style="left:-9999px">HID</div>', 1],
    [
      "nested hidden content",
      '<div hidden="hidden"><p>HID</p><div style="display:none">HID</div></div>',
      1,
    ],
    ["a prefixed template", "<h:template>HID</h:template>", 1],
    ["a prefixed noscript", "<h:noscript>HID</h:noscript>", 1],
    ["an image that has child text", '<h:img src="x">HID</h:img>', 0],
    ["a prefixed textarea", "<h:textarea>HID</h:textarea>", 0],
  ];

  for (const [name, inner, hidden] of XHTML_HIDDEN) {
    it(`drops ${name}`, () => {
      const parsed = inXhtmlContent(inner);
      expect(parsed.entries[0]?.text).toBe("kept\nalso kept");
      expect(parsed.report.hiddenBlocks).toBe(hidden);
    });
  }

  it("counts prefixed active elements like the plain ones", () => {
    const parsed = inXhtmlContent(
      '<xhtml:script>HID()</xhtml:script><h:style>.a{}HID</h:style><h:img src="https://e.invalid/a"/><h:a href="https://e.invalid/b">anchor</h:a>',
    );
    expect(parsed.entries[0]?.text).toBe("kept\nanchor\nalso kept");
    expect(parsed.report).toMatchObject({
      scripts: 1,
      styles: 1,
      mediaDropped: 1,
      linksDropped: 1,
    });
  });

  it("drops comments without copying them", () => {
    const parsed = inXhtmlContent("<!-- HID_COMMENT -->");
    expect(parsed.entries[0]?.text).toBe("kept\nalso kept");
    expect(parsed.report.comments).toBe(1);
  });

  it("keeps escaped markup in xhtml text literal: it is never parsed", () => {
    const parsed = inXhtmlContent("<p>&lt;div hidden&gt;LITERAL&lt;/div&gt;</p>");
    expect(parsed.entries[0]?.text).toBe("kept\n<div hidden>LITERAL</div>\nalso kept");
    expect(parsed.report.hiddenBlocks).toBe(0);
  });

  it("keeps CDATA text in xhtml content literal", () => {
    const parsed = inXhtmlContent("<p><![CDATA[<div hidden>LITERAL</div>]]></p>");
    expect(parsed.entries[0]?.text).toBe("kept\n<div hidden>LITERAL</div>\nalso kept");
    expect(parsed.report.hiddenBlocks).toBe(0);
  });

  it("does not let attribute values leak into the text or change the filter", () => {
    const parsed = inXhtmlContent(
      '<p title="&quot;&gt;&lt;script&gt;ATTR()&lt;/script&gt;" data-x="HID_ATTR">shown</p>',
    );
    expect(parsed.entries[0]?.text).toBe("kept\nshown\nalso kept");
    expect(parsed.report.scripts).toBe(0);
  });

  it("applies the 512 depth cap to xhtml content", () => {
    const deep = "<div>".repeat(600);
    const parsed = inXhtmlContent(`${deep}DEEP_TEXT`);
    expect(renderFeedText(parsed.entries)).not.toContain("DEEP_TEXT");
  });

  it("filters xhtml in a title the same way", () => {
    const parsed = parseFeed(
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Shown <span hidden="hidden">HID</span>title</div></title></entry></feed>',
    );
    expect(parsed.entries[0]?.title).toBe("Shown title");
    expect(parsed.report.hiddenBlocks).toBe(1);
  });
});
