// Security finding 5 (plan 07-04): the filter fails CLOSED. Every path where it cannot decide what
// a reader would see drops the text and says so, never emits it: unknown, unclosed or malformed
// tags, exceeded caps, stray or unbalanced end tags, a hidden element left open at the end of the
// input, and a parse that throws. The sink is also driven directly, because the parser never
// produces some of these event sequences on its own.
import { describe, expect, it } from "vitest";
import { parseFeed } from "./feed.js";
import { createMarkupSink, htmlToText } from "./html-to-text.js";

const KEPT = "<p>kept</p>";

describe("finding 5: tags the filter does not know", () => {
  const UNKNOWN: ReadonlyArray<readonly [string, string]> = [
    ["an unknown element with a hidden attribute", "<unknown-widget hidden>HID</unknown-widget>"],
    [
      "a custom element with a hidden style",
      '<custom-element style="display:none">HID</custom-element>',
    ],
    ["a prefixed unknown element", '<q:thing style="visibility:hidden">HID</q:thing>'],
    ["an element name with digits and dots", '<h1.x hidden="">HID</h1.x>'],
    [
      "an unreadable style on an unknown element",
      '<blink-me style="opacity:var(--o)">HID</blink-me>',
    ],
  ];
  for (const [name, markup] of UNKNOWN) {
    it(`hides ${name}`, () => {
      const result = htmlToText(`${KEPT}${markup}${KEPT}`);
      expect(result.text).toBe("kept\nkept");
      expect(result.report.hiddenBlocks).toBe(1);
    });
  }
});

describe("finding 5: unclosed and malformed markup", () => {
  it("keeps an unclosed hidden element hidden to the end of the input", () => {
    const result = htmlToText(`${KEPT}<div hidden>HID_A<p>HID_B<span>HID_C`);
    expect(result.text).toBe("kept");
    expect(result.report.hiddenBlocks).toBe(1);
  });

  it("keeps an unclosed hidden element hidden when later markup closes only inner elements", () => {
    const result = htmlToText(`${KEPT}<div hidden><b>HID_A</b><i>HID_B</i></span></em>HID_C`);
    expect(result.text).toBe("kept");
  });

  it("drops a tag that never ends instead of emitting its text", () => {
    for (const markup of [
      '<div hidden style="',
      "<div hidden",
      '<div title="x>HID',
      "<div hidden HID",
      "<",
      "</",
      "<!",
      "<a href=",
    ]) {
      const result = htmlToText(`${KEPT}${markup}`);
      expect(result.text, markup).not.toContain("HID");
      expect(result.text.startsWith("kept"), markup).toBe(true);
    }
  });

  it("does not let an unterminated attribute value hide the visible text before it", () => {
    expect(htmlToText(`${KEPT}<div title="never closed>HID`).text).toBe("kept");
  });

  it("treats a malformed attribute list like the browser does: the attribute name is whatever it reads", () => {
    const result = htmlToText(`${KEPT}<div hidden<p>SHOWN</div>`);
    expect(result.text).toContain("kept");
    expect(() => htmlToText('<<<>>><div <p x="</div>&#xZZ;&bogus;<a href=')).not.toThrow();
  });

  it("never throws on a long run of broken markup", () => {
    const junk = "<div hidden=".repeat(2_000) + "<<</>>>".repeat(2_000) + "<!--".repeat(500);
    expect(() => htmlToText(junk)).not.toThrow();
  });
});

