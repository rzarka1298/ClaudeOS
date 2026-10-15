// Security finding "security-registry-fanout": resource fan-out in the feed parser's registries.
// The namespace binding table was copied (up to 64 entries) on every element that carried an
// xmlns attribute, kept values untrimmed and unbounded, and retained one table per open scope;
// each field kept a full copy of its attributes and an entry kept any number of fields. A hostile
// 1 MiB feed multiplies those. The fixes are hard caps that fail closed and are counted:
//
//   - a namespace value over 256 characters is an unknown namespace (never truncated into a match,
//     never trimmed into one);
//   - declarations beyond a per-feed budget are dropped, and once any is dropped an undeclared
//     prefix is unknown rather than conventional;
//   - at most 64 fields are kept per entry, and a field keeps only the three attributes the parser
//     reads (type, href, rel), each capped;
//   - everything dropped is counted in hiddenBlocks, once per kind.
//
// Source is pure ASCII.
import { describe, expect, it } from "vitest";
import { parseFeed } from "./feed.js";

const ATOM = "http://www.w3.org/2005/Atom";

function timed<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
}

describe("namespace values are exact and bounded", () => {
  it("does not read an Atom namespace padded with whitespace as Atom", () => {
    const parsed = parseFeed(
      `<feed xmlns="${ATOM} "><entry><title>t</title><summary>s</summary></entry></feed>`,
    );
    expect(parsed.format).toBe("unknown");
    expect(parsed.entries).toEqual([]);
  });

  it("treats a namespace value over 256 characters as unknown, never truncated into a match", () => {
    const long = `${ATOM}/${"a".repeat(300)}`;
    const parsed = parseFeed(
      `<feed xmlns="${long}"><entry><title>t</title><summary>s</summary></entry></feed>`,
    );
    expect(parsed.entries).toEqual([]);
    expect(parsed.report.hiddenBlocks).toBeGreaterThanOrEqual(1);
  });

  it("counts an over-long namespace once however many there are", () => {
    const long = `http://example.com/${"a".repeat(300)}`;
    const declared = Array.from({ length: 20 }, (_, i) => `xmlns:p${i}="${long}${i}"`).join(" ");
    const parsed = parseFeed(
      `<feed xmlns="${ATOM}"><x ${declared}/><entry><title>t</title></entry></feed>`,
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.report.hiddenBlocks).toBe(1);
  });

  it("keeps a namespace of exactly 256 characters usable", () => {
    const exact = `http://example.com/${"a".repeat(256 - 19)}`;
    expect(exact).toHaveLength(256);
    const parsed = parseFeed(
      `<feed xmlns="${ATOM}" xmlns:x="${exact}"><entry><title>t</title></entry></feed>`,
    );
    expect(parsed.report.hiddenBlocks).toBe(0);
  });
});

describe("declarations beyond the budget are dropped, counted, and fail closed", () => {
  it("flags a feed that re-declares thousands of prefixes across sibling elements", () => {
    const siblings = Array.from(
      { length: 6_000 },
      (_, i) => `<x xmlns:p${i}="http://example.com/${i}"/>`,
    ).join("");
    const parsed = parseFeed(
      `<feed xmlns="${ATOM}">${siblings}<entry><title>t</title><summary>s</summary></entry></feed>`,
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.report.hiddenBlocks).toBe(1);
  });

  it("resolves an undeclared conventional prefix as unknown once a declaration was dropped", () => {
    const siblings = Array.from(
      { length: 6_000 },
      (_, i) => `<x xmlns:p${i}="http://example.com/${i}"/>`,
    ).join("");
    const parsed = parseFeed(
      `<rss version="2.0"><channel>${siblings}<item><title>t</title><content:encoded>&lt;p&gt;undeclared&lt;/p&gt;</content:encoded><description>plain</description></item></channel></rss>`,
    );
    expect(parsed.entries[0]?.text).toBe("plain");
  });

  it("does not copy the table per element in a nested hostile feed", () => {
    const depth = 500;
    const open = Array.from(
      { length: depth },
      (_, i) => `<n xmlns:a${i}="http://example.com/${"u".repeat(200)}${i}">`,
    ).join("");
    const xml = `<feed xmlns="${ATOM}">${open}${"</n>".repeat(depth)}<entry><title>t</title></entry></feed>`;
    const { value, ms } = timed(() => parseFeed(xml));
    expect(ms).toBeLessThan(2_000);
    expect(value.entries).toHaveLength(1);
  });
});

