// The Research destination against the hostile report texts (plan 07-11, UI-SPEC accessibility
// floor 7, Non-Negotiable 2, threat T-07-38).
//
// Every entry of HOSTILE_REPORT_TEXTS is a span that would do something if an Obsidian note or an
// HTML page rendered it: fetch a beacon image, link out, open a callout, run a script. Here each
// one arrives from the "service" as a report title, an unreadable report's file name, the topic
// label and a configured source's label, and is rendered through the REAL components from
// `@ccc/plugin`. The bundle is built in memory from a virtual entry and run in jsdom (the
// approvals and tasks harness tests' technique; jsdom comes from the plugin package's own
// dependencies). Each text must come out as literal text and nothing else: no link, image, frame,
// script, form or style element, no event-handler, address or source attribute, no element made
// from the text.

import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { HOSTILE_REPORT_TEXTS } from "./hostile-report-text.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");

interface JsdomWindow {
  readonly document: Document;
  eval(code: string): unknown;
  close(): void;
}

interface JsdomModule {
  readonly JSDOM: new (
    html: string,
    options: Record<string, unknown>,
  ) => { readonly window: JsdomWindow };
  readonly VirtualConsole: new () => {
    on(event: string, listener: (...args: unknown[]) => void): void;
  };
}

const requireFromPlugin = createRequire(join(REPO_ROOT, "packages", "plugin", "package.json"));
const jsdom = requireFromPlugin("jsdom") as JsdomModule;

/** What the in-page run reports back for one hostile text. */
interface CaseResult {
  readonly name: string;
  readonly text: string;
  readonly forbiddenElements: readonly string[];
  readonly forbiddenAttributes: readonly string[];
  readonly titleChildElements: number;
  readonly titleText: string;
  readonly unreadableText: string;
  readonly subline: string;
  readonly sourceItemText: string;
  readonly sourceItemElements: number;
  // The reader (plan 07-13): the same text as a finding, a quote, a citation, a source title and
  // author, an unavailable-source label and the report title.
  readonly readerForbiddenElements: readonly string[];
  readonly readerForbiddenAttributes: readonly string[];
  readonly readerTitleText: string;
  readonly findingText: string;
  readonly findingChildElements: number;
  readonly quoteText: string;
  readonly quoteChildElements: number;
  readonly citationText: string;
  readonly sourceHeadingText: string;
  readonly authorText: string;
  readonly unavailableText: string;
}

