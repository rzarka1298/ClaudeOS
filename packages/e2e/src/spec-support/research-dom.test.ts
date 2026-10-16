import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import { DOM_CONFIG } from "./research-support.js";

/**
 * The renderer readers of research-dom.ts, run the way wdio runs them (compiled by esbuild with
 * keepNames as tsx does, sent as text, defined in a clean context with no `__name`) against DOM
 * the REAL plugin components rendered (the HTML under research-dom-fixtures/ was dumped from the
 * plugin's own Research destination in its test environment). jsdom is the plugin package's
 * existing test dependency; it has no layout, so the geometry readers are exercised only for
 * their shape (they return `found: false` without a reader and never throw).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "research-dom-fixtures");

interface EsbuildLike {
  transformSync(
    code: string,
    options: { loader: string; keepNames: boolean; format: string; target: string },
  ): { code: string };
}

function loadEsbuild(): EsbuildLike {
  const here = createRequire(import.meta.url);
  const vitePath = createRequire(here.resolve("vitest/package.json")).resolve("vite");
  return createRequire(vitePath)("esbuild") as EsbuildLike;
}

function loadJsdom(): { JSDOM: new (html: string) => { window: Record<string, unknown> } } {
  return createRequire(join(REPO_ROOT, "packages", "plugin", "package.json"))("jsdom");
}

/** research-dom.ts as tsx would load it: keepNames on, evaluated, its exports returned. */
function compiledModule(): Record<string, (...args: never[]) => unknown> {
  const code = loadEsbuild().transformSync(readFileSync(join(HERE, "research-dom.ts"), "utf8"), {
    loader: "ts",
    keepNames: true,
    format: "cjs",
    target: "es2022",
  }).code;
  const sandbox: { exports: Record<string, unknown>; module: { exports: unknown } } = {
    exports: {},
    module: { exports: {} },
  };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(code, sandbox);
  return sandbox.module.exports as Record<string, (...args: never[]) => unknown>;
}

