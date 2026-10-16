import { HOSTILE_CORPUS } from "@ccc/domain/approval-corpus.js";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureResearch } from "../research/api.js";
import { resetReaderState } from "../research/reader-state.js";
import { resetResearchState } from "../research/state.js";
import { fakeResearchApi, fakeResearchPorts } from "../test-support/research-api-fake.js";
import {
  itemsPage,
  REPORT_NOTE_ID,
  reportHeader,
  reportItem,
  reportSource,
  sourcesPage,
} from "../test-support/research-report-fixtures.js";
import {
  listOf,
  RESEARCH_NOW_MS,
  RESEARCH_ZONE,
  reportRow,
} from "../test-support/research-view-fixtures.js";
import { ResearchDestination } from "./research.js";

// The reader against hostile source and model text (plan 07-13 Task 3, threats T-07-40 and T-07-41,
// UI-SPEC accessibility floor 7). Every string a source or a model can supply -- a finding, a quote,
// a source title, an author, a citation title and an unavailable-source label -- carries each hostile
// input and must come out as literal text: no link, image, frame or script exists under the reader,
// no element is made from the text, no attribute carries it, and a control character is a visible
// token. This file is pure ASCII on purpose: every hostile character is an escape sequence, and the
// angle brackets are assembled from their character codes.
//
// The strings go to the reader RAW (07-FIX4 j): this file does not call the domain neutraliser, so
// the reader's own defence is what is under test, not a helper that stands in for the service.

const LT = String.fromCharCode(0x3c);
const GT = String.fromCharCode(0x3e);

/** The UI-SPEC hostile strings that the shared approval corpus does not already hold. */
const INLINE_HOSTILE: readonly (readonly [string, string])[] = [
  ["markdown-emphasis-and-link", "**bold** and [a](https://example.invalid/x) and `code`"],
  ["image-beacon", "![x](https://example.invalid/p.png)"],
  ["wikilink-embed", "![[private note]] and [[private note|alias]]"],
  ["script-tag", `${LT}script${GT}alert(1)${LT}/script${GT}`],
  ["html-image-handler", `${LT}img src=x onerror=alert(1)${GT}`],
  ["javascript-address", "javascript:alert(1)"],
  ["escaped-bidi-token", "invoice[U+202E]gpj.exe"],
  ["bidi-override", "invoice\u202egpj.exe"],
  ["backslash-escapes", "already \\[\\[escaped\\]\\] and \\*stars\\*"],
  ["long-5000", "y".repeat(5000)],
];

const CASES: readonly (readonly [string, string])[] = [
  ...HOSTILE_CORPUS.map((entry) => [entry.name, entry.text] as const),
  ...INLINE_HOSTILE,
];

const FORBIDDEN_ELEMENTS =
  "a, img, picture, source, iframe, frame, object, embed, script, style, link, form, input, textarea, select, svg, math, base, meta, video, audio";
const FORBIDDEN_ATTRIBUTES = ["href", "src", "srcset", "srcdoc", "action", "formaction", "style"];

beforeEach(() => {
  resetResearchState();
  resetReaderState();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  configureResearch(null);
  resetReaderState();
  resetResearchState();
});

async function mountReader(text: string): Promise<HTMLElement> {
  const items = [
    reportItem(1, {
      kind: "source-fact",
      text,
      quote: text,
      quoteSourceNumber: 1,
      citations: [{ number: 1, title: text }],
    }),
    reportItem(2, { kind: "inference", text, citations: [] }),
  ];
  const sources = [reportSource(1, { title: text, author: text })];
  const header = reportHeader({
    title: text,
    partial: true,
    sourceCount: 1,
    sourceTotal: 2,
    unavailableSources: [{ label: text, code: "timeout" }],
  });
  const api = fakeResearchApi({
    list: vi.fn(() => Promise.resolve(listOf([reportRow(0, { noteId: REPORT_NOTE_ID })]))),
    report: vi.fn((_id: string, page: string) =>
      Promise.resolve(page === "items" ? itemsPage(items, { header }) : sourcesPage(sources)),
    ),
  });
  configureResearch({ api, ...fakeResearchPorts() });
  render(
    <ResearchDestination
      connection={{ kind: "live" }}
      now={RESEARCH_NOW_MS}
      zone={RESEARCH_ZONE}
    />,
  );
  await waitFor(() =>
    expect(document.querySelector("button.ccc-report-row-button")).not.toBeNull(),
  );
  fireEvent.click(document.querySelector("button.ccc-report-row-button") as HTMLElement);
  await waitFor(() => expect(document.querySelectorAll("li.ccc-report-source")).toHaveLength(1));
  return document.querySelector("article.ccc-report-reader") as HTMLElement;
}

