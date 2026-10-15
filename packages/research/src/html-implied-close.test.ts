// Wave 1+2 review, BLOCKER 1 and MAJOR 3 (plan 07-04). The hidden-content filter follows
// htmlparser2's element stack; a browser's tree builder differs from it whenever an element is
// closed implicitly (by an end tag for an outer element, or by another start tag). Whenever a
// hidden or dropped frame is involved in such a close and the two trees may differ, the filter
// stops deciding: the remainder is dropped, counted and the output is flagged truncated. A
// reader's browser must never show text the filter emitted from under a hidden ancestor.
//
// Also here: the parser's own cost is bounded (the input is written in small chunks and writing
// stops as soon as the sink has stopped), and a seeded differential run against a spec-compliant
// tree builder (parse5, found in the install tree when present; it is NOT a dependency of this
// package) asserts that no text a browser keeps hidden is emitted.
//
// Hostile strings are plain ASCII. Source is pure ASCII by design.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Parser } from "htmlparser2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseFeed } from "./feed.js";
import { htmlToText, MAX_INPUT_CHARS } from "./html-to-text.js";

function leaked(html: string, marker = "LEAK"): boolean {
  const result = htmlToText(html);
  return result.text.includes(marker) && !result.truncated;
}

describe("BLOCKER 1: an implicit close of a hidden frame never releases hidden text", () => {
  const PAYLOADS: ReadonlyArray<readonly [name: string, html: string]> = [
    ["formatting element re-opened (b)", "<div><b hidden>H</div>LEAK"],
    ["formatting element re-opened (i, aria-hidden)", '<div><i aria-hidden="true">H</div>LEAK'],
    ["formatting element re-opened (font, inside p)", "<div><font hidden><p>H</div>LEAK"],
    ["formatting element re-opened (a)", "<div><a hidden>H</div>LEAK"],
    ["end tag ignored behind a div", "<span hidden><div>x</span>LEAK</div>"],
    ["end tag ignored behind a paragraph", "<span hidden><p>x</span>LEAK"],
    ["end tag ignored behind a nested list", "<span hidden><ul><li>x</span>LEAK"],
    ["end tag ignored, hidden only by an ancestor", "<div hidden><span><div>y</span></div>LEAK"],
    ["label end tag behind a list item", "<label hidden><li>x</label>LEAK"],
    ["list item scope", "<li hidden>H<ul></li>LEAK"],
    ["list item scope, style", '<li style="visibility:hidden">H<ul></li>LEAK'],
    ["form end tag", "<form hidden><i></form>LEAK"],
    ["form end tag, aria-hidden", '<form aria-hidden="true"><i></form>LEAK'],
    [
      "select closed by an outer end tag (Codex 3)",
      "<p>kept</p><div hidden><select></div>HID</select></div>",
    ],
    ["select closed by an inline end tag", "<span hidden><select></span>LEAK</select>"],
    [
      "select closed by another form control start tag",
      "<span hidden><select>a<input>b</span>LEAK",
    ],
    ["a hidden element closed by a start tag of an anchor", "<a hidden>x<a>y</a>LEAK"],
    ["a hidden table cell inside a hidden span", "<span hidden><table><tr><td>x</span>LEAK"],
    [
      "quirks table start tag does not close the hidden paragraph",
      "<span hidden><p>x<table></table></span>LEAK",
    ],
    ["button in a hidden paragraph", "<p hidden>x<button>y</p>LEAK"],
    ["dropped unknown element closed by an outer end tag", "<span hidden><x-foo><div>a</span>LEAK"],
  ];

  for (const [name, html] of PAYLOADS) {
    it(`does not emit hidden text: ${name}`, () => {
      expect(leaked(html), html).toBe(false);
    });
  }

  it("counts the dropped remainder and flags the output when it stops deciding", () => {
    const result = htmlToText("<p>before</p><div><b hidden>H</div>LEAK<p>after</p>");
    expect(result.truncated).toBe(true);
    expect(result.report.hiddenBlocks).toBeGreaterThanOrEqual(1);
    expect(result.text).toContain("before");
    expect(result.text).not.toContain("LEAK");
    expect(result.text).not.toContain("after");
  });

  it("applies to feed html content and xhtml content as well", () => {
    const html = "<div><b hidden>H</div>LEAK";
    const encoded = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const feed = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><content type="html">${encoded}</content></entry></feed>`,
    );
    expect(feed.entries[0]?.text ?? "").not.toContain("LEAK");
    const xhtml = parseFeed(
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><span hidden="hidden"><div>x</span>LEAK</div></content></entry></feed>',
    );
    expect(xhtml.entries[0]?.text ?? "").not.toContain("LEAK");
  });

  describe("does not over-drop the ordinary markup that parser and browser agree on", () => {
    const BENIGN: ReadonlyArray<readonly [name: string, html: string, visible: string]> = [
      ["unclosed list items in a hidden list", "<ul hidden><li>a<li>b</ul>VIS", "VIS"],
      ["a hidden paragraph closed by the next paragraph", "<p hidden>x<p>VIS", "VIS"],
      ["a hidden paragraph closed by a block", "<p hidden>x<div>VIS</div>", "VIS"],
      ["a hidden list item closed by the next list item", "<ul><li hidden>x<li>VIS</ul>", "VIS"],
      ["unclosed options in a select", "<select><option>a<option>b</select>VIS", "VIS"],
      ["a head that is never closed", "<head><title>T</title><body>VIS", "VIS"],
      ["a hidden heading closed by the next heading", "<h1 hidden>x<h2>VIS</h1>", "VIS"],
      ["a hidden div with an unclosed paragraph", "<div hidden><p>x</div>VIS", "VIS"],
      [
        "a hidden span with a hidden-free link",
        "<span hidden><a href='https://e.invalid/'>x</a></span>VIS",
        "VIS",
      ],
      ["a hidden formatting element closed by its own end tag", "<b hidden>x</b>VIS", "VIS"],
      ["a hidden table row", "<table><tr hidden><td>x</td></tr></table>VIS", "VIS"],
    ];
    for (const [name, html, visible] of BENIGN) {
      it(`keeps the text after: ${name}`, () => {
        const result = htmlToText(html);
        expect(result.text, html).toContain(visible);
        expect(result.truncated, html).toBe(false);
      });
    }
  });
});

// --- the differential run -------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAGS = [
  "div",
  "span",
  "p",
  "b",
  "i",
  "a",
  "font",
  "em",
  "strong",
  "nobr",
  "li",
  "ul",
  "ol",
  "dl",
  "dd",
  "dt",
  "form",
  "table",
  "caption",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "select",
  "option",
  "optgroup",
  "label",
  "section",
  "h1",
  "h2",
  "center",
  "pre",
  "blockquote",
  "button",
  "x-foo",
  "svg",
  "math",
  "textarea",
  "noscript",
  "template",
  "body",
  "head",
  "html",
  "marquee",
  "object",
  "details",
  "summary",
  "ruby",
  "rt",
] as const;

const VOID_TAGS = ["br", "hr", "img", "input", "wbr"] as const;

const HIDING_ATTRIBUTES = [' hidden=""', ' aria-hidden="true"', ' style="display:none"'] as const;

interface GeneratedDocument {
  readonly html: string;
  readonly markers: number;
}

function generate(random: () => number): GeneratedDocument {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const operations = 3 + Math.floor(random() * 12);
  const open: string[] = [];
  let html = "";
  let markers = 0;
  for (let index = 0; index < operations; index += 1) {
    const roll = random();
    if (roll < 0.4) {
      const tag = pick(TAGS);
      html += random() < 0.3 ? `<${tag}${pick(HIDING_ATTRIBUTES)}>` : `<${tag}>`;
      open.push(tag);
    } else if (roll < 0.45) {
      html += `<${pick(VOID_TAGS)}${random() < 0.2 ? ` hidden` : ""}>`;
    } else if (roll < 0.7) {
      // Mostly the element on top, sometimes any other name: the misnested end tags.
      const top = open[open.length - 1];
      const tag = top !== undefined && random() < 0.4 ? top : pick(TAGS);
      html += `</${tag}>`;
      const at = open.lastIndexOf(tag);
      if (at >= 0) open.length = at;
    } else {
      html += ` T${markers} `;
      markers += 1;
    }
  }
  html += ` T${markers} `;
  return { html, markers: markers + 1 };
}

interface Parse5Node {
  readonly nodeName: string;
  readonly value?: string;
  readonly attrs?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly childNodes?: readonly Parse5Node[];
}

interface Parse5Module {
  parse(html: string): Parse5Node;
}

function findParse5(): string | null {
  const repoRoot = join(fileURLToPath(new URL("..", import.meta.url)), "..", "..");
  const store = join(repoRoot, "node_modules", ".pnpm");
  if (!existsSync(store)) return null;
  const folder = readdirSync(store)
    .filter((entry) => /^parse5@\d/.test(entry))
    .sort()
    .pop();
  if (folder === undefined) return null;
  const entry = join(store, folder, "node_modules", "parse5", "dist", "index.js");
  return existsSync(entry) ? entry : null;
}

/** The markers a browser keeps under a hidden ancestor. */
function hiddenMarkers(root: Parse5Node): Set<string> {
  const hidden = new Set<string>();
  const walk = (node: Parse5Node, underHidden: boolean): void => {
    const own =
      node.attrs?.some(
        (attr) =>
          attr.name === "hidden" ||
          (attr.name === "aria-hidden" && attr.value === "true") ||
          (attr.name === "style" && attr.value === "display:none"),
      ) === true;
    const hides = underHidden || own;
    if (node.nodeName === "#text" && hides) {
      for (const match of (node.value ?? "").matchAll(/T\d+/g)) hidden.add(match[0]);
    }
    for (const child of node.childNodes ?? []) walk(child, hides);
  };
  walk(root, false);
  return hidden;
}

const PARSE5_PATH = findParse5();

describe.skipIf(PARSE5_PATH === null)("differential against a spec-compliant tree builder", () => {
  it("never emits a marker that the browser tree keeps under a hidden ancestor", async () => {
    const parse5 = (await import(pathToFileURL(PARSE5_PATH as string).href)) as Parse5Module;
    // DIFF_SEED and DIFF_DOCUMENTS widen the run locally; the committed run is fixed.
    const random = mulberry32(Number(process.env.DIFF_SEED ?? 20_261_014));
    const failures: string[] = [];
    let withHidden = 0;
    let truncatedDocuments = 0;
    const documents = Number(process.env.DIFF_DOCUMENTS ?? 4_000);
    for (let index = 0; index < documents; index += 1) {
      const document = generate(random);
      const hidden = hiddenMarkers(parse5.parse(document.html));
      if (hidden.size > 0) withHidden += 1;
      const result = htmlToText(document.html);
      if (result.truncated) truncatedDocuments += 1;
      for (const marker of hidden) {
        if (new RegExp(`\\b${marker}\\b`).test(result.text)) {
          failures.push(`${marker} in ${document.html}`);
          break;
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
    // The run is not vacuous: many documents have hidden text, and the filter does not simply
    // give up on everything.
    expect(withHidden).toBeGreaterThan(1_000);
    expect(truncatedDocuments).toBeLessThan(documents * 0.25);
  }, 60_000);
});

// --- the parser's own cost ---------------------------------------------------------------------------

describe("MAJOR 3: the parser's work is bounded, not only the sink's", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function countWrites(run: () => void): { chunks: number; characters: number } {
    const original = Parser.prototype.write;
    let chunks = 0;
    let characters = 0;
    vi.spyOn(Parser.prototype, "write").mockImplementation(function (this: Parser, chunk: string) {
      chunks += 1;
      characters += chunk.length;
      return original.call(this, chunk);
    });
    run();
    return { chunks, characters };
  }

  const NESTED: ReadonlyArray<readonly [name: string, unit: string]> = [
    ["b", "<b>"],
    ["i and b", "<i><b>"],
    ["p and span", "<p><span>"],
  ];

  for (const [name, unit] of NESTED) {
    it(`stops writing once the depth cap tripped (${name})`, () => {
      const html = unit.repeat(Math.ceil(1_000_000 / unit.length));
      const started = performance.now();
      const { chunks, characters } = countWrites(() => {
        const result = htmlToText(html);
        expect(result.truncated).toBe(true);
        expect(result.report.hiddenBlocks).toBeGreaterThanOrEqual(1);
      });
      expect(characters).toBeLessThanOrEqual(32_768);
      expect(chunks).toBeGreaterThan(0);
      expect(performance.now() - started).toBeLessThan(2_000);
    });
  }

  it("writes the input in chunks of a few KiB, never in one piece", () => {
    const html = `<p>${"word ".repeat(40_000)}</p>`;
    const { chunks, characters } = countWrites(() => {
      htmlToText(html);
    });
    expect(characters).toBe(html.length);
    expect(chunks).toBeGreaterThan(20);
  });

  it("writes no more than the input cap, and counts the remainder", () => {
    const html = `<p>${"x".repeat(MAX_INPUT_CHARS * 2)}</p>`;
    const { characters } = countWrites(() => {
      const result = htmlToText(html);
      expect(result.truncated).toBe(true);
    });
    expect(characters).toBeLessThanOrEqual(MAX_INPUT_CHARS);
  });

  it("stops writing a feed once the depth cap tripped (1 MiB of unclosed elements)", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title>${"<x>".repeat(350_000)}`;
    const started = performance.now();
    const { characters } = countWrites(() => {
      const feed = parseFeed(xml);
      expect(feed.report.hiddenBlocks).toBeGreaterThanOrEqual(1);
    });
    expect(characters).toBeLessThanOrEqual(32_768);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("writes a feed in chunks and caps its input, counting the remainder", () => {
    const entry =
      "<entry><title>T</title><updated>2026-10-01T00:00:00Z</updated><content>body</content></entry>";
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">${entry.repeat(30_000)}</feed>`;
    expect(xml.length).toBeGreaterThan(2_000_000);
    const { chunks, characters } = countWrites(() => {
      const feed = parseFeed(xml);
      expect(feed.report.hiddenBlocks).toBeGreaterThanOrEqual(1);
    });
    expect(chunks).toBeGreaterThan(20);
    expect(characters).toBeLessThanOrEqual(1_048_576);
  });
});