describe("an entry keeps a bounded number of fields, each with bounded attributes", () => {
  it("keeps at most 64 fields per entry and counts the rest", () => {
    const fields = Array.from({ length: 200 }, (_, i) => `<custom${i}>x</custom${i}>`).join("");
    const parsed = parseFeed(
      `<feed xmlns="${ATOM}"><entry>${fields}<title>late title</title></entry></feed>`,
    );
    // The title is the 201st child: past the cap, so it is not read.
    expect(parsed.entries[0]?.title).toBe("");
    expect(parsed.report.hiddenBlocks).toBe(1);
  });

  it("reads a title that is within the first 64 fields", () => {
    const fields = Array.from({ length: 30 }, (_, i) => `<custom${i}>x</custom${i}>`).join("");
    const parsed = parseFeed(
      `<feed xmlns="${ATOM}"><entry>${fields}<title>early title</title></entry></feed>`,
    );
    expect(parsed.entries[0]?.title).toBe("early title");
    expect(parsed.report.hiddenBlocks).toBe(0);
  });

  it("keeps only the attributes it reads on a field with thousands of them", () => {
    const attributes = Array.from({ length: 5_000 }, (_, i) => `a${i}="${"v".repeat(40)}"`).join(
      " ",
    );
    const parsed = parseFeed(
      `<feed xmlns="${ATOM}"><entry><title>t</title><link ${attributes} href="https://example.com/x" rel="alternate"/></entry></feed>`,
    );
    expect(parsed.entries[0]?.link).toBe("https://example.com/x");
  });

  it("drops an over-long href and counts it", () => {
    const parsed = parseFeed(
      `<feed xmlns="${ATOM}"><entry><title>t</title><link href="https://example.com/${"a".repeat(9_000)}"/></entry></feed>`,
    );
    expect(parsed.entries[0]?.link).toBeNull();
    expect(parsed.report.hiddenBlocks).toBe(1);
  });
});

describe("a crafted 1 MiB feed stays cheap", () => {
  it("parses declaration-heavy nested and sibling elements in well under two seconds", () => {
    const unit = `<n xmlns:p="http://example.com/${"u".repeat(180)}" xmlns:q="x" xmlns:r="y" xmlns:s="z">`;
    const depth = 400;
    const siblings = '<s xmlns:z="http://example.com/z"/>'.repeat(20_000);
    const xml = `<feed xmlns="${ATOM}">${unit.repeat(depth)}${siblings}${"</n>".repeat(depth)}<entry><title>t</title></entry></feed>`;
    expect(xml.length).toBeLessThanOrEqual(1_048_576);
    const { value, ms } = timed(() => parseFeed(xml));
    expect(ms).toBeLessThan(2_000);
    expect(value.entries).toHaveLength(1);
  });
});

describe("a scope that dropped a declaration reads every name below it as unknown", () => {
  const pad = `<x:pad xmlns:x="urn:pad"${Array.from(
    { length: 2_100 },
    (_, i) => ` xmlns:p${i}="urn:p${i}"`,
  ).join("")}/>`;
  const entry = (inner: string, attributes = ""): string =>
    `<entry${attributes}><title>ok</title><link href="https://example.com/a"/>${inner}</entry>`;

  it("ignores an element that redeclares the default namespace past the budget (opus)", () => {
    const feed = `<feed xmlns="${ATOM}"><title>f</title>${pad}${entry('<summary xmlns="urn:x:other">LEAK</summary>')}</feed>`;
    expect(JSON.stringify(parseFeed(feed).entries)).not.toContain("LEAK");
  });

  it("ignores an element that redeclares a prefix past the budget (opus)", () => {
    const feed = `<feed xmlns="${ATOM}" xmlns:a="${ATOM}"><title>f</title>${pad}${entry('<a:summary xmlns:a="urn:x:other">LEAK</a:summary>')}</feed>`;
    expect(JSON.stringify(parseFeed(feed).entries)).not.toContain("LEAK");
  });

  it("ignores an entry whose own declaration was dropped (Codex 2)", () => {
    const siblings = Array.from({ length: 2_047 }, () => '<x xmlns:q="urn:q"/>').join("");
    const feed = `<feed xmlns="${ATOM}">${siblings}${entry("<summary>LEAK</summary>", ' xmlns="urn:untrusted"')}</feed>`;
    const parsed = parseFeed(feed);
    expect(parsed.entries).toEqual([]);
    expect(parsed.report.hiddenBlocks).toBe(1);
  });

  it("ignores everything below an element whose prefix table is full", () => {
    const declared = Array.from({ length: 70 }, (_, i) => ` xmlns:p${i}="urn:p${i}"`).join("");
    const feed = `<feed xmlns="${ATOM}"><wrap${declared}>${entry("<summary>LEAK</summary>")}</wrap>${entry("<summary>kept</summary>")}</feed>`;
    const parsed = parseFeed(feed);
    expect(JSON.stringify(parsed.entries)).not.toContain("LEAK");
    expect(parsed.entries.map((e) => e.text)).toContain("kept");
  });

  it("ignores everything below an element with an over-long namespace value", () => {
    const long = `urn:${"a".repeat(300)}`;
    const feed = `<feed xmlns="${ATOM}"><wrap xmlns:q="${long}">${entry("<summary>LEAK</summary>")}</wrap>${entry("<summary>kept</summary>")}</feed>`;
    const parsed = parseFeed(feed);
    expect(JSON.stringify(parsed.entries)).not.toContain("LEAK");
    expect(parsed.entries.map((e) => e.text)).toContain("kept");
  });
});

