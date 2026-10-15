// Security finding 6 (plan 07-04): parser differentials. The text this sanitiser emits must be
// text a reader's browser would also show. htmlparser2 is configured explicitly as a browser-like
// HTML parser (not XML mode), raw-text and RCDATA elements drop their content, comment and
// end-tag variants follow the HTML rules, and where htmlparser2 and a browser are known to build
// different trees (misnested end tags across table cells and formatting elements, a second body
// or html start tag, a double-escaped script) the filter drops more rather than less.
import { describe, expect, it } from "vitest";
import { parseFeed } from "./feed.js";
import { htmlToText } from "./html-to-text.js";

const KEPT = "<p>kept</p>";

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inFeed(markup: string): ReturnType<typeof parseFeed> {
  return parseFeed(
    `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><content type="html">${escapeXml(markup)}</content></entry></feed>`,
  );
}

describe("finding 6: comment variants follow the HTML rules", () => {
  const COMMENTS: ReadonlyArray<readonly [string, string, string]> = [
    ["an empty comment written <!-->", "a<!-->VIS-->b", "aVIS-->b"],
    ["an empty comment written <!--->", "a<!--->VIS-->b", "aVIS-->b"],
    ["a comment closed by --!>", "a<!-- x --!>VIS-->b", "aVIS-->b"],
    ["a comment with a dash-space-bracket that does not close it", "a<!-- x -- > HID -->b", "ab"],
    ["an unterminated comment", "a<!-- HID <p>HID2</p>", "a"],
    ["a bogus comment <!x", "a<!x HID>b", "ab"],
    ["a bogus comment <?x", "a<?x HID>b", "ab"],
    ["a comment holding markup", "a<!-- <div>HID</div> -->b", "ab"],
    ["a comment holding a script", "a<!-- <script>HID()</script> -->b", "ab"],
  ];
  for (const [name, markup, expected] of COMMENTS) {
    it(`reads ${name}`, () => {
      const result = htmlToText(markup);
      expect(result.text).toBe(expected);
      expect(result.report.comments).toBeGreaterThanOrEqual(1);
      expect(result.text).not.toContain("HID");
    });
  }

  it("counts a bogus end tag with a space as a comment and keeps the open element open", () => {
    const result = htmlToText("<p hidden>HID</ p>HID_B</p>VIS");
    expect(result.text).toBe("VIS");
    expect(result.report.comments).toBe(1);
  });

  it("does not count a doctype as a comment", () => {
    expect(htmlToText("<!DOCTYPE html><!doctype html>x").report.comments).toBe(0);
  });
});

describe("finding 6: end tags", () => {
  const CLOSERS: ReadonlyArray<readonly [string, string]> = [
    ["a space before the bracket", "</p >"],
    ["capital letters", "</P>"],
    ["an attribute", '</p foo="bar">'],
    ["several spaces and a tab", "</p \t >"],
    ["a newline", "</p\n>"],
    ["a trailing slash", "</p/>"],
  ];
  for (const [name, closer] of CLOSERS) {
    it(`closes a hidden paragraph with an end tag written with ${name}`, () => {
      const result = htmlToText(`<p hidden>HID${closer}VIS`);
      expect(result.text).toBe("VIS");
    });
  }

  it("does not close a hidden paragraph with an end tag that has a space after the slash", () => {
    expect(htmlToText("<p hidden>HID</ p>HID_B").text).toBe("");
  });

  it("does not close a hidden element with an end tag for a different name", () => {
    expect(htmlToText("<div hidden>HID</dib>HID_B</divv>HID_C").text).toBe("");
  });
});

