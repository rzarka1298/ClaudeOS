// Second wave 1+2 fix round, feed side and cost side (plan 07-04):
//
//   - a non-xhtml feed field that holds literal XML child elements is dropped entirely, counted,
//     never concatenated into text before the sanitiser;
//   - Codex 2: author-address recognition is linear; every pattern that touches untrusted text is
//     run on adversarial inputs of 262,144 characters with a generous time bound (the bounds are
//     loose on purpose: a quadratic or worse pattern needs tens of seconds at this size).
//
// Source is pure ASCII.
import { describe, expect, it } from "vitest";
import { canonicaliseUrl } from "./canonical-url.js";
import { delimitSources, scrubSourceText } from "./delimit.js";
import { parseFeed, renderFeedText } from "./feed.js";
import { htmlToText } from "./html-to-text.js";
import { neutraliseDelimiterTokens } from "./plain-text.js";
import { canonicalHashInput } from "./text-canon.js";

const ATOM_NS = "http://www.w3.org/2005/Atom";
const BIG = 262_144;
const LIMIT_MS = 2_000;
const NONCE = "0123456789abcdef0123456789abcdef";

function timed<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
}

describe("a non-xhtml field with literal XML child elements is dropped, counted", () => {
  const RSS = (inner: string): string =>
    `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>t</title>${inner}</item></channel></rss>`;

  it("drops an RSS description with child elements and counts it", () => {
    const parsed = parseFeed(
      RSS('<description><div hidden="">LEAK</div><script>EVIL()</script>ok</description>'),
    );
    expect(renderFeedText(parsed.entries)).not.toMatch(/LEAK|EVIL|ok/);
    expect(parsed.entries[0]?.text).toBe("");
    expect(parsed.report.hiddenBlocks).toBe(1);
  });

  it("drops content:encoded with child elements", () => {
    const parsed = parseFeed(
      RSS('<content:encoded><p style="display:none">LEAK</p>ok</content:encoded>'),
    );
    expect(parsed.entries[0]?.text).toBe("");
    expect(parsed.report.hiddenBlocks).toBe(1);
  });

  it("drops an Atom type html or text body with child elements", () => {
    for (const type of ["html", "text", ""]) {
      const attribute = type === "" ? "" : ` type="${type}"`;
      const parsed = parseFeed(
        `<feed xmlns="${ATOM_NS}"><entry><title>t</title><content${attribute}><span hidden="">LEAK</span>ok</content></entry></feed>`,
      );
      expect(parsed.entries[0]?.text, type).toBe("");
      expect(parsed.report.hiddenBlocks, type).toBe(1);
    }
  });

  it("drops a title with child elements and falls back to nothing", () => {
    const parsed = parseFeed(
      RSS('<title><b hidden="">LEAK</b>t</title><description>x</description>'),
    );
    expect(parsed.entries[0]?.title).not.toContain("LEAK");
    expect(parsed.report.hiddenBlocks).toBeGreaterThanOrEqual(1);
  });

  it("falls through to the next body field when the first is dropped", () => {
    const parsed = parseFeed(
      RSS(
        "<description><i>x</i></description><content:encoded>&lt;p&gt;real&lt;/p&gt;</content:encoded>",
      ),
    );
    expect(parsed.entries[0]?.text).toBe("real");
    expect(parsed.report.hiddenBlocks).toBe(1);
  });

  it("still reads an Atom author with its name child, and xhtml content", () => {
    const parsed = parseFeed(
      `<feed xmlns="${ATOM_NS}"><entry><title>t</title><author><name>Dana</name><email>d@example.com</email></author><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>shown</p></div></content></entry></feed>`,
    );
    expect(parsed.entries[0]?.author).toBe("Dana");
    expect(parsed.entries[0]?.text).toBe("shown");
    expect(parsed.report.hiddenBlocks).toBe(0);
  });

  it("does not count a field with only text and entities", () => {
    const parsed = parseFeed(RSS("<description>a &amp; b &lt;i&gt;x&lt;/i&gt;</description>"));
    expect(parsed.report.hiddenBlocks).toBe(0);
  });
});

