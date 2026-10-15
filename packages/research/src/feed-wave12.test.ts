// Wave 1+2 review fixes for the feed parser (plan 07-04):
//
//   - BLOCKER 2 / Codex 1: an RSS `description` is entity-encoded HTML by specification and is
//     sanitised exactly once after XML decoding; Atom keeps its text construct semantics;
//   - Codex 4: feed elements are matched by namespace and local name, not by the prefix a feed
//     happens to use; elements in a namespace the parser does not know are ignored;
//   - minor: an RSS author that is an e-mail address stores the name only, never the address.
//
// Fixtures are strings: nothing here reaches the network. Source is pure ASCII.
import { describe, expect, it } from "vitest";
import { parseFeed } from "./feed.js";

const RSS = (item: string): string =>
  `<rss version="2.0"><channel><title>C</title><item><title>T</title>${item}</item></channel></rss>`;

const ATOM_NS = "http://www.w3.org/2005/Atom";
const EVIL_NS = "http://evil.invalid/ns";

describe("BLOCKER 2: an RSS description is HTML, sanitised once after XML decoding", () => {
  it("removes script, a hidden block and an event handler from an entity-encoded description", () => {
    const parsed = parseFeed(
      RSS(
        "<description>&lt;p&gt;Visible paragraph&lt;/p&gt;&lt;script&gt;SCRIPT_BODY()&lt;/script&gt;&lt;div style=&quot;display:none&quot;&gt;HIDDEN_BODY&lt;/div&gt;&lt;img src=&quot;x&quot; onerror=&quot;ONERROR_BODY()&quot;&gt;</description>",
      ),
    );
    const text = parsed.entries[0]?.text ?? "";
    expect(text).toBe("Visible paragraph");
    expect(parsed.report.scripts).toBe(1);
    expect(parsed.report.hiddenBlocks).toBe(1);
    expect(parsed.report.mediaDropped).toBe(1);
  });

  it("removes the same from a CDATA description", () => {
    const parsed = parseFeed(
      RSS(
        "<description><![CDATA[<p>Visible paragraph</p><script>SCRIPT_BODY()</script><p hidden>HIDDEN_BODY</p><img src=x onerror=ONERROR_BODY()>]]></description>",
      ),
    );
    expect(parsed.entries[0]?.text).toBe("Visible paragraph");
    expect(parsed.report.scripts).toBe(1);
    expect(parsed.report.hiddenBlocks).toBe(1);
    expect(parsed.report.mediaDropped).toBe(1);
  });

  it("decodes a double-encoded description once and never parses what it decoded", () => {
    const parsed = parseFeed(
      RSS("<description>&amp;lt;script&amp;gt;DOUBLE&amp;lt;/script&amp;gt;</description>"),
    );
    expect(parsed.entries[0]?.text).toBe("<script>DOUBLE</script>");
    expect(parsed.report.scripts).toBe(0);
  });

  it("treats other body elements of an RSS item without a type as HTML too", () => {
    const parsed = parseFeed(
      RSS("<summary>&lt;p&gt;kept&lt;/p&gt;&lt;script&gt;S()&lt;/script&gt;</summary>"),
    );
    expect(parsed.entries[0]?.text).toBe("kept");
    expect(parsed.report.scripts).toBe(1);
  });

  it("treats a feed with no recognised root like RSS: HTML unless Atom says text", () => {
    const parsed = parseFeed(
      "<channel><item><title>T</title><description>&lt;p&gt;kept&lt;/p&gt;&lt;script&gt;S()&lt;/script&gt;</description></item></channel>",
    );
    expect(parsed.entries[0]?.text).toBe("kept");
    expect(parsed.report.scripts).toBe(1);
  });

  it("keeps Atom type text and Atom with no type literal", () => {
    const parsed = parseFeed(
      `<feed xmlns="${ATOM_NS}"><entry><title>A</title><summary>&lt;script&gt;LITERAL_A&lt;/script&gt;</summary></entry><entry><title>B</title><content type="text">&lt;b&gt;LITERAL_B&lt;/b&gt;</content></entry></feed>`,
    );
    const texts = parsed.entries.map((entry) => entry.text);
    expect(texts).toContain("<script>LITERAL_A</script>");
    expect(texts).toContain("<b>LITERAL_B</b>");
    expect(parsed.report.scripts).toBe(0);
  });

  it("keeps an RSS title plain: a title is not run through the body path", () => {
    const parsed = parseFeed(
      '<rss version="2.0"><channel><item><title>1 &lt; 2 and 3 &gt; 2</title><description>d</description></item></channel></rss>',
    );
    expect(parsed.entries[0]?.title).toBe("1 < 2 and 3 > 2");
  });
});

