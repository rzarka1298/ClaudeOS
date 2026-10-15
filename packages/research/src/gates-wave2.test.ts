// Second wave 1+2 fix round (plan 07-04): coarse fail-closed gates instead of emulation, after the
// opus high-risk review and Codex's second review.
//
//   - constructs where htmlparser2 and a browser disagree (CDATA sections, frameset and frame,
//     plaintext, xmp, svg, math, annotation-xml, a raw-text start tag inside an open select) drop
//     the WHOLE document's text, counted, truncated;
//   - when the sink stops and a document start tag is anywhere in the last written chunk or the
//     unparsed remainder (including one cut by the 4 KiB write boundary), everything is discarded;
//   - a late `<html hidden>` wipe is flagged truncated;
//   - the content of a closed `details` (past its first summary) is dropped and counted.
//
// Source is pure ASCII.
import { describe, expect, it } from "vitest";
import { htmlToText, WRITE_CHUNK_CHARS } from "./html-to-text.js";

function dropsDocument(html: string): void {
  const result = htmlToText(html);
  expect(result.text, html).toBe("");
  expect(result.report.hiddenBlocks, html).toBeGreaterThanOrEqual(1);
  expect(result.truncated, html).toBe(true);
}

describe("a construct where parser and browser disagree drops the whole document", () => {
  const GATED: ReadonlyArray<readonly [name: string, html: string]> = [
    ["a CDATA section", "<p>shown</p><![CDATA[x]]><p>after</p>"],
    ["a CDATA section that opens markup", "<p>shown</p><![CDATA[><div hidden>]]>LEAK"],
    ["a marked section in upper case", "<p>shown</p><![cdata[ x ]]>"],
    ["a frameset", "<frameset></frameset>LEAK"],
    ["a frame", "<p>shown</p><frame src=x>LEAK"],
    ["a frameset in upper case", "<p>shown</p><FRAMESET rows=1><FRAME></FRAMESET>LEAK"],
    ["plaintext", "<p>shown</p><plaintext>LEAK"],
    ["xmp", "<p>shown</p><xmp><b>x</b></xmp><p>after</p>"],
    ["math", "<p>shown</p><math><mi>x</mi></math><p>after</p>"],
    ["svg", "<p>shown</p><svg><path d='M0'/></svg><p>after</p>"],
    ["svg in upper case", "<p>shown</p><SVG></SVG><p>after</p>"],
    ["annotation-xml", "LEAK <math><annotation-xml><style><p><html hidden>"],
    ["an annotation-xml without a math", "<p>shown</p><annotation-xml>x</annotation-xml>"],
  ];
  for (const [name, html] of GATED) {
    it(`drops everything for ${name}`, () => {
      dropsDocument(html);
    });
  }

  it("keeps the plain constructs the filter already handles", () => {
    for (const html of [
      "<p>shown</p><script>x()</script><p>after</p>",
      "<p>shown</p><style>.a{}</style><p>after</p>",
      "<p>shown</p><noscript>n</noscript><p>after</p>",
      "<p>shown</p><template><p>t</p></template><p>after</p>",
      "<p>shown</p><select><option>a<option>b</select><script>x()</script><p>after</p>",
    ]) {
      const result = htmlToText(html);
      expect(result.text, html).toContain("shown");
      expect(result.text, html).toContain("after");
    }
  });

  describe("a raw-text start tag while a select is open", () => {
    for (const raw of [
      "style",
      "xmp",
      "iframe",
      "noembed",
      "noframes",
      "title",
      "plaintext",
      "textarea",
      "script",
    ]) {
      it(`drops everything for <${raw}> inside a select`, () => {
        dropsDocument(`<p>shown</p><select><option>a<${raw}></select><div hidden></${raw}>LEAK`);
      });
    }

    it("does not drop the same tags after the select is closed", () => {
      const result = htmlToText(
        "<p>shown</p><select><option>a</select><style>.a{}</style><p>after</p>",
      );
      expect(result.text).toContain("shown");
      expect(result.text).toContain("after");
      expect(result.truncated).toBe(false);
    });
  });
});

