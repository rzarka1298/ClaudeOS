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
