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
      `<feed xmlns="${ATOM}" ${declared}><entry><title>t</title></entry></feed>`,
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
