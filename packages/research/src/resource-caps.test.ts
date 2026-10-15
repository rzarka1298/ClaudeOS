// Security finding 7 (plan 07-04): resource caps fail closed. A cap truncates the OUTPUT after
// every filtering decision made so far; it never turns filtering off. Anything deeper than the
// depth cap, beyond the input-size cap or the node cap is dropped and counted, and a style value
// too long to read is treated as hidden, not as visible. Each cap is tested at the cap and just
// over it.
import { describe, expect, it } from "vitest";
import { parseFeed } from "./feed.js";
import {
  htmlToText,
  MAX_DEPTH,
  MAX_INPUT_CHARS,
  MAX_NODES,
  MAX_PAGE_CHARS,
} from "./html-to-text.js";

const atom = (entry: string): string =>
  `<feed xmlns="http://www.w3.org/2005/Atom"><entry>${entry}</entry></feed>`;

describe("depth cap: 512 open elements", () => {
  it("emits text at exactly 512 nested elements and does not truncate", () => {
    const result = htmlToText(`${"<div>".repeat(MAX_DEPTH)}DEEP`);
    expect(result.text).toBe("DEEP");
    expect(result.truncated).toBe(false);
    expect(result.report.hiddenBlocks).toBe(0);
  });

  it("drops everything from the 513th nested element on, counts it and sets truncated", () => {
    const result = htmlToText(`${"<div>".repeat(MAX_DEPTH + 1)}DEEP`);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(true);
    expect(result.report.hiddenBlocks).toBe(1);
  });

  it("keeps the text before the cap and drops later siblings too", () => {
    const result = htmlToText(`<p>before</p>${"<div>".repeat(MAX_DEPTH + 1)}</div><p>after</p>`);
    expect(result.text).toBe("before");
    expect(result.truncated).toBe(true);
  });

  it("counts a cap hit once however much follows it", () => {
    const result = htmlToText(`${"<div>".repeat(MAX_DEPTH + 50)}x${"<i>".repeat(100)}`);
    expect(result.report.hiddenBlocks).toBe(1);
  });
});

describe("page text cap: 20,000 characters", () => {
  it("keeps 20,000 characters untruncated", () => {
    const result = htmlToText(`<p>${"a".repeat(MAX_PAGE_CHARS)}</p>`);
    expect(result.text).toHaveLength(MAX_PAGE_CHARS);
    expect(result.truncated).toBe(false);
  });

  it("cuts 20,001 characters to 20,000 and sets truncated", () => {
    const result = htmlToText(`<p>${"a".repeat(MAX_PAGE_CHARS + 1)}</p>`);
    expect(result.text).toHaveLength(MAX_PAGE_CHARS);
    expect(result.truncated).toBe(true);
  });

  it("applies the filter before the cut: hidden text near the cut never fills the budget", () => {
    const result = htmlToText(
      `<p>${"a".repeat(MAX_PAGE_CHARS - 6)}</p><div hidden>${"H".repeat(100)}</div><p>bbbbb</p>`,
    );
    expect(result.text).not.toContain("H");
    expect(result.text.endsWith("bbbbb")).toBe(true);
    expect(result.truncated).toBe(false);
  });
});

describe("style cap: 2,048 characters", () => {
  const style = (length: number, prefix = "color:red;/*"): string =>
    `${prefix}${"x".repeat(length - prefix.length - 2)}*/`;

  it("reads a benign style of exactly 2,048 characters and keeps the text", () => {
    // Harmless declarations padded with spaces: a comment is unreadable under the allowlist.
    const unit = "font-weight:bold;";
    const value = unit + " ".repeat(2_048 - unit.length);
    expect(value).toHaveLength(2_048);
    const result = htmlToText(`<div style="${value}">SHOWN</div>`);
    expect(result.text).toBe("SHOWN");
    expect(result.report.hiddenBlocks).toBe(0);
  });

  it("reads a hiding style of exactly 2,048 characters and hides the text", () => {
    const value = style(2_048, "display:none;/*");
    expect(value).toHaveLength(2_048);
    const result = htmlToText(`<div style="${value}">HID</div>`);
    expect(result.text).toBe("");
    expect(result.report.hiddenBlocks).toBe(1);
  });

  it("treats a benign style of 2,049 characters as unreadable: hidden and counted", () => {
    const value = style(2_049);
    expect(value).toHaveLength(2_049);
    const result = htmlToText(`<p>kept</p><div style="${value}">HID<span>HID2</span></div>`);
    expect(result.text).toBe("kept");
    expect(result.report.hiddenBlocks).toBe(1);
  });

  it("treats a far longer style as unreadable too, even when it ends in display:block", () => {
    const result = htmlToText(`<div style="${"a:b;".repeat(5_000)}display:block">HID</div>`);
    expect(result.text).toBe("");
    expect(result.report.hiddenBlocks).toBe(1);
  });

  it("applies in feed html content", () => {
    const value = style(2_049);
    const parsed = parseFeed(
      atom(
        `<title>T</title><content type="html">&lt;p&gt;kept&lt;/p&gt;&lt;div style="${value}"&gt;HID&lt;/div&gt;</content>`,
      ),
    );
    expect(parsed.entries[0]?.text).toBe("kept");
    expect(parsed.report.hiddenBlocks).toBe(1);
  });
});

