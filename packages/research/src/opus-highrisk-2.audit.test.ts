// Wave 2 opus RE-CHECK (second fix round, head 36e239b8). Each test below is a CONFIRMED defect
// found by the parse5 8.0.1 differential (scripting on) or by direct probing against dist at that
// head. They are committed SKIPPED: un-skipping any one of them fails at 36e239b8. The product
// code is not changed by the review. Severity is in each name; reasoning is in
// 07-WAVE-REVIEWS.md (wave 2, "Opus re-check"). Pure ASCII source by design.
import { describe, expect, it } from "vitest";
import { parseFeed } from "./feed.js";
import { htmlToText } from "./html-to-text.js";

function shows(html: string, marker = "LEAK"): boolean {
  return htmlToText(html).text.includes(marker);
}

describe("opus re-check: noscript ended inside a comment or an attribute", () => {
  // BLOCKER. With scripting on a browser reads noscript as raw text up to the FIRST literal
  // `</noscript`, wherever it sits. The new noscript gate only watches the text of a raw-text
  // element inside noscript; a comment (or an attribute value) holding `</noscript>` is not
  // watched. In the browser the markup after it is live: a body/html hidden hides the page, a
  // div hidden hides what follows. The filter emits it, truncated false, hiddenBlocks 0 or 1.
  it.skip("BLOCKER: a comment inside noscript hides a following hidden div", () => {
    expect(shows("<p>shown</p><noscript><!-- </noscript><div hidden> --></noscript> LEAK")).toBe(
      false,
    );
  });
  it.skip("BLOCKER: a comment inside noscript hides the whole document (body hidden)", () => {
    expect(shows("LEAK <noscript><!-- </noscript><body hidden> --></noscript>")).toBe(false);
    expect(shows("<head><noscript><!-- </noscript><body hidden> --></noscript></head> LEAK")).toBe(
      false,
    );
  });
  it.skip("BLOCKER: an attribute value inside noscript hides the whole document", () => {
    // Stops at the final </noscript> (after the attribute), so the post-stop scan starts too late.
    expect(shows('LEAK <noscript><p title="</noscript><body hidden>"></noscript>')).toBe(false);
  });
});

describe("opus re-check: closed details is not part of the misnest gates", () => {
  // MINOR (same class as the wave 2 MINOR it fixes). A closed details frame does not count as
  // hidden (hides false, hiddenDepth 0), so runHidden stays false and the adoption agency, a
  // generic end tag behind a special element and `</form>` pop it in the parser while a browser
  // keeps it open. Found by the differential (5 of 1.1 million documents, all this root cause).
  it.skip("MINOR: a misnested end tag closes details in the parser only", () => {
    for (const html of [
      "<b><details></b> LEAK",
      "<a><details></a> LEAK",
      "<span><details></span> LEAK",
      "<label><details></label> LEAK",
      "<form><details></form> LEAK",
    ]) {
      expect(shows(html), html).toBe(false);
    }
  });
});

describe("opus re-check: the style allowlist admits hiding styles", () => {
  // MAJOR. Colour: the pair rule is per element and the defaults are known. A system colour equal
  // to the canvas, a dark background alone on default (black) text, a light colour alone on the
  // default (white) canvas, and a colour/background pair split over parent and child all render
  // nothing readable without any stylesheet.
  it.skip("MAJOR: colour hiding passes the allowlist", () => {
    for (const html of [
      '<p style="color:canvas">LEAK</p>',
      '<p style="background-color:canvastext">LEAK</p>',
      '<p style="background-color:black">LEAK</p>',
      '<p style="color:#fff">LEAK</p>',
      '<div style="background-color:#000"><span style="color:#000">LEAK</span></div>',
      '<div style="color:#000"><span style="background-color:#000">LEAK</span></div>',
    ]) {
      expect(shows(html), html).toBe(false);
    }
  });

  // MAJOR. CSS 2.1 17.2.1: every child box of a table-column parent is display:none.
  it.skip("MAJOR: display table-column and table-column-group hide their content", () => {
    expect(shows('<div style="display:table-column">LEAK</div>')).toBe(false);
    expect(shows('<div style="display:table-column-group">LEAK</div>')).toBe(false);
  });

  // MAJOR. Relative font sizes compound down the tree like opacity did (wave 2 MAJOR 3): ten
  // nested 60% is 0.6 percent of the base size, about 0.1px.
  it.skip("MAJOR: relative font-size compounds to invisible across ancestors", () => {
    const nest = (style: string, depth: number): string =>
      `${`<span style="${style}">`.repeat(depth)}LEAK${"</span>".repeat(depth)}`;
    expect(shows(nest("font-size:60%", 10))).toBe(false);
    expect(shows(nest("font-size:0.6em", 10))).toBe(false);
    expect(shows(nest("font-size:smaller", 25))).toBe(false);
  });

  // MINOR. No upper bound on sizes: the text is pushed or blown far off screen.
  it.skip("MINOR: unbounded sizes move text out of view", () => {
    for (const html of [
      '<p style="font-size:99999px">LEAK</p>',
      '<p style="border-top:100000px solid">LEAK</p>',
      '<p style="line-height:0.0001">LEAK</p>',
    ]) {
      expect(shows(html), html).toBe(false);
    }
  });
});

describe("opus re-check: feed namespace registry", () => {
  const pad = `<x:pad xmlns:x="urn:pad"${Array.from(
    { length: 2_100 },
    (_, i) => ` xmlns:p${i}="urn:p${i}"`,
  ).join("")}/>`;
  const entry = (summary: string): string =>
    `<entry><title>ok</title><link href="https://example.com/a"/><id>1</id>` +
    `<updated>2026-01-01T00:00:00Z</updated>${summary}</entry>`;

  // MAJOR. Past the 2,048-declaration budget a declaration is skipped with `continue`, so a
  // REDECLARED prefix (or default namespace) keeps the PARENT's binding instead of becoming
  // unknown. An Atom summary moved into a foreign namespace, which a namespace-aware reader
  // ignores, is read as the entry text. Counted once, but emitted: not fail closed.
  it.skip("MAJOR: a dropped default-namespace redeclaration falls back to Atom", () => {
    const feed =
      `<feed xmlns="http://www.w3.org/2005/Atom"><title>f</title>${pad}` +
      `${entry('<summary xmlns="urn:x:other">LEAK</summary>')}</feed>`;
    expect(JSON.stringify(parseFeed(feed).entries)).not.toContain("LEAK");
  });
  it.skip("MAJOR: a dropped prefix redeclaration falls back to the parent binding", () => {
    const feed =
      `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:a="http://www.w3.org/2005/Atom">` +
      `<title>f</title>${pad}${entry('<a:summary xmlns:a="urn:x:other">LEAK</a:summary>')}</feed>`;
    expect(JSON.stringify(parseFeed(feed).entries)).not.toContain("LEAK");
  });

  // MINOR. removeAngleAddresses re-runs indexOf(">") from every "<" of a "<<<...>" run:
  // quadratic (65,536 -> 37 ms, 131,072 -> 132 ms, 262,000 -> 500 ms on the review machine).
  // Bounded by the 1 MiB feed cap to about 2 s, but the summary calls it linear.
  it.skip("MINOR: author address removal is quadratic on a run of angle brackets", () => {
    const author = `<![CDATA[${"<".repeat(262_000)}>]]>`;
    const feed =
      `<rss><channel><item><title>t</title><link>https://example.com/a</link>` +
      `<author>${author}</author></item></channel></rss>`;
    const started = performance.now();
    parseFeed(feed);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