describe("finding 5: stray and unbalanced end tags never pop a hidden frame early", () => {
  it("ignores end tags that match nothing", () => {
    const result = htmlToText(`${KEPT}</div></span></p></b>${KEPT}`);
    expect(result.text).toBe("kept\nkept");
  });

  it("keeps a hidden element hidden when an end tag for another element arrives inside it", () => {
    const result = htmlToText(`${KEPT}<div hidden>HID_A</span>HID_B</b>HID_C</div>VIS`);
    expect(result.text).toBe("kept\nVIS");
    expect(result.report.hiddenBlocks).toBe(1);
  });

  it("closes a hidden element only at its own end tag, however many extra end tags follow", () => {
    const result = htmlToText(`${KEPT}<div hidden>HID</div></div></div>VIS`);
    expect(result.text).toBe("kept\nVIS");
  });

  it("does not resurrect hidden text through a stray end tag of an enclosing visible element", () => {
    const result = htmlToText(`<section><div hidden>HID</section>VIS`);
    expect(result.text).toBe("VIS");
  });

  it("the sink ignores a close event whose name does not match the open frame", () => {
    const sink = createMarkupSink();
    sink.open("p", { hidden: "" });
    sink.close("span");
    sink.text("HID_A");
    sink.close("div");
    sink.text("HID_B");
    sink.close("p");
    sink.text("VIS");
    const result = sink.finish();
    expect(result.text).toBe("VIS");
  });

  it("the sink ignores a close event when no frame is open", () => {
    const sink = createMarkupSink();
    sink.close("div");
    sink.close("p");
    sink.text("VIS");
    expect(sink.finish().text).toBe("VIS");
  });

  it("the sink keeps an inner hidden frame open when a close names an outer element", () => {
    const sink = createMarkupSink();
    sink.open("div", {});
    sink.open("p", { hidden: "" });
    sink.close("div");
    sink.text("HID");
    expect(sink.finish().text).toBe("");
  });
});

describe("finding 5: caps truncate and never bypass filtering", () => {
  it("emits nothing after the depth cap, including text after a hidden element that was open at the cap", () => {
    const html = `${KEPT}<div hidden>HID_A${"<div>".repeat(600)}HID_B</div></div>HID_C`;
    const result = htmlToText(html);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("kept");
  });

  it("emits nothing after the depth cap even when the deep elements are closed again", () => {
    const html = `${"<div>".repeat(600)}DEEP${"</div>".repeat(600)}AFTER`;
    const result = htmlToText(html);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("DEEP");
    expect(result.text).not.toContain("AFTER");
  });

  it("hides an element opened after a very large amount of visible text", () => {
    const html = `<p>${"word ".repeat(60_000)}</p><div hidden>HID</div>`;
    const result = htmlToText(html);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("HID");
    expect(result.text.length).toBeLessThanOrEqual(20_000);
  });

  it("cuts the page text without cutting a hidden block open", () => {
    const html = `<p>${"a".repeat(30_000)}</p><div hidden>HID</div><p>tail</p>`;
    const result = htmlToText(html);
    expect(result.text).not.toContain("HID");
    expect(result.truncated).toBe(true);
  });

  it("applies the depth cap to feed html content and drops the rest of that field", () => {
    const deep = "<div>".repeat(600);
    const parsed = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><content type="html">${"&lt;div&gt;".repeat(600)}DEEP_TEXT</content></entry></feed>`,
    );
    expect(parsed.entries[0]?.text ?? "").not.toContain("DEEP_TEXT");
    expect(deep.length).toBeGreaterThan(0);
  });
});

describe("finding 5: a sink that cannot decide stops emitting", () => {
  it("fails closed when reading an element throws", () => {
    const sink = createMarkupSink();
    sink.text("SAFE");
    sink.open("div", {
      get hidden(): string {
        throw new Error("boom");
      },
    } as unknown as Record<string, string>);
    sink.text("HID");
    sink.close("div");
    sink.text("HID_AFTER");
    const result = sink.finish();
    expect(result.text).toBe("SAFE");
    expect(result.truncated).toBe(true);
  });

  it("does not throw out of any sink method after it has failed", () => {
    const sink = createMarkupSink();
    sink.open("div", {
      get style(): string {
        throw new Error("boom");
      },
    } as unknown as Record<string, string>);
    expect(() => {
      sink.text("x");
      sink.comment();
      sink.close("div");
      sink.open("p", {});
      sink.finish();
    }).not.toThrow();
  });
});