describe("a document start tag after a stop discards everything, wherever it hides", () => {
  const STOP = "<p>VISIBLE</p><div><b hidden>H</div>";

  it("finds a body tag cut by the write boundary (Codex 1)", () => {
    const pre = STOP;
    const html = `${pre}${" ".repeat(WRITE_CHUNK_CHARS - pre.length - 5)}<body hidden>REST`;
    expect(html.indexOf("<body")).toBe(WRITE_CHUNK_CHARS - 5);
    const result = htmlToText(html);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(true);
  });

  for (const tag of ["html", "body", "frameset", "BODY", "Html"]) {
    for (const cut of [1, 2, 3, 4]) {
      it(`finds <${tag}> cut ${cut} characters in by the write boundary`, () => {
        const start = WRITE_CHUNK_CHARS - 1 - cut;
        const html = `${STOP}${" ".repeat(start - STOP.length)}<${tag} hidden>REST`;
        expect(html.indexOf(`<${tag}`)).toBe(start);
        const result = htmlToText(html);
        expect(result.text).toBe("");
        expect(result.truncated).toBe(true);
      });
    }
  }

  it("does not discard for a document tag the parser already read without a hiding signal", () => {
    // A plain <body> at the top was delivered as an event and hides nothing; the text before the
    // stop stays. Only a tag that never completed (cut by the boundary) or was never parsed counts.
    const result = htmlToText(`<body>${STOP}<p>VISIBLE</p>`);
    expect(result.text).toBe("VISIBLE");
    expect(result.truncated).toBe(true);
  });

  it("discards for a hiding body tag read after the stop, in the same chunk", () => {
    const result = htmlToText(`${STOP}<p>x</p><body hidden>`);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(true);
  });

  it("finds a document tag far after the stop", () => {
    const html = `${STOP}${"x".repeat(50_000)}<html hidden>REST`;
    expect(htmlToText(html).text).toBe("");
  });

  it("leaves a stopped document with no document tag as it was", () => {
    const result = htmlToText(`<p>VISIBLE</p><div><b hidden>H</div>LEAK<p>after</p>`);
    expect(result.text).toBe("VISIBLE");
    expect(result.truncated).toBe(true);
  });

  it("flags a late html hidden wipe as truncated", () => {
    const result = htmlToText("<p>shown</p><html hidden>tail");
    expect(result.text).toBe("");
    expect(result.truncated).toBe(true);
    expect(result.report.hiddenBlocks).toBeGreaterThanOrEqual(1);
  });

  it("flags a late body hidden wipe after the text cap as truncated", () => {
    const result = htmlToText(`<p>${"word ".repeat(6_000)}</p><body hidden>tail`);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(true);
  });
});

describe("noscript is raw text to a browser that runs scripts, markup to the parser", () => {
  it("discards when a raw-text element inside noscript never ends", () => {
    dropsDocument("<p>shown</p><noscript><title></noscript></html><html hidden>x");
  });

  it("discards when the raw-text body holds the noscript end tag", () => {
    dropsDocument("<p>shown</p><noscript><style>a</noscript><p>b</style></noscript><p>after</p>");
  });

  it("discards when that end tag is split across two parser writes", () => {
    const head = "<p>shown</p><noscript><style>";
    const pad = "a".repeat(WRITE_CHUNK_CHARS - head.length - 5);
    const html = `${head}${pad}</noscript></style></noscript><p>after</p>`;
    expect(html.indexOf("</noscript")).toBe(WRITE_CHUNK_CHARS - 5);
    dropsDocument(html);
  });

  it("keeps a noscript whose raw-text child ends before the noscript does", () => {
    const result = htmlToText(
      '<p>shown</p><noscript><iframe src="https://example.com/x"></iframe></noscript><p>after</p>',
    );
    expect(result.text).toBe("shown\nafter");
    expect(result.truncated).toBe(false);
  });
});

describe("a document tag swallowed as raw text after a stop still discards", () => {
  it("finds an html tag inside a title the parser reads as raw text", () => {
    const result = htmlToText("<p>shown</p><span hidden><div>y</span><title><html hidden>x");
    expect(result.text).toBe("");
    expect(result.truncated).toBe(true);
  });

  it("finds a body tag inside a textarea after a stop", () => {
    const result = htmlToText("<p>shown</p><b hidden>H<p>I</b><textarea><body hidden>");
    expect(result.text).toBe("");
  });
});

describe("closed details content is hidden until expanded", () => {
  it("drops everything but the first summary of a closed details, counted", () => {
    const result = htmlToText(
      "<details><summary>shown</summary>LEAK<p>MORE</p><summary>second</summary></details><p>after</p>",
    );
    expect(result.text).toBe("shown\nafter");
    expect(result.report.hiddenBlocks).toBeGreaterThanOrEqual(1);
  });

  it("keeps the content of a details with the open attribute", () => {
    const result = htmlToText("<details open><summary>shown</summary>body</details>");
    expect(result.text).toContain("shown");
    expect(result.text).toContain("body");
    expect(result.report.hiddenBlocks).toBe(0);
  });

  it("drops text of a closed details that has no summary", () => {
    const result = htmlToText("<details>LEAK</details><p>after</p>");
    expect(result.text).toBe("after");
  });
});