describe("a field whose type discriminator is over the cap is rejected (Codex 1)", () => {
  it("does not default an over-long type to text", () => {
    const pad = " ".repeat(5_000);
    const feed = `<feed xmlns="${ATOM}"><entry><title>t</title><content type="${pad}html">&lt;div hidden&gt;LEAK&lt;/div&gt;</content><summary>fallback</summary></entry></feed>`;
    const parsed = parseFeed(feed);
    expect(parsed.entries[0]?.text).toBe("fallback");
    expect(JSON.stringify(parsed.entries)).not.toContain("LEAK");
    expect(parsed.report.hiddenBlocks).toBe(1);
  });

  it("rejects an over-long type on an RSS body too", () => {
    const pad = "x".repeat(5_000);
    const feed = `<rss version="2.0"><channel><item><title>t</title><description type="${pad}">&lt;script&gt;EVIL()&lt;/script&gt;ok</description></item></channel></rss>`;
    const parsed = parseFeed(feed);
    expect(JSON.stringify(parsed.entries)).not.toContain("EVIL");
  });
});

describe("author address removal is linear on decoded runs of angle brackets (Codex 3)", () => {
  const authorFeed = (count: number): string =>
    `<rss version="2.0"><channel><item><title>t</title><author><![CDATA[${"<".repeat(count)}>]]></author></item></channel></rss>`;

  it("handles 262,143 angle brackets and a closer in CDATA", () => {
    const started = performance.now();
    parseFeed(authorFeed(262_143));
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("handles the same run written as escaped XML", () => {
    const xml = `<rss version="2.0"><channel><item><title>t</title><author>${"&lt;".repeat(65_000)}&gt;</author></item></channel></rss>`;
    const started = performance.now();
    parseFeed(xml);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("grows linearly: doubling the run does not quadruple the time", () => {
    const best = (count: number): number => {
      let fastest = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run += 1) {
        const started = performance.now();
        parseFeed(authorFeed(count));
        fastest = Math.min(fastest, performance.now() - started);
      }
      return fastest;
    };
    const small = Math.max(best(65_000), 1);
    const large = best(260_000);
    expect(large / small).toBeLessThan(10);
  });

  it("still removes a bracketed address inside a longer name", () => {
    const parsed = parseFeed(
      '<rss version="2.0"><channel><item><title>t</title><author>Joe &lt;joe@example.com&gt; Writer</author></item></channel></rss>',
    );
    expect(parsed.entries[0]?.author).toBe("Joe Writer");
  });
});

describe("xmlns prefixes are case-sensitive, as XML is", () => {
  it("does not let xmlns:X overwrite xmlns:x", () => {
    const feed = `<feed xmlns="${ATOM}"><entry><title>t</title><x:summary xmlns:x="urn:x:other" xmlns:X="${ATOM}">LEAK</x:summary></entry></feed>`;
    expect(JSON.stringify(parseFeed(feed).entries)).not.toContain("LEAK");
  });

  it("resolves a prefix only against the declaration with the same case", () => {
    const feed = `<A:feed xmlns:A="${ATOM}"><A:entry><A:title>exact</A:title></A:entry></A:feed>`;
    expect(parseFeed(feed).entries[0]?.title).toBe("exact");
    const mismatched = `<a:feed xmlns:A="${ATOM}"><a:entry><a:title>mismatch</a:title></a:entry></a:feed>`;
    expect(parseFeed(mismatched).entries).toEqual([]);
  });

  it("does not read XMLNS:x as a declaration", () => {
    const feed = `<feed xmlns="${ATOM}"><entry><title>t</title><x:summary XMLNS:x="${ATOM}">LEAK</x:summary></entry></feed>`;
    expect(JSON.stringify(parseFeed(feed).entries)).not.toContain("LEAK");
  });

  it("still reads the conventional prefixes written in lower case without a declaration", () => {
    const feed =
      '<rss version="2.0"><channel><item><title>t</title><content:encoded>&lt;p&gt;ok&lt;/p&gt;</content:encoded></item></channel></rss>';
    expect(parseFeed(feed).entries[0]?.text).toBe("ok");
  });
});