describe("Codex 4: elements are matched by namespace and local name", () => {
  it("reads a fully prefixed Atom feed", () => {
    const parsed = parseFeed(
      `<atom:feed xmlns:atom="${ATOM_NS}"><atom:title>Feed</atom:title><atom:entry><atom:title>Prefixed title</atom:title><atom:link rel="alternate" href="https://example.invalid/p"/><atom:updated>2026-10-02T10:00:00Z</atom:updated><atom:author><atom:name>Prefixed Author</atom:name><atom:email>a@example.com</atom:email></atom:author><atom:summary>Prefixed summary</atom:summary></atom:entry></atom:feed>`,
    );
    expect(parsed.format).toBe("atom");
    expect(parsed.entries).toEqual([
      {
        title: "Prefixed title",
        link: "https://example.invalid/p",
        updated: "2026-10-02T10:00:00.000Z",
        author: "Prefixed Author",
        text: "Prefixed summary",
      },
    ]);
  });

  it("reads any prefix bound to the Atom namespace, mixed with unprefixed and other prefixes", () => {
    const parsed = parseFeed(
      `<feed xmlns="${ATOM_NS}" xmlns:a="${ATOM_NS}"><entry><a:title>Mixed title</a:title><link href="https://example.invalid/m"/><x:updated xmlns:x="${ATOM_NS}">2026-10-03T00:00:00Z</x:updated><author><a:name>Mixed Author</a:name></author><a:content type="html">&lt;p&gt;Mixed body&lt;/p&gt;&lt;script&gt;S()&lt;/script&gt;</a:content></entry></feed>`,
    );
    expect(parsed.entries[0]).toMatchObject({
      title: "Mixed title",
      link: "https://example.invalid/m",
      updated: "2026-10-03T00:00:00.000Z",
      author: "Mixed Author",
      text: "Mixed body",
    });
    expect(parsed.report.scripts).toBe(1);
  });

  it("reads a prefix declared on the entry itself, only inside that entry", () => {
    const parsed = parseFeed(
      `<feed xmlns="${ATOM_NS}"><entry xmlns:q="${ATOM_NS}"><q:title>Scoped</q:title></entry><entry><q:title>Unbound</q:title><title>Second</title></entry></feed>`,
    );
    expect(parsed.entries.map((entry) => entry.title)).toContain("Scoped");
    expect(parsed.entries.map((entry) => entry.title)).toContain("Second");
  });

  it("reads RSS content and Dublin Core fields through whatever prefix is bound", () => {
    const parsed = parseFeed(
      `<rss version="2.0" xmlns:c="http://purl.org/rss/1.0/modules/content/" xmlns:d="http://purl.org/dc/elements/1.1/"><channel><item><title>T</title><c:encoded><![CDATA[<p>Encoded body</p><div hidden>H</div>]]></c:encoded><d:creator>Jo</d:creator><d:date>2026-10-01T00:00:00Z</d:date></item></channel></rss>`,
    );
    expect(parsed.format).toBe("rss");
    expect(parsed.entries[0]).toMatchObject({
      text: "Encoded body",
      author: "Jo",
      updated: "2026-10-01T00:00:00.000Z",
    });
    expect(parsed.report.hiddenBlocks).toBe(1);
  });

  it("reads an RSS 1.0 (RDF) feed in its own namespaces", () => {
    const parsed = parseFeed(
      `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>C</title></channel><item><title>RDF item</title><description>RDF body</description><dc:date>2026-10-01T00:00:00Z</dc:date></item></rdf:RDF>`,
    );
    expect(parsed.format).toBe("rss");
    expect(parsed.entries[0]).toMatchObject({ title: "RDF item", text: "RDF body" });
  });

  it("still reads a feed that uses a conventional prefix without declaring it", () => {
    const parsed = parseFeed(
      '<rss version="2.0"><channel><item><title>T</title><content:encoded><![CDATA[<p>undeclared</p>]]></content:encoded></item></channel></rss>',
    );
    expect(parsed.entries[0]?.text).toBe("undeclared");
  });

  describe("an element in a namespace the parser does not know is ignored (fail closed)", () => {
    it("ignores a body field in a foreign namespace", () => {
      const parsed = parseFeed(
        `<feed xmlns="${ATOM_NS}"><entry><title>T</title><x:summary xmlns:x="${EVIL_NS}">NS_INJECTED</x:summary><summary>Real summary</summary></entry></feed>`,
      );
      expect(parsed.entries[0]?.text).toBe("Real summary");
    });

    it("ignores a field whose default namespace was rebound", () => {
      const parsed = parseFeed(
        `<feed xmlns="${ATOM_NS}"><entry><title xmlns="${EVIL_NS}">NS_TITLE</title><title>Real</title><summary>s</summary></entry></feed>`,
      );
      expect(parsed.entries[0]?.title).toBe("Real");
    });

    it("ignores an entry in a foreign namespace", () => {
      const parsed = parseFeed(
        `<feed xmlns="${ATOM_NS}"><x:entry xmlns:x="${EVIL_NS}"><x:title>NS_ENTRY</x:title></x:entry></feed>`,
      );
      expect(parsed.entries).toEqual([]);
    });

    it("ignores a feed whose root is in a foreign namespace", () => {
      const parsed = parseFeed(
        `<feed xmlns="${EVIL_NS}"><entry><title>NS_ROOT</title></entry></feed>`,
      );
      expect(parsed.format).toBe("unknown");
      expect(parsed.entries).toEqual([]);
    });

    it("ignores content that claims the content namespace under a foreign binding", () => {
      const parsed = parseFeed(
        `<rss version="2.0"><channel><item><title>T</title><c:encoded xmlns:c="${EVIL_NS}"><![CDATA[<p>NS_ENCODED</p>]]></c:encoded><description>Real</description></item></channel></rss>`,
      );
      expect(parsed.entries[0]?.text).toBe("Real");
    });

    it("does not let a foreign element nest a field into the entry", () => {
      const parsed = parseFeed(
        `<feed xmlns="${ATOM_NS}"><entry><title>T</title><x:wrap xmlns:x="${EVIL_NS}"><summary>NS_NESTED</summary></x:wrap><summary>Real</summary></entry></feed>`,
      );
      expect(parsed.entries[0]?.text).toBe("Real");
    });
  });

  it("does not throw on a hostile number of namespace declarations", () => {
    const declarations = Array.from({ length: 2_000 }, (_, i) => `xmlns:p${i}="${EVIL_NS}/${i}"`);
    const parsed = parseFeed(
      `<feed xmlns="${ATOM_NS}" ${declarations.join(" ")}><entry><title>T</title><p1999:title>X</p1999:title></entry></feed>`,
    );
    // The root's prefix table overflowed: everything below it is unknown (fail closed).
    expect(parsed.entries).toEqual([]);
    expect(parsed.report.hiddenBlocks).toBe(1);
  });
});