describe("entry caps: 4,000 characters of text, 200 of title and author", () => {
  it("keeps 4,000 characters of plain text and cuts 4,001 to 4,000", () => {
    const at = parseFeed(atom(`<title>T</title><summary>${"a".repeat(4_000)}</summary>`));
    const over = parseFeed(atom(`<title>T</title><summary>${"a".repeat(4_001)}</summary>`));
    expect(at.entries[0]?.text).toHaveLength(4_000);
    expect(over.entries[0]?.text).toHaveLength(4_000);
  });

  it("keeps 4,000 characters of html content and cuts 4,001 to 4,000", () => {
    const body = (n: number): string => `&lt;p&gt;${"a".repeat(n)}&lt;/p&gt;`;
    const at = parseFeed(atom(`<title>T</title><content type="html">${body(4_000)}</content>`));
    const over = parseFeed(atom(`<title>T</title><content type="html">${body(4_001)}</content>`));
    expect(at.entries[0]?.text).toHaveLength(4_000);
    expect(over.entries[0]?.text).toHaveLength(4_000);
  });

  it("keeps 200 characters of title and author and cuts 201 to 200", () => {
    const at = parseFeed(
      atom(`<title>${"t".repeat(200)}</title><author><name>${"n".repeat(200)}</name></author>`),
    );
    const over = parseFeed(
      atom(`<title>${"t".repeat(201)}</title><author><name>${"n".repeat(201)}</name></author>`),
    );
    expect(at.entries[0]?.title).toHaveLength(200);
    expect(over.entries[0]?.title).toHaveLength(200);
    expect(at.entries[0]?.author).toHaveLength(200);
    expect(over.entries[0]?.author).toHaveLength(200);
  });

  it("filters before it cuts: hidden text near the cut never fills the entry budget", () => {
    const html = `&lt;p&gt;${"a".repeat(3_989)}&lt;/p&gt;&lt;div hidden&gt;${"H".repeat(500)}&lt;/div&gt;&lt;p&gt;bbbbbbbbbb&lt;/p&gt;`;
    const parsed = parseFeed(atom(`<title>T</title><content type="html">${html}</content>`));
    expect(parsed.entries[0]?.text).not.toContain("H");
    expect(parsed.entries[0]?.text.endsWith("bbbbbbbbbb")).toBe(true);
  });
});

describe("input-size cap", () => {
  const atCap = `<!--${"a".repeat(MAX_INPUT_CHARS - 11)}-->TAIL`;
  const overCap = `<!--${"a".repeat(MAX_INPUT_CHARS - 7)}-->TAIL`;

  it("builds fixtures of exactly the cap and past it", () => {
    expect(atCap).toHaveLength(MAX_INPUT_CHARS);
    expect(overCap).toHaveLength(MAX_INPUT_CHARS + 4);
  });

  it("parses an input of exactly the cap in full", () => {
    const result = htmlToText(atCap);
    expect(result.text).toBe("TAIL");
    expect(result.truncated).toBe(false);
  });

  it("drops the remainder of an input past the cap, counts it and sets truncated", () => {
    const result = htmlToText(overCap);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(true);
    expect(result.report.hiddenBlocks).toBe(1);
  });

  it("never passes the remainder through, even when it holds visible text only", () => {
    const result = htmlToText(`<p>head</p>${"<!---->".repeat(MAX_INPUT_CHARS / 6)}<p>TAIL</p>`);
    expect(result.text).toBe("head");
    expect(result.truncated).toBe(true);
  });

  it("does not split a surrogate pair at the cut", () => {
    const result = htmlToText(`<p>${"a".repeat(MAX_INPUT_CHARS - 4)}\uD83D\uDE00</p>`);
    expect(result.text).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(result.truncated).toBe(true);
  });
});

describe("node cap", () => {
  it("parses exactly the node cap in full", () => {
    const result = htmlToText(`${"<i></i>".repeat(MAX_NODES)}TAIL`);
    expect(result.text).toBe("TAIL");
    expect(result.truncated).toBe(false);
  });

  it("drops everything after one element past the node cap, counts it and sets truncated", () => {
    const result = htmlToText(`${"<i></i>".repeat(MAX_NODES + 1)}TAIL`);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(true);
    expect(result.report.hiddenBlocks).toBe(1);
  });
});

describe("feed field cap", () => {
  it("counts a field cut at the raw cap and keeps nothing past it", () => {
    const filler = `&lt;p&gt;${"a".repeat(300_000)}&lt;/p&gt;&lt;p&gt;TAIL&lt;/p&gt;`;
    const parsed = parseFeed(atom(`<title>T</title><content type="html">${filler}</content>`));
    expect(parsed.entries[0]?.text ?? "").not.toContain("TAIL");
    expect(parsed.report.hiddenBlocks).toBeGreaterThanOrEqual(1);
  });
});
