// Plan 07-08, task 1: escaping untrusted spans so Obsidian renders them as inert text
// (D-06, research Pitfall 7, UI-SPEC R4). Every hostile string below is pure ASCII.
import { describe, expect, test } from "vitest";
import { escapeMarkdownText, fenceUntrustedBlock, inlineCode } from "./markdown-escape.js";

const ASCII_PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

/**
 * CommonMark's rule: a backslash before an ASCII punctuation character is that character,
 * literally. Returns null when the text holds a bare punctuation character or a stray backslash,
 * that is when the text is NOT fully escaped.
 */
function commonMarkUnescape(escaped: string): string | null {
  let out = "";
  for (let i = 0; i < escaped.length; i++) {
    const ch = escaped.charAt(i);
    if (ch === "\\") {
      const next = escaped.charAt(i + 1);
      if (next === "" || !ASCII_PUNCTUATION.includes(next)) return null;
      out += next;
      i += 1;
    } else if (ASCII_PUNCTUATION.includes(ch)) {
      return null;
    } else {
      out += ch;
    }
  }
  return out;
}

const HOSTILE = [
  "![x](https://e.example/p.png)",
  "[[Private]]",
  "![[Private]]",
  "[[Private|shown]] and [[Private#Heading]]",
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  "<https://e.example/auto>",
  "https://e.example/bare and www.e.example",
  "#tag #another/tag",
  "%%hidden comment%%",
  "$x^2$ and $$y$$",
  "> [!note] callout",
  "- list item",
  "1. ordered item",
  "# heading",
  "---",
  "===",
  "| a | b |",
  "`code` and ``double``",
  "~~~ fence",
  "```js\nalert(1)\n```",
  "[ref]: https://e.example/ref",
  "[link](javascript:alert(1))",
  "&amp; &#35; &lt;b&gt;",
  "==highlight== ^block-id",
  "[^1] footnote",
  "back\\slash and \\[escaped\\]",
  "*bold* _italic_ ~~strike~~",
] as const;

describe("escapeMarkdownText", () => {
  test("escapes every ASCII punctuation character and nothing else", () => {
    const escaped = escapeMarkdownText(ASCII_PUNCTUATION);
    expect(escaped).toBe([...ASCII_PUNCTUATION].map((ch) => `\\${ch}`).join(""));
    expect(escapeMarkdownText("Plain words and digits 0123")).toBe("Plain words and digits 0123");
  });

  test("every hostile string comes out fully escaped and unescapes to the collapsed original", () => {
    for (const text of HOSTILE) {
      const escaped = escapeMarkdownText(text);
      const collapsed = text.replace(/\s+/g, " ").trim();
      expect(commonMarkUnescape(escaped), text).toBe(collapsed);
      expect(escaped).not.toMatch(/\n/);
    }
  });

  test("the plan's example is escaped character by character", () => {
    const text =
      "![x](https://e.example/p.png) [[secret]] ![[secret]] <img src=x> #tag %%c%% $x$ > [!note]";
    const escaped = escapeMarkdownText(text);
    expect(escaped).toContain("\\!\\[x\\]\\(https\\:\\/\\/e\\.example\\/p\\.png\\)");
    expect(escaped).toContain("\\[\\[secret\\]\\]");
    expect(escaped).toContain("\\<img src\\=x\\>");
    expect(commonMarkUnescape(escaped)).toBe(text);
  });

  test("newlines, tabs, separators and other whitespace collapse to single spaces", () => {
    expect(escapeMarkdownText("a\nb\r\nc\td\u2028e\u2029f\u0085g\u00a0h")).toBe("a b c d e f g h");
    expect(escapeMarkdownText("  \n lead and trail \n  ")).toBe("lead and trail");
    expect(escapeMarkdownText("")).toBe("");
  });

  test("control, format and bidi characters are removed", () => {
    expect(escapeMarkdownText("a\u0000b\u0007c\u202ed\u200be\u2066f\u007fg")).toBe("abcdefg");
  });

  test("escaping an escaped text escapes its backslashes again, so nothing is decoded twice", () => {
    const once = escapeMarkdownText("a_b");
    expect(once).toBe("a\\_b");
    expect(escapeMarkdownText(once)).toBe("a\\\\\\_b");
  });
});

describe("inlineCode", () => {
  test("uses a fence one longer than the longest backtick run, padded with a space each side", () => {
    expect(inlineCode("plain")).toBe("` plain `");
    expect(inlineCode("a`b")).toBe("`` a`b ``");
    expect(inlineCode("a``b```c")).toBe("```` a``b```c ````");
    expect(inlineCode("`")).toBe("`` ` ``");
  });

  test("collapses newlines so the span stays on one line", () => {
    expect(inlineCode("a\nb")).toBe("` a b `");
  });

  test("a hostile address stays inside the span", () => {
    const span = inlineCode("https://e.example/`x`/![y](z)");
    expect(span.startsWith("`` ")).toBe(true);
    expect(span.endsWith(" ``")).toBe(true);
  });
});

describe("fenceUntrustedBlock", () => {
  test("uses a three-tilde fence with the text info string when the text has no tildes", () => {
    expect(fenceUntrustedBlock("one\ntwo\n")).toBe("~~~text\none\ntwo\n~~~\n");
  });

  test("makes the fence longer than any tilde run in the text", () => {
    expect(fenceUntrustedBlock("a\n~~~~\nb\n")).toBe("~~~~~text\na\n~~~~\nb\n~~~~~\n");
    expect(fenceUntrustedBlock("a ~ b ~~ c\n")).toBe("~~~text\na ~ b ~~ c\n~~~\n");
    expect(fenceUntrustedBlock("~~~\n")).toBe("~~~~text\n~~~\n~~~~\n");
  });

  test("backtick fences inside the text are only text", () => {
    const block = fenceUntrustedBlock("```\ninjected\n```\n");
    expect(block.startsWith("~~~text\n")).toBe(true);
    expect(block.endsWith("```\n~~~\n")).toBe(true);
  });

  test("adds the newline before the closing fence when the text lacks one", () => {
    expect(fenceUntrustedBlock("no newline")).toBe("~~~text\nno newline\n~~~\n");
  });
});