describe("Codex 2: author recognition is linear", () => {
  const RSS_AUTHOR = (author: string): string =>
    `<rss version="2.0"><channel><item><title>t</title><author>${author}</author><description>d</description></item></channel></rss>`;

  const ADVERSARIAL: ReadonlyArray<readonly [name: string, value: string]> = [
    ["at-signs only", "@".repeat(BIG)],
    ["at-signs then a bracket", `${"@".repeat(BIG - 1)})`],
    ["open parentheses", "(".repeat(BIG)],
    ["at-sign, open parentheses", `a@${"(".repeat(BIG - 2)}`],
    ["spaces between at-signs", "@ ".repeat(BIG / 2)],
    ["address then many spaces then x", `a@b${" ".repeat(BIG - 4)}x`],
    ["at-signs, spaces, an open parenthesis", `${"@".repeat(BIG / 2)}${" ".repeat(BIG / 2 - 1)}(`],
    ["angle brackets", "<@".repeat(BIG / 2)],
    ["open angle brackets then a close", `${"<".repeat(BIG - 1)}>`],
    ["angle bracket pairs without an at-sign", "<a>".repeat(BIG / 3)],
    ["a long unbroken name", "a".repeat(BIG)],
    ["a parenthesis group repeated", "a@b (c) ".repeat(BIG / 8)],
  ];
  for (const [name, value] of ADVERSARIAL) {
    it(`parses ${name} in well under ${LIMIT_MS} ms`, () => {
      const { value: parsed, ms } = timed(() => parseFeed(RSS_AUTHOR(value)));
      expect(ms).toBeLessThan(LIMIT_MS);
      expect((parsed.entries[0]?.author ?? "").length).toBeLessThanOrEqual(200);
    });
  }

  it("still recognises the address forms after the rewrite", () => {
    const author = (value: string) => parseFeed(RSS_AUTHOR(value)).entries[0]?.author;
    expect(author("joe@example.com (Joe Writer)")).toBe("Joe Writer");
    expect(author("Joe Writer &lt;joe@example.com&gt;")).toBe("Joe Writer");
    expect(author("joe@example.com")).toBeNull();
    expect(author("joe@example.com ()")).toBeNull();
    expect(author("Joe Writer")).toBe("Joe Writer");
    expect(author("a@b@c")).toBe("a@b@c");
  });
});