const ENTRY = `
import { h, render } from "preact";
import { configureResearch, ResearchDestination, resetReaderState, resetResearchState } from "@ccc/plugin";
import { HOSTILE_REPORT_TEXTS } from "./hostile-report-text.ts";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const FORBIDDEN_ELEMENTS = "a, img, picture, source, iframe, frame, object, embed, script, style, link, form, input, svg, math, base, meta, video, audio";

function id25(seed) {
  return (seed.toLowerCase().replace(/[^0-9a-z]/g, "") + "0".repeat(25)).slice(0, 25);
}

function wait(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function runCase(entry) {
  const row = {
    readable: true,
    noteId: id25("note0"),
    notePath: "global/output/research-2026-10-14-report0.md",
    title: entry.text,
    generatedAt: "2026-10-14T11:00:00.000Z",
    partial: false,
    sourceCount: 3,
    sourceTotal: 3,
    itemCount: 12,
    unavailableCount: 0,
  };
  const unreadable = { readable: false, fileName: entry.text, notePath: "global/output/broken-report.md" };
  const status = {
    lastSuccess: null,
    lastFailure: null,
    inFlight: null,
    latestUnknown: null,
    configuredSources: [{ label: entry.text, host: "changelog.example.invalid" }],
    topicLabel: entry.text,
  };
  const api = {
    run: () => Promise.reject(new Error("unused")),
    status: () => Promise.resolve(status),
    list: () => Promise.resolve({ rows: [row, unreadable], nextCursor: null }),
    report: (noteId, page) =>
      Promise.resolve(
        page === "items"
          ? {
              page: "items",
              header: {
                title: entry.text,
                noteId: row.noteId,
                notePath: "global/output/research-2026-10-14-run1.md",
                generatedAt: "2026-10-14T11:00:00.000Z",
                partial: true,
                unavailableSources: [{ label: entry.text, code: "timeout" }],
                sourceCount: 1,
                sourceTotal: 2,
                kindCounts: { "source-fact": 1, "unverified-claim": 0, inference: 0 },
                summariser: "extractive",
                jobRunId: id25("run1"),
                runStartedAt: null,
                runEndedAt: null,
                runOutcome: null,
                runNotePath: null,
              },
              items: [
                {
                  index: 1,
                  kind: "source-fact",
                  text: entry.text,
                  quote: entry.text,
                  quoteSourceNumber: 1,
                  citations: [{ number: 1, title: entry.text }],
                },
              ],
              nextCursor: null,
              truncated: false,
            }
          : {
              page: "sources",
              sources: [
                {
                  number: 1,
                  sourceType: "feed-entry",
                  id: "0123456789abcdef0123456789abcdef",
                  title: entry.text,
                  canonicalUrl: "https://changelog.example.invalid/feed/1",
                  author: entry.text,
                  publishedAt: null,
                  retrievedAt: "2026-10-14T10:59:00.000Z",
                  contentHash: "0".repeat(64),
                  snapshotPath: "global/raw/0123456789abcdef0123456789abcdef.00000000.md",
                  accessClass: "public",
                  counts: null,
                },
              ],
              nextCursor: null,
              truncated: false,
            },
      ),
  };
  configureResearch({
    api,
    notify: () => undefined,
    openNote: () => true,
    copyText: () => true,
    requestRunNow: () => undefined,
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(h(ResearchDestination, { connection: { kind: "live" }, now: NOW, zone: "UTC" }), host);
  const deadline = Date.now() + 4000;
  while (host.querySelector(".ccc-report-row-button") === null) {
    if (Date.now() > deadline) throw new Error("never rendered: " + entry.name);
    await wait(5);
  }
  await wait(10);
  const toggle = [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-controls") !== null && /configured sources/.test(b.textContent));
  if (toggle) toggle.click();
  await wait(10);
  const forbiddenElements = [...host.querySelectorAll(FORBIDDEN_ELEMENTS)].map((el) => el.tagName.toLowerCase());
  const forbiddenAttributes = [];
  for (const el of host.querySelectorAll("*")) {
    for (const attr of el.attributes) {
      if (/^on/i.test(attr.name) || ["href", "src", "srcset", "action", "formaction", "style", "xlink:href"].includes(attr.name.toLowerCase())) {
        forbiddenAttributes.push(el.tagName.toLowerCase() + "[" + attr.name + "]");
      }
    }
  }
  const title = host.querySelector(".ccc-report-row-button .ccc-clamp-2");
  const unreadableItem = [...host.querySelectorAll("li.ccc-report-row")].find((li) => li.querySelector("button.ccc-report-row-button") === null);
  const sourceItem = host.querySelector(".ccc-research-sources-config li");
  const result = {
    name: entry.name,
    text: entry.text,
    forbiddenElements,
    forbiddenAttributes,
    titleChildElements: title ? title.children.length : -1,
    titleText: title ? title.textContent : "",
    unreadableText: unreadableItem ? unreadableItem.textContent : "",
    subline: host.querySelector(".ccc-research-subline") ? host.querySelector(".ccc-research-subline").textContent : "",
    sourceItemText: sourceItem ? sourceItem.textContent : "",
    sourceItemElements: sourceItem ? [...sourceItem.children].filter((c) => !c.classList.contains("ccc-mono") && !c.classList.contains("ccc-field-help")).length : -1,
  };
  // Open the report: the same hostile text is now a finding, a quote, a citation, a source and more.
  host.querySelector(".ccc-report-row-button").click();
  const readerDeadline = Date.now() + 4000;
  while (host.querySelectorAll("li.ccc-report-source").length === 0) {
    if (Date.now() > readerDeadline) throw new Error("reader never rendered: " + entry.name);
    await wait(5);
  }
  await wait(10);
  const reader = host.querySelector("article.ccc-report-reader");
  const authorTerm = [...reader.querySelectorAll("li.ccc-report-source dt")].find((dt) => dt.textContent === "Author");
  const readerForbiddenAttributes = [];
  for (const el of reader.querySelectorAll("*")) {
    for (const attr of el.attributes) {
      if (/^on/i.test(attr.name) || ["href", "src", "srcset", "action", "formaction", "style", "xlink:href"].includes(attr.name.toLowerCase())) {
        readerForbiddenAttributes.push(el.tagName.toLowerCase() + "[" + attr.name + "]");
      }
    }
  }
  const finding = reader.querySelector(".ccc-report-text");
  const quote = reader.querySelector("blockquote");
  const readerResult = {
    ...result,
    readerForbiddenElements: [...reader.querySelectorAll(FORBIDDEN_ELEMENTS)].map((el) => el.tagName.toLowerCase()),
    readerForbiddenAttributes,
    readerTitleText: reader.querySelector("h3").textContent,
    findingText: finding.textContent,
    findingChildElements: finding.children.length,
    quoteText: quote.textContent,
    quoteChildElements: quote.children.length,
    citationText: reader.querySelector("button[data-cite]").textContent,
    sourceHeadingText: reader.querySelector("li.ccc-report-source h5").textContent,
    authorText: authorTerm.nextElementSibling.textContent,
    unavailableText: reader.querySelector(".ccc-report-unavailable li").textContent,
  };
  render(null, host);
  host.remove();
  resetResearchState();
  resetReaderState();
  configureResearch(null);
  return readerResult;
}

(async () => {
  const results = [];
  for (const entry of HOSTILE_REPORT_TEXTS) results.push(await runCase(entry));
  window.__hostileResults = results;
  window.__hostileDone = true;
})().catch((error) => {
  window.__hostileError = String(error && error.message ? error.message : error);
  window.__hostileDone = true;
});
`;