/** The text a sighted reader sees: the hidden prefixes removed. */
function visibleText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll(".ccc-visually-hidden")) hidden.remove();
  return clone.textContent ?? "";
}

/** The sorted tag names of the reader, leaving out the token and help-line spans the text may add. */
function shape(root: Element): string[] {
  return [...root.querySelectorAll("*")]
    .filter(
      (element) =>
        element.closest(".ccc-control-token") === null &&
        !element.classList.contains("ccc-field-help"),
    )
    .map((element) => element.tagName.toLowerCase())
    .sort();
}

/** The cap the reader applies, in UTF-16 units, plus the shortened line it adds. */
function shown(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} Text shortened for display.`;
}

/**
 * An independent statement of what must never reach the DOM raw: control, format and separator
 * characters, other whitespace than a plain space, private-use and unassigned code points, lone
 * surrogates, and the invisible fillers and variation selectors. Written here, not imported.
 */
const HIDDEN_RAW =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]|[^\S ]|\u034f|[\u115f\u1160\u2800\u3164\uffa0\u17b4\u17b5\ufe00-\ufe0f\u180b-\u180f]/u;

/**
 * What the element shows for `text` capped at `max`. Text with nothing hidden in it shows exactly
 * the capped text. Text with a hidden character shows no raw hidden character at all, and, when the
 * character sits well inside the cap, shows it as a visible token.
 */
function expectShown(element: Element, text: string, max: number, name: string, prefix = ""): void {
  const visible = visibleText(element);
  if (!HIDDEN_RAW.test(text)) {
    expect(visible, name).toBe(`${prefix}${shown(text, max)}`);
    return;
  }
  expect(HIDDEN_RAW.test(visible), `${name}: a hidden character reached the DOM raw`).toBe(false);
  expect(visible.startsWith(prefix), name).toBe(true);
  const at = [...text].findIndex((char) => HIDDEN_RAW.test(char));
  if (at >= 0 && at + 12 < max) {
    expect(element.querySelector(".ccc-control-token"), `${name}: no visible token`).not.toBeNull();
  }
}

describe("Test 3 (hostile): every hostile input renders as literal text and nothing else", () => {
  let baseline: string[] = [];

  it("has a benign baseline to compare element shapes against", async () => {
    const reader = await mountReader("plain words");
    baseline = shape(reader);
    expect(baseline.length).toBeGreaterThan(40);
  });

  it.each(CASES)("renders %s inertly", async (name, text) => {
    const reader = await mountReader(text);

    // No active element exists under the reader or anywhere in the destination.
    expect(reader.querySelector(FORBIDDEN_ELEMENTS)).toBeNull();
    expect(document.querySelector(FORBIDDEN_ELEMENTS)).toBeNull();
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.getAttributeNames()) {
        expect(attribute.startsWith("on"), `${name}: ${attribute}`).toBe(false);
        expect(FORBIDDEN_ATTRIBUTES, `${name}: ${attribute}`).not.toContain(attribute);
      }
      if (text.length > 3 && text.length < 200) {
        expect(element.getAttribute("id") ?? "", name).not.toContain(text);
        expect(element.getAttribute("class") ?? "", name).not.toContain(text);
      }
    }

    // Nothing in the text became an element: the reader has the same shape as for plain words.
    expect(shape(reader), name).toEqual(baseline);

    // The finding text is the raw characters, capped; a hidden one is a visible token.
    const finding = reader.querySelector(".ccc-report-text") as HTMLElement;
    expectShown(finding, text, 600, `${name} finding`);
    const quote = reader.querySelector("blockquote") as HTMLElement;
    expectShown(quote, text, 240, `${name} quote`);

    // The reader title, the source title and its author are text too.
    expectShown(reader.querySelector("h3") as HTMLElement, text, 200, `${name} title`);
    const heading = reader.querySelector("li.ccc-report-source h5") as HTMLElement;
    expectShown(heading, text, 200, `${name} source title`, "1. ");

    const authorTerm = [...reader.querySelectorAll("li.ccc-report-source dt")].find(
      (dt) => dt.textContent === "Author",
    );
    expectShown(authorTerm?.nextElementSibling as Element, text, 120, `${name} author`);

    // The unavailable-source line carries the label and a fixed reason.
    const line = reader.querySelector(".ccc-report-unavailable li") as HTMLElement;
    const lineText = visibleText(line);
    if (HIDDEN_RAW.test(text)) {
      expect(HIDDEN_RAW.test(lineText), `${name}: a hidden character reached the label raw`).toBe(
        false,
      );
    } else {
      expect(lineText, name).toContain(shown(text, 80));
    }
    expect(lineText, name).toContain("Didn't respond in time");

    // The citation button names the source and still holds only text.
    const cite = reader.querySelector("button[data-cite]") as HTMLElement;
    expect(cite.children.length === 0 || cite.querySelector(FORBIDDEN_ELEMENTS) === null).toBe(
      true,
    );
    // Its accessible name and tooltip carry the capped, neutralised title, never the raw one.
    for (const attribute of ["aria-label", "title"]) {
      const value = cite.getAttribute(attribute) ?? "";
      expect(HIDDEN_RAW.test(value), `${name}: ${attribute} holds a hidden character`).toBe(false);
      expect(value.length, `${name}: ${attribute} is not capped`).toBeLessThanOrEqual(80);
    }

    // Every visible control token is announced as a control character first.
    for (const token of reader.querySelectorAll(".ccc-control-token")) {
      expect(token.firstElementChild?.className).toContain("ccc-visually-hidden");
      expect(token.firstElementChild?.textContent).toMatch(/^control character/);
      expect(token.textContent).toMatch(/\[U\+[0-9A-F]{4,6}\]$/);
    }
  });

  it("shows a bidi override as a visible token, never as a reordering character", async () => {
    const reader = await mountReader("invoice\u202egpj.exe");
    expect(reader.textContent).not.toContain("\u202e");
    expect(reader.textContent).toContain("[U+202E]");
    expect(reader.querySelector(".ccc-control-token")).not.toBeNull();
    // The same holds in the attributes a screen reader and a tooltip read.
    const cite = reader.querySelector("button[data-cite]") as HTMLElement;
    expect(cite.getAttribute("aria-label")).toBe("Source 1: invoice[U+202E]gpj.exe");
    expect(cite.getAttribute("title")).toBe("invoice[U+202E]gpj.exe");
  });

  it("shortens 5,000 characters at every display cap and says so", async () => {
    const reader = await mountReader("y".repeat(5000));
    expect(reader.querySelector(".ccc-report-text")?.textContent).toBe(
      `${"y".repeat(600)} Text shortened for display.`,
    );
    expect(reader.textContent).not.toContain("y".repeat(601));
  });

  it("never shows a Markdown escape the vault note would carry", async () => {
    const reader = await mountReader("**bold** [[wikilink]] and under_score");
    const finding = reader.querySelector(".ccc-report-text") as HTMLElement;
    expect(visibleText(finding)).toBe("**bold** [[wikilink]] and under_score");
    expect(finding.textContent).not.toContain("\\*");
    expect(finding.textContent).not.toContain("\\[");
  });
});