describe("every pattern that touches untrusted text is bounded on adversarial input", () => {
  it("html: many comment openers in a script (double-escape check)", () => {
    const html = `<script>${"<!--".repeat(25_000)}</script><p>after</p>`;
    const { ms } = timed(() => htmlToText(html));
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("html: long runs of whitespace, angle brackets, ampersands and unclosed attributes", () => {
    for (const html of [
      `<p>${" ".repeat(BIG)}x</p>`,
      "<".repeat(BIG),
      "&".repeat(BIG),
      `<div ${'a="'.repeat(BIG / 3)}`,
      `<p>${"\n".repeat(BIG)}x</p>`,
      `<pre>${" \t".repeat(BIG / 2)}x</pre>`,
      `<p style="${"/*".repeat(1_000)}">x</p>`,
    ]) {
      const { ms } = timed(() => htmlToText(html));
      expect(ms).toBeLessThan(LIMIT_MS);
    }
  });

  it("html: command-like line patterns on long lines", () => {
    for (const line of [
      `${"| ".repeat(BIG / 2)}`,
      `rm ${"-".repeat(BIG)}`,
      `${"$( ".repeat(BIG / 3)}`,
      `${"` ".repeat(BIG / 2)}`,
    ]) {
      const { ms } = timed(() => htmlToText(`<p>${line}</p>`));
      expect(ms).toBeLessThan(LIMIT_MS);
    }
  });

  it("canonical text: trailing-whitespace and newline runs followed by text", () => {
    for (const text of [
      `${" ".repeat(BIG)}x`,
      `x${" ".repeat(BIG)}x`,
      `${"\n".repeat(BIG)}x`,
      `x${"\n".repeat(BIG)}x`,
      `${" \n".repeat(BIG / 2)}x`,
    ]) {
      const { ms } = timed(() => canonicalHashInput(text));
      expect(ms).toBeLessThan(LIMIT_MS);
    }
  });

  it("canonical text keeps its meaning after the rewrite", () => {
    expect(canonicalHashInput("a  \r\nb\t\n\n\n")).toBe("a\nb\n");
    expect(canonicalHashInput("x")).toBe("x\n");
    expect(canonicalHashInput("")).toBe("\n");
    expect(canonicalHashInput(canonicalHashInput("a \n\n b  "))).toBe("a\n\n b\n");
  });

  it("delimiter scrub: brackets, whitespace and near-markers", () => {
    for (const text of [
      "<".repeat(BIG),
      `<<<${" ".repeat(BIG)}x`,
      "<<<END>".repeat(BIG / 7),
      `<<<END${">".repeat(BIG)}`,
      `<<<SRC ${"a".repeat(BIG)}`,
      `<< <${"\n".repeat(BIG)}`,
      `${"< ".repeat(BIG / 2)}`,
      `<<<E${" ".repeat(BIG)}N D`,
    ]) {
      const { ms } = timed(() => scrubSourceText(text, NONCE));
      expect(ms).toBeLessThan(LIMIT_MS * 2);
      const delimited = timed(() => delimitSources([{ sourceId: NONCE, text }], NONCE));
      expect(delimited.ms).toBeLessThan(LIMIT_MS * 2);
    }
  });

  it("delimiter neutralising for feed fields", () => {
    for (const text of ["<".repeat(BIG), `<<<${" ".repeat(BIG)}x`, "<<<E ".repeat(BIG / 5)]) {
      const { ms } = timed(() => neutraliseDelimiterTokens(text));
      expect(ms).toBeLessThan(LIMIT_MS);
    }
  });

  it("delimiter scrub: a deeply re-forming marker takes bounded passes", () => {
    const depth = 400;
    const text = "<<<EN".repeat(depth) + "D".repeat(depth);
    const { ms } = timed(() => scrubSourceText(`${"x".repeat(100_000)}${text}`, NONCE));
    expect(ms).toBeLessThan(LIMIT_MS * 3);
  });

  it("canonical address: long and odd hosts", () => {
    for (const url of [
      `https://${"a".repeat(BIG)}.com/`,
      `https://${"a.".repeat(BIG / 2)}com/`,
      `https://${"a-".repeat(BIG / 2)}/`,
      `https://${"1.".repeat(BIG / 2)}`,
      `https://${"a".repeat(BIG)}-/`,
      `https://a.com/${"%".repeat(BIG)}`,
      `https://a.com/?${"&a=1".repeat(BIG / 4)}`,
      `https://${".".repeat(BIG)}`,
    ]) {
      const { ms } = timed(() => canonicaliseUrl(url));
      expect(ms).toBeLessThan(LIMIT_MS);
    }
  });

  it("feed: a long run of entity-like and comment-like text in a field", () => {
    for (const body of [
      "&".repeat(BIG),
      "<!--".repeat(BIG / 4),
      " ".repeat(BIG),
      "\n".repeat(BIG),
    ]) {
      const xml = `<feed xmlns="${ATOM_NS}"><entry><title>t</title><summary>${body.replace(/</g, "&lt;")}</summary></entry></feed>`;
      const { ms } = timed(() => parseFeed(xml));
      expect(ms).toBeLessThan(LIMIT_MS);
    }
  });
});