describe("minor: an RSS author that is an address keeps the name only", () => {
  const author = (value: string, tag = "author"): string | null | undefined =>
    parseFeed(RSS(`<${tag}>${value}</${tag}><description>d</description>`)).entries[0]?.author;

  it("keeps the parenthesised name of the specification form", () => {
    expect(author("joe@example.com (Joe Writer)")).toBe("Joe Writer");
  });

  it("keeps the name of the angle-bracket form", () => {
    expect(author("Joe Writer &lt;joe@example.com&gt;")).toBe("Joe Writer");
  });

  it("stores nothing for a bare address", () => {
    expect(author("joe@example.com")).toBeNull();
    expect(author("joe@example.com ()")).toBeNull();
  });

  it("leaves a plain name alone", () => {
    expect(author("Joe Writer")).toBe("Joe Writer");
  });

  it("applies to Dublin Core creators too", () => {
    const parsed = parseFeed(
      `<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item><title>T</title><dc:creator>joe@example.com (Joe)</dc:creator><description>d</description></item></channel></rss>`,
    );
    expect(parsed.entries[0]?.author).toBe("Joe");
  });

  it("never lets the address reach any entry field", () => {
    const parsed = parseFeed(
      RSS("<author>reader@example.com (Joe)</author><description>d</description>"),
    );
    expect(JSON.stringify(parsed)).not.toContain("reader@example.com");
  });
});