describe("finding 6: implied end tags and misnesting", () => {
  const IMPLIED: ReadonlyArray<readonly [string, string, string]> = [
    ["a paragraph closed by a paragraph", "<p hidden>HID<p>VIS", "VIS"],
    ["a paragraph closed by a block", "<p hidden>HID<div>VIS</div>", "VIS"],
    ["a list item closed by a list item", "<ul><li hidden>HID<li>VIS</ul>", "VIS"],
    ["a table cell closed by a table cell", "<table><tr><td hidden>HID<td>VIS</table>", "VIS"],
    ["a table row closed by a table row", "<table><tr hidden><td>HID<tr><td>VIS</table>", "VIS"],
    ["a definition term closed by a definition", "<dl><dt hidden>HID<dd>VIS</dl>", "VIS"],
    ["an option closed by an option", "<select><option>HID<option>HID2</select>VIS", "VIS"],
    [
      "a hidden paragraph that stays open across inline children",
      "<p hidden>HID<span>HID2</span><b>HID3</b>",
      "",
    ],
  ];
  for (const [name, markup, expected] of IMPLIED) {
    it(`handles ${name}`, () => {
      const result = htmlToText(markup);
      expect(result.text).toBe(expected);
      expect(result.text).not.toContain("HID");
    });
  }

  const CROSSING: ReadonlyArray<readonly [string, string]> = [
    [
      "an end tag that a table cell would make the browser ignore",
      "<div hidden><table><tr><td></div>HID</td></tr></table></div>",
    ],
    [
      "an end tag that a caption would make the browser ignore",
      "<div hidden><table><caption></div>HID</caption></table></div>",
    ],
    ["an end tag across an object element", "<div hidden><object></div>HID</object></div>"],
    ["an end tag across a template", "<div hidden><template></div>HID</template></div>"],
    ["a formatting element closed across a hidden block", "<b><p hidden>HID</b>HID_B</p>"],
    [
      "an anchor closed across a hidden block",
      "<a href='https://e.invalid/'><p hidden>HID</a>HID_B</p>",
    ],
    [
      "an outer hidden element whose inner end tag the browser would ignore",
      "<div hidden><div><table><td></div>HID</td></table></div>",
    ],
  ];
  for (const [name, markup] of CROSSING) {
    it(`drops what follows ${name}`, () => {
      const result = htmlToText(`${KEPT}${markup}`);
      expect(result.text).toBe("kept");
      expect(result.truncated).toBe(true);
    });
  }

  it("does not over-drop a table whose cells close normally", () => {
    const result = htmlToText(`${KEPT}<table><tr><td>a</td><td>b</td></tr></table><p>after</p>`);
    expect(result.text).toBe("kept\na b\nafter");
    expect(result.truncated).toBe(false);
  });

  it("does not over-drop a visible formatting element that closes normally", () => {
    const result = htmlToText(`${KEPT}<b>bold <i>both</i></b><p>after</p>`);
    expect(result.text).toBe("kept\nbold both\nafter");
    expect(result.truncated).toBe(false);
  });

  it("does not over-drop a hidden element inside a table that closes normally", () => {
    const result = htmlToText(`<table><tr><td hidden>HID</td><td>VIS</td></tr></table>`);
    expect(result.text).toBe("VIS");
    expect(result.truncated).toBe(false);
  });

  it("applies the same rule inside feed html content", () => {
    const parsed = inFeed(`${KEPT}<div hidden><table><tr><td></div>HID</td></tr></table></div>`);
    expect(parsed.entries[0]?.text).toBe("kept");
  });
});

describe("finding 6: a second body or html start tag merges its attributes into the first", () => {
  it("hides the whole document when a later body tag carries a hiding attribute", () => {
    const result = htmlToText("<html><body><p>BEFORE</p><body hidden><p>HID</p></body></html>");
    expect(result.text).toBe("");
    expect(result.report.hiddenBlocks).toBe(1);
  });

  it("hides the whole document when a later html tag hides it", () => {
    const result = htmlToText('<p>BEFORE</p><html style="display:none"><p>HID</p>');
    expect(result.text).toBe("");
    expect(result.report.hiddenBlocks).toBe(1);
  });

  it("hides the whole document for a body with aria-hidden", () => {
    expect(htmlToText('<body><p>BEFORE</p><BODY ARIA-HIDDEN="true">HID').text).toBe("");
  });

  it("leaves a body or html tag with ordinary attributes alone", () => {
    const result = htmlToText(
      '<html lang="en"><body class="x" onload="y()"><p>shown</p></body></html>',
    );
    expect(result.text).toBe("shown");
    expect(result.report.hiddenBlocks).toBe(0);
  });

  it("applies inside feed html content", () => {
    const parsed = inFeed("<p>BEFORE</p><body hidden>HID");
    expect(parsed.entries[0]?.text ?? "").toBe("");
  });
});

