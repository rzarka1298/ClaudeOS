// Feed parsing is XML-mode only and entity-inert (research R2, Pitfall 6, D-09).
// Every document here is a fixture string: no test reaches the network.
import { describe, expect, it } from "vitest";
import { delimitSources, parseDelimitedBlocks } from "./delimit.js";
import { parseFeed, renderFeedText } from "./feed.js";

const ID_A = "0123456789abcdef0123456789abcdef";
const NONCE = "00112233445566778899aabbccddeeff";

const ATOM_TWO_ENTRIES = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Release notes</title>
  <updated>2026-10-02T10:00:00Z</updated>
  <entry>
    <title>Tool 2.0 released</title>
    <link rel="alternate" href="https://example.invalid/tool/2.0"/>
    <updated>2026-10-02T10:00:00Z</updated>
    <author><name>Release Bot</name></author>
    <summary>Version 2.0 adds a faster parser.</summary>
  </entry>
  <entry>
    <title>Tool 1.9 released</title>
    <link href="https://example.invalid/tool/1.9"/>
    <updated>2026-09-20T08:30:00Z</updated>
    <author><name>Release Bot</name></author>
    <summary>Version 1.9 fixes a crash.</summary>
  </entry>
</feed>`;

describe("Test 1 (tracer): an Atom feed becomes delimited plain text", () => {
  it("parses two entries with title, link, updated instant, author and plain content text", () => {
    const parsed = parseFeed(ATOM_TWO_ENTRIES);
    expect(parsed.format).toBe("atom");
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toEqual({
      title: "Tool 2.0 released",
      link: "https://example.invalid/tool/2.0",
      updated: "2026-10-02T10:00:00.000Z",
      author: "Release Bot",
      text: "Version 2.0 adds a faster parser.",
    });
    expect(parsed.entries[1]?.title).toBe("Tool 1.9 released");
    expect(parsed.entries[1]?.link).toBe("https://example.invalid/tool/1.9");
  });

  it("wraps the joined entry text in one block carrying the id and nonce, and parses it back", () => {
    const parsed = parseFeed(ATOM_TWO_ENTRIES);
    const joined = renderFeedText(parsed.entries);
    expect(joined).toContain("Tool 2.0 released");
    expect(joined).toContain("Version 1.9 fixes a crash.");

    const composed = delimitSources([{ sourceId: ID_A, text: joined }], NONCE);
    expect(composed).toContain(`<<<SRC id=${ID_A} nonce=${NONCE}>>>`);
    expect(composed).toContain(`<<<END nonce=${NONCE}>>>`);

    const blocks = parseDelimitedBlocks(composed);
    expect(blocks).toEqual([{ sourceId: ID_A, text: joined }]);
  });
});

describe("Test 2 (XML inertness): a DOCTYPE cannot read a file or expand", () => {
  const XXE = `<?xml version="1.0"?>
<!DOCTYPE feed [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
  <!ENTITY a "AAAAAAAAAA">
  <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
  <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
]>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>T &xxe; &c; &amp; end</title>
    <updated>2026-10-01T00:00:00Z</updated>
    <summary>S &xxe;</summary>
  </entry>
