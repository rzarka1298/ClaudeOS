// Third wave 1+2 fix round (plan 07-04): the simplest coarse fail-closed rule for each finding of
// the opus re-check and Codex round 3.
//
//   - any `<noscript` in the input drops the whole document (a browser that runs scripts ends a
//     noscript at the first literal `</noscript`, wherever it is, so no partial handling can be
//     trusted);
//   - a closed details counts as hidden content for the misnest gates;
//   - a body or html tag wipes the document only for its OWN hiding attributes;
//   - the delimited-block parser does not rescan for a footer from every header;
//   - the sink's own bookkeeping stays cheap on nested hidden content.
//
// Source is pure ASCII.
import { describe, expect, it } from "vitest";
import { delimitSources, parseDelimitedBlocks } from "./delimit.js";
import { htmlToText } from "./html-to-text.js";

function dropsDocument(html: string): void {
  const result = htmlToText(html);
  expect(result.text, html).toBe("");
  expect(result.report.hiddenBlocks, html).toBeGreaterThanOrEqual(1);
  expect(result.truncated, html).toBe(true);
}

describe("any noscript drops the whole document", () => {
  const CASES: ReadonlyArray<readonly [name: string, html: string]> = [
    ["a plain noscript", "<p>shown</p><noscript>n</noscript><p>after</p>"],
    ["a noscript in upper case", "<p>shown</p><NOSCRIPT>n</NOSCRIPT>"],
    ["a noscript in the head", "<head><noscript><link rel=x></noscript></head><p>shown</p>"],
    [
      "an iframe in noscript (tag manager)",
      '<p>shown</p><noscript><iframe src="x"></iframe></noscript>',
    ],
    [
      "a comment holding the end tag",
      "<p>shown</p><noscript><!-- </noscript><div hidden> --></noscript> LEAK",
    ],
    [
      "a comment holding a hiding body",
      "LEAK <noscript><!-- </noscript><body hidden> --></noscript>",
    ],
    [
      "an attribute value holding the end tag",
      'LEAK <noscript><p title="</noscript><body hidden>"></noscript>',
    ],
    ["a noscript with attributes", '<p>shown</p><noscript class="a">n</noscript>'],
  ];
  for (const [name, html] of CASES) {
    it(`drops everything for ${name}`, () => {
      dropsDocument(html);
    });
  }

  it("does not drop a page that only mentions the word", () => {
    const result = htmlToText("<p>shown</p><p>the noscript element is rare</p>");
    expect(result.text).toBe("shown\nthe noscript element is rare");
  });
});

describe("a closed details is hidden content for the misnest gates", () => {
  for (const html of [
    "<b><details></b> LEAK",
    "<a><details></a> LEAK",
    "<span><details></span> LEAK",
    "<label><details></label> LEAK",
    "<form><details></form> LEAK",
  ]) {
    it(`does not emit text after ${html}`, () => {
      const result = htmlToText(html);
      expect(result.text.includes("LEAK") && !result.truncated, html).toBe(false);
    });
  }

  it("still reads an ordinary closed details with plain content", () => {
    const result = htmlToText("<details><summary>shown</summary>hidden</details><p>after</p>");
    expect(result.text).toBe("shown\nafter");
    expect(result.truncated).toBe(false);
  });
});

describe("a body or html tag wipes the document only for its own hiding attributes (Codex 4)", () => {
  it("does not wipe for a plain body token inside a closed details", () => {
    const result = htmlToText(
      "<p>before</p><details><summary>summary</summary><body></details><p>after</p>",
    );
    // The summary is read; the body token inside the closed details makes the end tag undecidable
    // (a closed details is hidden context), so the remainder is dropped, not the whole page.
    expect(result.text).toBe("before\nsummary");
    expect(result.truncated).toBe(true);
  });

  it("does not wipe for a plain html token inside a hidden element", () => {
    const result = htmlToText("<p>before</p><div hidden><html></div><p>after</p>");
    // Not wiped by inherited hiding; the undecidable end tag drops the remainder only.
    expect(result.text).toBe("before");
    expect(result.truncated).toBe(true);
  });

  it("still wipes for a body that carries its own hiding attribute, even inside a details", () => {
    dropsDocument("<p>before</p><details><summary>s</summary><body hidden></details><p>after</p>");
  });

  it("still wipes for a body with a style outside the allowlist", () => {
    dropsDocument('<p>before</p><body style="opacity:0.5"><p>after</p>');
  });
});

describe("work stays bounded on adversarial structure", () => {
  it("handles hundreds of nested hidden elements followed by many implied closes", () => {
    const html = `${"<div hidden>".repeat(400)}${"<p>x".repeat(40_000)}`;
    const started = performance.now();
    htmlToText(html);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it("handles a long run of unclosed list items under a hidden list", () => {
    const html = `<ul hidden>${"<li>x".repeat(60_000)}</ul><p>after</p>`;
    const started = performance.now();
    htmlToText(html);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe("the block parser does not rescan for a footer from every header", () => {
  const NONCE = "0123456789abcdef0123456789abcdef";
  const ID = "fedcba9876543210fedcba9876543210";

  it("parses a composed text with many headers and one bad footer in linear time", () => {
    const header = `<<<SRC id=${ID} nonce=${NONCE}>>>\n`;
    const text = `${header.repeat(40_000)}\n<<<END nonce=${NONCE}>>>x`;
    const started = performance.now();
    parseDelimitedBlocks(text);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("still parses well-formed blocks", () => {
    const composed = delimitSources(
      [
        { sourceId: ID, text: "one" },
        { sourceId: "0123456789abcdef0123456789abcdef", text: "two\nlines" },
      ],
      NONCE,
    );
    expect(parseDelimitedBlocks(composed).map((block) => block.text)).toEqual([
      "one",
      "two\nlines",
    ]);
  });
});