const MODULE = compiledModule();

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.html`), "utf8");
}

interface Page {
  window: Record<string, unknown> & { document: unknown };
  context: vm.Context;
}

function page(html: string): Page {
  const { JSDOM } = loadJsdom();
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  const window = dom.window as Page["window"];
  const context = vm.createContext({
    document: window.document,
    window,
    getComputedStyle: (window.getComputedStyle as (n: unknown) => unknown).bind(window),
  });
  return { window, context };
}

/** The text wdio would send for an exported function, defined in the page's own context. */
function inPage<T>(target: Page, name: string): (...args: unknown[]) => T {
  const fn = MODULE[name];
  if (fn === undefined) throw new Error(`research-dom.ts exports no ${name}`);
  const text = String(fn);
  expect(text, name).not.toMatch(/\b__name\b/);
  return vm.runInContext(`(${text})`, target.context) as (...args: unknown[]) => T;
}

function read(name: string) {
  const target = page(fixture(name));
  const result = inPage<unknown>(target, "rendererReadResearch")(DOM_CONFIG);
  return JSON.parse(JSON.stringify(result)) as import("./research-dom.js").RenderedResearch;
}

describe("every exported renderer function survives the keepNames transform", () => {
  const names = Object.keys(MODULE).filter((name) => name.startsWith("renderer"));

  it("finds the renderer functions", () => {
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it("sends none that mentions __name and defines each in a clean context", () => {
    for (const name of names) {
      const text = String(MODULE[name]);
      expect(text, name).not.toMatch(/\b__name\b/);
      const clean = vm.createContext({});
      const defined = vm.runInContext(`(${text})`, clean);
      expect(typeof defined, name).toBe("function");
      expect(vm.runInContext("typeof __name", clean)).toBe("undefined");
    }
  });
});

describe("rendererReadResearch over the plugin's own markup", () => {
  it("reads the first open: no reports, nothing run", () => {
    const state = read("empty");
    expect(state.mounted).toBe(true);
    expect(state.heading).toBe("Research");
    expect(state.runNow).toMatchObject({ present: true, label: "Run now", disabled: false });
    expect(state.runNow.name).toBe("Run now: fetch the sources and write a research report");
    expect(state.subline).toBe("Developer tooling and open-source releases · 3 sources configured");
    expect(state.runStatus.heading).toBe("Run status");
    const rows = Object.fromEntries(state.runStatus.rows.map((row) => [row.label, row.value]));
    expect(rows["Last successful run"]).toBe("None yet");
    expect(rows["Last failed run"]).toBe("None");
    expect(state.list.rows).toEqual([]);
    expect(state.list.emptyHeading).toBe("No reports yet");
    expect(state.list.emptyBody).toBe(
      "Press Run now to fetch the configured sources and write your first cited report.",
    );
    expect(state.reader).toBeNull();
    expect(state.runStatus.sourcesToggle).toBe("Show configured sources (3)");
    expect(state.runStatus.sourcesExpanded).toBe(false);
  });

  it("reads a populated destination: the strip, the success row, the list row", () => {
    const state = read("populated");
    expect(state.strip.badges).toEqual([{ kind: "cached", glyph: "◐", label: "Cached" }]);
    const success = state.runStatus.rows.find((row) => row.label === "Last successful run");
    expect(success?.value).toContain("✓ Completed");
    expect(success?.value).toContain("3 sources");
    expect(success?.buttons).toEqual(["Open report"]);
    expect(state.list.rows).toHaveLength(1);
    const row = state.list.rows[0];
    expect(row?.title).toContain("Developer tooling and open-source releases");
    expect(row?.selected).toBe(true);
    expect(row?.badges).toEqual([{ kind: "cached", glyph: "◐", label: "Cached" }]);
    expect(row?.dateTime).toBe("2026-10-14T11:00:00.000Z");
    expect(row?.meta).toContain("3 sources");
    expect(row?.meta).toContain("12 items");
    expect(state.layout).toEqual({ readerOpen: "true", mode: "side" });
  });

  it("reads the open reader: header lines, legend, findings, citations and source entries", () => {
    const reader = read("populated").reader;
    if (reader === null) throw new Error("no reader");
    expect(reader.loading).toBe(false);
    expect(reader.failureHeading).toBeNull();
    expect(reader.title).toContain("Developer tooling");
    expect(reader.hasOpenNote).toBe(true);
    expect(reader.hasBackButton).toBe(false);
    expect(reader.counts).toBe("1 reported fact · 1 source claim · 1 model inference");
    expect(reader.ai).toBe(
      "AI-generated summary by the extractive summariser (no model). Not verified by a person.",
    );
    expect(reader.legend.map((entry) => [entry.kind, entry.term])).toEqual([
      ["source-fact", "≡ Reported fact"],
      ["unverified-claim", "“ Source claim"],
      ["inference", "∴ Model inference"],
    ]);
    expect(reader.findings.map((finding) => [finding.kind, finding.tag, finding.tagWord])).toEqual([
      ["source-fact", "≡ Reported fact", "Reported fact"],
      ["unverified-claim", "“ Source claim", "Source claim"],
      ["inference", "∴ Model inference", "Model inference"],
    ]);
    expect(reader.findings[0]?.hiddenPrefix).toBe("Finding 1, Reported fact:");
    expect(reader.findings[0]?.quote).toBe("fixes a stream reset in http2");
    expect(reader.findings[0]?.quoteCaption).toBe("Quoted from source 2");
    expect(reader.findings[0]?.citations).toEqual([
      {
        name: "Source 2: Sample runtime releases",
        text: "[2] Sample runtime releases",
        cite: "1-2",
      },
    ]);
    expect(reader.findings[2]?.citations).toEqual([]);
    expect(reader.headings).toEqual([
      "How to read this report",
      "Findings",
      "Sources",
      "Run record",
    ]);
    expect(reader.sources).toHaveLength(3);
    const first = reader.sources[0];
    expect(first?.number).toBe(1);
    expect(first?.title).toBe("Example tools changelog");
    expect(first?.fields.map((field) => field.term)).toEqual([
      "Type",
      "Access",
      "Address",
      "Author",
      "Published",
      "Retrieved",
      "Content hash",
      "Stable ID",
      "Snapshot",
      "Removed before summarising",
    ]);
    const field = (term: string) => first?.fields.find((entry) => entry.term === term);
    expect(field("Access")?.text).toBe("Public Fetched from a public web address.");
    expect(field("Address")?.text).toBe("https://changelog.example.invalid/feed/1");
    expect(field("Address")?.buttons).toEqual(["Copy address"]);
    expect(field("Content hash")?.text).toHaveLength(12);
    expect(field("Content hash")?.titles[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(field("Snapshot")?.buttons).toEqual(["Open snapshot"]);
    expect(reader.hasOpenRunNote).toBe(true);
    expect(reader.run.map((entry) => entry.term)).toEqual([
      "Run",
      "Started",
      "Finished",
      "Outcome",
      "Summariser",
    ]);
  });

  it("reads a partial report: the notice before the legend and the findings, the Partial badges", () => {
    const reader = read("partial").reader;
    if (reader === null) throw new Error("no reader");
    expect(reader.headings.slice(0, 3)).toEqual([
      "Unavailable sources",
      "How to read this report",
      "Findings",
    ]);
    expect(reader.unavailable?.heading).toBe("Unavailable sources");
    expect(reader.unavailable?.intro).toContain("2 of 6 sources were unavailable");
    expect(reader.unavailable?.entries).toEqual([
      "✕ Demo build tool releases — Didn't respond in time",
      "✕ Sample package registry — The site returned an error",
    ]);
    expect(reader.metaBadges.map((badge) => badge.kind)).toEqual(["cached", "partial"]);
    const list = read("partial").list.rows[0];
    expect(list?.badges.map((badge) => badge.kind)).toEqual(["cached", "partial"]);
    expect(list?.badges[1]).toEqual({ kind: "partial", glyph: "◈", label: "Partial" });
  });

  it("reads a failed run and the summariser setup callout", () => {
    const state = read("failed");
    const failed = state.runStatus.rows.find((row) => row.label === "Last failed run");
    expect(failed?.value).toContain("✕ Failed");
    expect(failed?.value).toContain("the summariser isn't set up");
    expect(state.runStatus.setup?.heading).toBe("The summariser isn't set up");
    expect(state.runStatus.setup?.body).toContain("Anthropic API key");
  });

  it("reads a run in flight: the Current run row and the reason beside Run now", () => {
    const state = read("running");
    const current = state.runStatus.rows.find((row) => row.label === "Current run");
    expect(current?.value).toContain("▸ Running");
    expect(current?.value).toContain("Fetching sources");
    expect(state.runNow.disabled).toBe(true);
    expect(state.runNow.reason).toBe("A run is in progress.");
  });

  it("reads a destination whose service is away: dimmed, Run now disabled with its reason", () => {
    const state = read("disconnected");
    expect(state.dimmed).toBe(true);
    expect(state.runNow.disabled).toBe(true);
    expect(state.runNow.reason).toBe("The companion service isn't running.");
    expect(state.strip.badges).toEqual([{ kind: "unavailable", glyph: "○", label: "Unavailable" }]);
    expect(state.list.rows).toHaveLength(1);
  });

  it("reads an absent destination as not mounted", () => {
    const target = page("<p>nothing</p>");
    const state = inPage<{ mounted: boolean }>(target, "rendererReadResearch")(DOM_CONFIG);
    expect(state.mounted).toBe(false);
  });
});

interface Elem {
  textContent: string | null;
  firstElementChild: Elem | null;
  focus(): void;
  click(): void;
  remove(): void;
  addEventListener(type: string, listener: () => void): void;
  insertAdjacentHTML(position: string, html: string): void;
  querySelector(selector: string): Elem | null;
  scrollIntoView(options?: unknown): void;
}
interface Doc {
  body: Elem;
  querySelector(selector: string): Elem | null;
  querySelectorAll(selector: string): Iterable<Elem>;
}

const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 5));

describe("the transcript, spies, clicks and focus readers", () => {
  it("records each change of the status line and the Current run row, once", async () => {
    const target = page(fixture("empty"));
    const doc = target.window.document as unknown as Doc;
    const statusLine = doc.querySelector(".ccc-research-status") as Elem;
    const start = inPage<boolean>(target, "rendererStartTranscript");
    expect(
      start("ccc-research", "ccc-research-status", "ccc-research-run-status", "Current run"),
    ).toBe(true);
    statusLine.textContent = "Starting a research run…";
    await tick();
    statusLine.textContent = "Starting a research run…";
    await tick();
    const list = doc.querySelector(".ccc-research-run-status dl") as Elem;
    list.insertAdjacentHTML(
      "afterbegin",
      "<dt>Current run</dt><dd>▸ Running · Fetching sources</dd>",
    );
    await tick();
    list.firstElementChild?.remove();
    list.firstElementChild?.remove();
    await tick();
    const records = inPage<Array<{ status: string; current: string | null }>>(
      target,
      "rendererReadTranscript",
    )();
    expect(records.map((entry) => [entry.status, entry.current])).toEqual([
      ["", null],
      ["Starting a research run…", null],
      ["Starting a research run…", "▸ Running · Fetching sources"],
      ["Starting a research run…", null],
    ]);
  });

  it("refuses to start a transcript on a page without the destination", () => {
    const target = page("<p>x</p>");
    expect(inPage<boolean>(target, "rendererStartTranscript")("a", "b", "c", "d")).toBe(false);
  });

  it("records clipboard writes and scroll options once installed, and clears them", async () => {
    const target = page(fixture("empty"));
    const win = target.window as unknown as {
      navigator: { clipboard?: { writeText(text: string): Promise<void> } };
      Element: { prototype: { scrollIntoView(options?: unknown): void } };
      document: Doc;
    };
    const written: string[] = [];
    Object.defineProperty(win.navigator, "clipboard", {
      value: { writeText: async (text: string) => void written.push(text) },
      configurable: true,
    });
    const scrolled: unknown[] = [];
    win.Element.prototype.scrollIntoView = (options?: unknown) => {
      scrolled.push(options);
    };
    expect(inPage<boolean>(target, "rendererInstallSpies")()).toBe(true);
    expect(inPage<boolean>(target, "rendererInstallSpies")()).toBe(false);
    await win.navigator.clipboard?.writeText("https://a.example.invalid/x");
    win.document.body.scrollIntoView({ block: "nearest" });
    win.document.body.scrollIntoView({ behavior: "smooth" });
    const seen = inPage<{ clipboard: string[]; scrolls: Array<{ behavior: string | null }> }>(
      target,
      "rendererReadSpies",
    )();
    expect(seen.clipboard).toEqual(["https://a.example.invalid/x"]);
    expect(seen.scrolls).toEqual([{ behavior: null }, { behavior: "smooth" }]);
    expect(written).toEqual(["https://a.example.invalid/x"]);
    expect(scrolled).toHaveLength(2);
    expect(inPage<boolean>(target, "rendererClearSpies")()).toBe(true);
    expect(inPage<{ clipboard: string[] }>(target, "rendererReadSpies")().clipboard).toEqual([]);
  });

  it("clicks the nth match and the match with an exact text", () => {
    const target = page(fixture("populated"));
    const doc = target.window.document as unknown as Doc;
    const clicked: string[] = [];
    for (const button of doc.querySelectorAll("button")) {
      button.addEventListener("click", () => clicked.push(button.textContent ?? ""));
    }
    expect(inPage<boolean>(target, "rendererClickNth")(".ccc-research-run button", 0)).toBe(true);
    expect(inPage<boolean>(target, "rendererClickNth")(".ccc-research-run button", 3)).toBe(false);
    expect(inPage<boolean>(target, "rendererClickByText")("button", "Open note")).toBe(true);
    expect(inPage<boolean>(target, "rendererClickByText")("button", "Open nothing")).toBe(false);
    expect(clicked).toEqual(["Run now", "Open note"]);
  });

  it("reads the focused element: its name, the source entry and the citation it is in", () => {
    const target = page(fixture("populated"));
    const doc = target.window.document as unknown as Doc;
    const read = inPage<{
      name: string;
      sourceNumber: string | null;
      cite: string | null;
      inReader: boolean;
      inRow: boolean;
    } | null>(target, "rendererReadFocus");
    expect(read("ccc-report-reader", "ccc-report-row")).toBeNull();
    (doc.querySelector("button[data-cite]") as Elem).focus();
    expect(read("ccc-report-reader", "ccc-report-row")).toMatchObject({
      name: "Source 2: Sample runtime releases",
      cite: "1-2",
      inReader: true,
      inRow: false,
      sourceNumber: null,
    });
    (doc.querySelector("li.ccc-report-source h5") as Elem).focus();
    expect(read("ccc-report-reader", "ccc-report-row")).toMatchObject({
      sourceNumber: "1",
      inReader: true,
    });
    (doc.querySelector("button.ccc-report-row-button") as Elem).focus();
    expect(read("ccc-report-reader", "ccc-report-row")).toMatchObject({ inRow: true });
  });

  it("reads layout and article facts as not found on a page without a reader", () => {
    const target = page(fixture("empty"));
    expect(
      inPage<{ found: boolean }>(target, "rendererReadArticle")(
        "ccc-report-reader",
        "ccc-report-item",
        "ccc-report-items",
        "ccc-report-text",
        "ccc-report-quote",
        "ccc-report-unavailable",
      ).found,
    ).toBe(false);
    const layout = inPage<{ found: boolean; list: unknown; backToReportsVisible: boolean }>(
      target,
      "rendererReadLayout",
    )(
      "ccc-research",
      "ccc-research-layout",
      "ccc-research-list-cell",
      "ccc-research-reader-cell",
      "ccc-report-reader",
    );
    expect(layout.found).toBe(true);
    expect(layout.backToReportsVisible).toBe(false);
  });

  it("reads the Overview cards' title, presentation, heading and body", () => {
    const target = page(
      `<section class="ccc-card" data-presentation="permission-required"><header><h3>Today</h3></header><p class="ccc-state-heading">Google Calendar and Gmail isn't connected</p><p class="ccc-state-body">Connect it.</p></section><section class="ccc-card" data-presentation="unavailable"><h3>Technology and market intelligence</h3><p class="ccc-state-heading">No source yet</p></section>`,
    );
    expect(inPage<unknown>(target, "rendererReadCards")("ccc-card")).toEqual([
      {
        title: "Today",
        presentation: "permission-required",
        heading: "Google Calendar and Gmail isn't connected",
        body: "Connect it.",
      },
      {
        title: "Technology and market intelligence",
        presentation: "unavailable",
        heading: "No source yet",
        body: "",
      },
    ]);
  });

  it("reads the rendered body of the active Reading view, and not the page around it", () => {
    const target = page(
      `<div class="workspace-leaf mod-active"><div class="markdown-reading-view"><div class="markdown-preview-sizer"><p>Untrusted source content</p><pre><code>line one
line two</code></pre><a href="https://x.example.invalid/">link</a><img src="x"></div></div></div><img src="chrome">`,
    );
    const facts = inPage<{
      found: boolean;
      images: number;
      anchors: Array<{ href: string; text: string }>;
      codeBlocks: string[];
      internalEmbeds: number;
    }>(target, "rendererReadReadingView")();
    expect(facts).toMatchObject({ found: true, images: 1, internalEmbeds: 0 });
    expect(facts.anchors).toEqual([{ href: "https://x.example.invalid/", text: "link" }]);
    expect(facts.codeBlocks).toEqual(["line one\nline two"]);
    expect(inPage<{ found: boolean }>(page("<p>x</p>"), "rendererReadReadingView")().found).toBe(
      false,
    );
  });
});