</feed>`;

  it("leaves the entity references literal in the title and expands nothing", () => {
    const parsed = parseFeed(XXE);
    expect(parsed.entries).toHaveLength(1);
    const title = parsed.entries[0]?.title ?? "";
    expect(title).toBe("T &xxe; &c; & end");
    expect(title).not.toContain("root:");
    expect(title).not.toContain("AAAA");
    expect(parsed.entries[0]?.text).toBe("S &xxe;");
  });

  it("produces no entry from the DOCTYPE itself", () => {
    const parsed = parseFeed(XXE);
    expect(parsed.format).toBe("atom");
    expect(parsed.entries).toHaveLength(1);
  });
});

const RSS_TEMPLATE = (items: string): string =>
  `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>C</title>${items}</channel></rss>`;

describe("Test 6 (feeds): RSS and Atom, newest five, caps and one sanitiser pass", () => {
  it("parses RSS 2.0 with pubDate, dc:creator, link text and description", () => {
    const parsed = parseFeed(
      RSS_TEMPLATE(
        `<item><title>Release 3</title><link>https://example.invalid/r3</link><pubDate>Tue, 06 Oct 2026 12:30:00 +0200</pubDate><dc:creator>Dana</dc:creator><description>Plain description.</description></item>`,
      ),
    );
    expect(parsed.format).toBe("rss");
    expect(parsed.entries).toEqual([
      {
        title: "Release 3",
        link: "https://example.invalid/r3",
        updated: "2026-10-06T10:30:00.000Z",
        author: "Dana",
        text: "Plain description.",
      },
    ]);
  });

  it("prefers content:encoded over description and reads an RFC 822 zone name", () => {
    const parsed = parseFeed(
      RSS_TEMPLATE(
        `<item><title>A</title><pubDate>Mon, 05 Oct 2026 08:00:00 EST</pubDate><description>short</description><content:encoded><![CDATA[<p>the <b>long</b> body</p>]]></content:encoded></item>`,
      ),
    );
    expect(parsed.entries[0]?.text).toBe("the long body");
    expect(parsed.entries[0]?.updated).toBe("2026-10-05T13:00:00.000Z");
  });

  it("keeps only the newest five entries by date, newest first", () => {
    const items = Array.from({ length: 8 }, (_, i) => {
      const day = String(i + 1).padStart(2, "0");
      return `<item><title>Entry ${i + 1}</title><pubDate>2026-09-${day}T00:00:00Z</pubDate></item>`;
    }).join("");
    const parsed = parseFeed(RSS_TEMPLATE(items));
    expect(parsed.entries.map((e) => e.title)).toEqual([
      "Entry 8",
      "Entry 7",
      "Entry 6",
      "Entry 5",
      "Entry 4",
    ]);
  });

  it("keeps the first five in document order when no entry carries a date", () => {
    const items = Array.from({ length: 7 }, (_, i) => `<item><title>N${i + 1}</title></item>`).join("");
    const parsed = parseFeed(RSS_TEMPLATE(items));
    expect(parsed.entries.map((e) => e.title)).toEqual(["N1", "N2", "N3", "N4", "N5"]);
    expect(parsed.entries.every((e) => e.updated === null)).toBe(true);
  });

  it("ranks dated entries before undated ones", () => {
    const parsed = parseFeed(
      RSS_TEMPLATE(
        `<item><title>undated</title></item><item><title>dated</title><pubDate>2026-01-01T00:00:00Z</pubDate></item>`,
      ),
    );
    expect(parsed.entries.map((e) => e.title)).toEqual(["dated", "undated"]);
  });

  it("caps each entry's text at 4,000 characters at a character boundary", () => {
    const body = `${"a".repeat(3_999)}\uD83D\uDE00${"b".repeat(50)}`;
    const parsed = parseFeed(RSS_TEMPLATE(`<item><title>T</title><description>${body}</description></item>`));
    const text = parsed.entries[0]?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(4_000);
    expect(text.startsWith("aaaa")).toBe(true);
    expect(text).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("caps a title and an author at 200 characters", () => {
    const parsed = parseFeed(
      RSS_TEMPLATE(
        `<item><title>${"t".repeat(500)}</title><dc:creator>${"c".repeat(500)}</dc:creator></item>`,
      ),
    );
    expect(parsed.entries[0]?.title).toHaveLength(200);
    expect(parsed.entries[0]?.author).toHaveLength(200);
  });

  it("runs content declared type html through the sanitiser once and counts what it removes", () => {
    const parsed = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>H</title><content type="html">&lt;p&gt;visible&lt;/p&gt;&lt;script&gt;STEAL()&lt;/script&gt;&lt;!-- HIDDEN_COMMENT --&gt;&lt;img src="x"&gt;</content></entry></feed>`);
    expect(parsed.entries[0]?.text).toBe("visible");
    expect(parsed.report.scripts).toBe(1);
    expect(parsed.report.comments).toBe(1);
    expect(parsed.report.mediaDropped).toBe(1);
  });

  it("treats Atom content with no type, or type text, as literal text that is never re-parsed", () => {
    const parsed = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>L</title><summary>&lt;script&gt;LITERAL_TEXT&lt;/script&gt;</summary></entry><entry><title>M</title><content type="text">&lt;b&gt;bold?&lt;/b&gt;</content></entry></feed>`);
    const texts = parsed.entries.map((e) => e.text);
    expect(texts).toContain("<script>LITERAL_TEXT</script>");
    expect(texts).toContain("<b>bold?</b>");
    expect(parsed.report.scripts).toBe(0);
  });

  it("does not decode a double-encoded entity a second time after the sanitiser", () => {
    const parsed = parseFeed(RSS_TEMPLATE(`<item><title>D</title><description>&amp;lt;script&amp;gt;DOUBLE&amp;lt;/script&amp;gt;</description></item>`));
    expect(parsed.entries[0]?.text).toBe("&lt;script&gt;DOUBLE&lt;/script&gt;");
    expect(parsed.report.scripts).toBe(0);
  });

  it("reads Atom xhtml content by re-serialising its elements through the sanitiser", () => {
    const parsed = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>X</title><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>shown</p><p style="display:none">HIDDEN_TEXT</p><script>STEAL()</script></div></content></entry></feed>`);
    expect(parsed.entries[0]?.text).toBe("shown");
    expect(parsed.report.hiddenBlocks).toBe(1);
    expect(parsed.report.scripts).toBe(1);
  });

  it("sanitises a title declared html and strips control characters from plain titles", () => {
    const parsed = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">&lt;b&gt;Bold&lt;/b&gt; title</title></entry><entry><title>plain&#x202E;&#x200B; one</title></entry></feed>`);
    const titles = parsed.entries.map((e) => e.title);
    expect(titles).toContain("Bold title");
    expect(titles).toContain("plain one");
    expect(parsed.report.controlChars).toBe(2);
  });

  it("returns an unknown format with no entries for a document that is not a feed", () => {
    expect(parseFeed("<html><body>hi</body></html>")).toMatchObject({ format: "unknown", entries: [] });
    expect(parseFeed("")).toMatchObject({ format: "unknown", entries: [] });
    expect(() => parseFeed("<feed><entry><title>unterminated")).not.toThrow();
  });

  it("rejects a date it cannot read instead of guessing", () => {
    const parsed = parseFeed(RSS_TEMPLATE(`<item><title>B</title><pubDate>Item 5</pubDate></item><item><title>C</title><pubDate>2026-02-31T00:00:00Z</pubDate></item>`));
    expect(parsed.entries.every((e) => e.updated === null)).toBe(true);
  });

  it("ignores items nested inside an entry and elements nested deeper than 512", () => {
    let deep = "";
    for (let i = 0; i < 600; i += 1) deep += "<x>";
    const parsed = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Deep</title><summary>${deep}DEEP_TEXT</summary></entry></feed>`,
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.title).toBe("Deep");
    expect(parsed.entries[0]?.text).not.toContain("DEEP_TEXT");
  });

  it("leaves the link out of the rendered text", () => {
    const parsed = parseFeed(RSS_TEMPLATE(`<item><title>L</title><link>https://example.invalid/secret-path</link><description>body</description></item>`));
    expect(renderFeedText(parsed.entries)).toBe("L\nbody");
  });
});