let bundle = "";

beforeAll(async () => {
  const result = await build({
    absWorkingDir: PACKAGE_DIR,
    stdin: {
      contents: ENTRY,
      resolveDir: join(PACKAGE_DIR, "src"),
      sourcefile: "research-view-hostile-entry.tsx",
      loader: "tsx",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    write: false,
    logLevel: "silent",
    // The corpus is imported by its source extension; esbuild resolves it to the .ts file.
    resolveExtensions: [".ts", ".tsx", ".js", ".mjs", ".json"],
  });
  bundle = result.outputFiles[0]?.text ?? "";
}, 60_000);

async function runInPage(): Promise<readonly CaseResult[]> {
  const errors: string[] = [];
  const virtualConsole = new jsdom.VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(String((error as Error).message)));
  const dom = new jsdom.JSDOM("<!doctype html><html><body></body></html>", {
    url: "file:///harness/index.html",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  // Runs the bundle this test just built from the repository's own source, inside a jsdom
  // window: no network, no host access, no outside code.
  dom.window.eval(bundle);
  const page = dom.window as unknown as {
    __hostileDone?: boolean;
    __hostileError?: string;
    __hostileResults?: readonly CaseResult[];
  };
  const deadline = Date.now() + 60_000;
  while (page.__hostileDone !== true) {
    if (Date.now() > deadline) throw new Error("The hostile run never finished");
    await new Promise((done) => setTimeout(done, 20));
  }
  if (page.__hostileError !== undefined) throw new Error(page.__hostileError);
  const results = page.__hostileResults ?? [];
  dom.window.close();
  expect(errors).toEqual([]);
  return results;
}

let results: readonly CaseResult[] = [];

beforeAll(async () => {
  results = await runInPage();
}, 90_000);

describe("the Research destination renders every hostile report text as literal text", () => {
  it("rendered one case per hostile text", () => {
    expect(HOSTILE_REPORT_TEXTS.length).toBeGreaterThan(40);
    expect(results.map((result) => result.name)).toEqual(
      HOSTILE_REPORT_TEXTS.map((entry) => entry.name),
    );
  });

  it.each(HOSTILE_REPORT_TEXTS.map((entry) => [entry.name, entry.text] as const))(
    "%s: no link, image, frame, script, form or style, and no handler or address attribute",
    (name) => {
      const result = results.find((candidate) => candidate.name === name);
      expect(result?.forbiddenElements).toEqual([]);
      expect(result?.forbiddenAttributes).toEqual([]);
    },
  );

  it.each(HOSTILE_REPORT_TEXTS.map((entry) => [entry.name, entry.text] as const))(
    "%s: the title, file name, topic and source label are the literal characters",
    (name, text) => {
      const result = results.find((candidate) => candidate.name === name);
      expect(result?.titleChildElements).toBe(0);
      expect(result?.titleText).toBe(text);
      expect(result?.unreadableText).toContain(text);
      expect(result?.subline.startsWith(text.slice(0, 80))).toBe(true);
      expect(result?.sourceItemText).toContain(text);
      expect(result?.sourceItemElements).toBe(0);
    },
  );

  it.each(HOSTILE_REPORT_TEXTS.map((entry) => [entry.name, entry.text] as const))(
    "%s: the opened reader holds no link, image, frame, script or address attribute",
    (name) => {
      const result = results.find((candidate) => candidate.name === name);
      expect(result?.readerForbiddenElements).toEqual([]);
      expect(result?.readerForbiddenAttributes).toEqual([]);
    },
  );

  it.each(HOSTILE_REPORT_TEXTS.map((entry) => [entry.name, entry.text] as const))(
    "%s: the reader's title, finding, quote, citation, source and unavailable label are the literal characters",
    (name, text) => {
      const result = results.find((candidate) => candidate.name === name);
      expect(result?.readerTitleText).toBe(text);
      expect(result?.findingText).toBe(text);
      expect(result?.findingChildElements).toBe(0);
      expect(result?.quoteText).toBe(text);
      expect(result?.quoteChildElements).toBe(0);
      expect(result?.citationText).toBe(`[1] ${text}`);
      expect(result?.sourceHeadingText).toBe(`1. ${text}`);
      expect(result?.authorText).toBe(text);
      expect(result?.unavailableText).toContain(text);
    },
  );
});