describe("finding 6: raw-text and RCDATA elements drop their content", () => {
  const RAW: ReadonlyArray<readonly [string, string, string, number]> = [
    ["noembed", "<noembed><b>HID</b></noembed>", "mediaDropped", 1],
    ["noframes", "<noframes><b>HID</b></noframes>", "mediaDropped", 1],
    ["iframe", "<iframe><b>HID</b></iframe>", "mediaDropped", 1],
    ["textarea", "<textarea><b>HID</b></textarea>", "mediaDropped", 1],
    ["noscript", "<noscript><p>HID</p></noscript>", "hiddenBlocks", 1],
    ["template", "<template><p>HID</p></template>", "hiddenBlocks", 1],
    ["script", "<script>HID()</script>", "scripts", 1],
    ["style", "<style>.a{}HID</style>", "styles", 1],
    ["title outside the head", "<title><b>HID</b></title>", "mediaDropped", 0],
    ["IFRAME with a space in its end tag", "<iframe>HID</iframe >", "mediaDropped", 1],
  ];
  for (const [name, markup, key, count] of RAW) {
    it(`drops the content of ${name}`, () => {
      const result = htmlToText(`${KEPT}${markup}${KEPT}`);
      expect(result.text).toBe("kept\nkept");
      expect(result.report[key as "mediaDropped"]).toBe(count);
    });
  }

  it("treats a self-closing script as an open script, as a browser does", () => {
    const result = htmlToText(`${KEPT}<script/>HID()</script>VIS`);
    expect(result.text).toBe("kept\nVIS");
    expect(result.report.scripts).toBe(1);
  });

  it("treats a self-closing style and textarea as open", () => {
    const result = htmlToText(`${KEPT}<style/>HID{}</style><textarea/>HID2</textarea>VIS`);
    expect(result.text).toBe("kept\nVIS");
  });

  it("ends a script only at its own end tag", () => {
    const result = htmlToText(`${KEPT}<script>a</scr</b>HID()</script>VIS`);
    expect(result.text).toBe("kept\nVIS");
  });

  it("swallows the rest of the document after a plaintext element", () => {
    // plaintext (like xmp, svg, math, CDATA and frames) now drops the whole document: see
    // gates-wave2.test.ts.
    const result = htmlToText(`${KEPT}<plaintext>HID</plaintext>HID_B<b>HID_C</b><p>HID_D`);
    expect(result.text).toBe("");
    expect(result.report.hiddenBlocks).toBe(1);
  });

  it("swallows the rest of the document after PLAINTEXT in capitals", () => {
    expect(htmlToText(`${KEPT}<PLAINTEXT>HID<script>x()</script>`).text).toBe("");
  });

  it("drops the content of a double-escaped script, which ends only at the second end tag", () => {
    const result = htmlToText(`${KEPT}<script><!--<script>HID()</script>HID_B</script>VIS`);
    expect(result.text).toBe("kept");
    expect(result.truncated).toBe(true);
  });

  it("does not treat an ordinary script containing a comment opener as double-escaped", () => {
    const result = htmlToText(`${KEPT}<script><!-- x() --></script>VIS`);
    expect(result.text).toBe("kept\nVIS");
    expect(result.truncated).toBe(false);
  });
});

describe("finding 6: attribute spellings", () => {
  const SPELLINGS: ReadonlyArray<readonly [string, string]> = [
    ["a tab before the attribute", "<div\thidden>HID</div>"],
    ["a form feed and newline around it", "<div\f\nhidden\n>HID</div>"],
    ["spaces around a single-quoted style", "<div style = 'display:none' >HID</div>"],
    ["an aria-hidden name in capitals with spaces", '<div ARIA-hidden = "true" >HID</div>'],
    ["a missing space between attributes", '<div style="display:none"title=x>HID</div>'],
    ["an empty single-quoted hidden", "<div hidden=''>HID</div>"],
    ["a quoted greater-than sign before it", '<div data-a=">" hidden>HID</div>'],
    ["a quoted double quote before it", "<div title='a\"b' hidden>HID</div>"],
    ["a repeated hidden attribute", '<div hidden="x" hidden="y">HID</div>'],
    ["a slash before the attribute", "<div/hidden>HID</div>"],
    [
      "an attribute value with an entity for the letter",
      '<div style="display:&#110;one">HID</div>',
    ],
    ["an unquoted aria-hidden", "<div aria-hidden=true>HID</div>"],
  ];
  for (const [name, markup] of SPELLINGS) {
    it(`hides content behind ${name}`, () => {
      const result = htmlToText(`${KEPT}${markup}${KEPT}`);
      expect(result.text).toBe("kept\nkept");
      expect(result.report.hiddenBlocks).toBe(1);
    });
  }
});

describe("finding 6: entity-encoded tags stay literal text", () => {
  const ENCODED: ReadonlyArray<readonly [string, string, string]> = [
    ["named entities", "<p>&lt;div hidden&gt;LIT&lt;/div&gt;</p>", "<div hidden>LIT</div>"],
    ["numeric entities", "<p>&#60;script&#62;LIT&#60;/script&#62;</p>", "<script>LIT</script>"],
    ["hex entities", "<p>&#x3c;b&#x3e;LIT&#x3c;/b&#x3e;</p>", "<b>LIT</b>"],
    ["legacy entities without a semicolon", "<p>&lt;i&gt;LIT</p>", "<i>LIT"],
    ["double-encoded entities", "<p>&amp;lt;script&amp;gt;LIT</p>", "&lt;script&gt;LIT"],
    ["an entity in a textarea", "<textarea>&lt;b&gt;</textarea><p>LIT &lt;u&gt;</p>", "LIT <u>"],
  ];
  for (const [name, markup, expected] of ENCODED) {
    it(`keeps ${name} as literal text`, () => {
      const result = htmlToText(markup);
      expect(result.text).toBe(expected);
      expect(result.report.scripts).toBe(0);
      expect(result.report.hiddenBlocks).toBe(0);
    });
  }
});
