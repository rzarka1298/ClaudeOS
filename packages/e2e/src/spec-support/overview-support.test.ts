import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import { pathsForRoot } from "../run-root.js";
import { OVERVIEW_TEXT } from "./overview-copy.js";
import {
  cardByTitle,
  checkSliceCards,
  FIXTURE_MARKERS,
  findFixtureMarkers,
  OVERVIEW_DOM_CONFIG,
  type OverviewCard,
  seedSlice,
  sliceProjectFolder,
} from "./overview-support.js";

/**
 * Plan 08-19 Task 1: the renderer reader of the Overview cards, run the way wdio runs it (compiled
 * by esbuild with keepNames as tsx does, sent as text, defined in a clean context that has no
 * `__name`) against a synthetic DOM that mirrors what the plugin's frame, footer, list and launch
 * toolbar render; the slice verdict; the fixture-marker finder; and the sandbox-only seeding.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "overview-dom-fixtures", "slice-cards.html");
const SOURCE = readFileSync(join(HERE, "overview-support.ts"), "utf8");

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

/** The top-level declaration of `name`: its `function` line to the closing brace at column 0. */
function declarationOf(name: string): string {
  const start = SOURCE.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, "m"));
  if (start < 0) throw new Error(`no declaration of ${name}`);
  const end = SOURCE.indexOf("\n}\n", start);
  return SOURCE.slice(start, end + 2);
}

/** The text wdio would send for a renderer function: compiled with keepNames, then toString(). */
function rendererText(name: string): string {
  const compiled = loadEsbuild().transformSync(declarationOf(name), {
    loader: "ts",
    keepNames: true,
    format: "cjs",
    target: "es2022",
  }).code;
  const loader = {
    __name: (fn: unknown) => fn,
    module: { exports: {} },
    exports: {},
    out: undefined as unknown,
  };
  vm.runInNewContext(`${compiled}\nout = ${name};`, loader);
  return String(loader.out);
}

function readCards(html: string): OverviewCard[] {
  const { JSDOM } = loadJsdom();
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  const window = dom.window as Record<string, unknown> & { document: unknown };
  const context = vm.createContext({
    document: window.document,
    window,
    getComputedStyle: (window.getComputedStyle as (n: unknown) => unknown).bind(window),
  });
  const text = rendererText("rendererReadOverviewCards");
  const out = vm.runInContext(
    `(${text}).apply(null, ${JSON.stringify([OVERVIEW_DOM_CONFIG])})`,
    context,
  );
  return JSON.parse(JSON.stringify(out)) as OverviewCard[];
}

const BASE_HTML = readFileSync(FIXTURE, "utf8");
const SEED = { projectName: "uat-slice-project", sessionName: "Session 1a2b3c4d" };

function slice(cards: readonly OverviewCard[]): string[] {
  return checkSliceCards(cards, SEED);
}

describe("rendererReadOverviewCards (Test 2)", () => {
  const cards = readCards(BASE_HTML);

  it("reads the four slice cards in page order, with title and presentation", () => {
    expect(cards.map((card) => card.title)).toEqual([
      OVERVIEW_TEXT.projectShortcutsTitle,
      OVERVIEW_TEXT.activeSessionsTitle,
      OVERVIEW_TEXT.todayTitle,
      OVERVIEW_TEXT.techIntelTitle,
    ]);
    expect(cards.every((card) => card.presentation === "ready")).toBe(true);
    expect(cards.every((card) => !card.dimmed)).toBe(true);
  });

  it("reads each footer: time, freshness, the partial chip and the source rows", () => {
    const today = cardByTitle(cards, OVERVIEW_TEXT.todayTitle) as OverviewCard;
    expect(today.footer.time).toBe("4s ago");
    expect(today.footer.freshness).toBe("live");
    expect(today.footer.freshnessLabel).toBe("Live");
    expect(today.footer.partial).toContain("Google Calendar and Gmail aren't part of this version");
    expect(today.footer.sources).toEqual([
      "Google Calendar — not part of this version",
      "Gmail — not part of this version",
      "Managed task store — ok",
      "Automation runs — ok",
    ]);
    const intel = cardByTitle(cards, OVERVIEW_TEXT.techIntelTitle) as OverviewCard;
    expect(intel.footer.freshness).toBe("cached");
    expect(intel.footer.partial).toBeNull();
  });

  it("reads the Today sections, the task rows by accessible name and the note", () => {
    const today = cardByTitle(cards, OVERVIEW_TEXT.todayTitle) as OverviewCard;
    expect(today.sections).toEqual([
      { text: "Due today", focal: true },
      { text: "Automation", focal: false },
    ]);
    expect(today.rows.map((row) => row.label)).toEqual([
      "Open task: Sort the synthetic backlog, Overdue since Oct 5",
      "Open task: Review the invented notes, Overdue since Oct 7",
    ]);
    expect(today.note).toBe("∅ Google Calendar and Gmail: not part of this version.");
    expect(today.stateLines).toContain("No automation failures.");
  });

  it("reads the project row with its launch toolbar and the technology card's latest report", () => {
    const projects = cardByTitle(cards, OVERVIEW_TEXT.projectShortcutsTitle) as OverviewCard;
    expect(projects.rows[0]?.primary).toBe("uat-slice-project");
    expect(projects.launch.map((button) => button.label)).toEqual([
      "Open uat-slice-project in Antigravity",
      "Start Claude Code in uat-slice-project",
      "Open uat-slice-project with Claude + Codex",
      "Reveal uat-slice-project in Finder",
      "Open uat-slice-project on GitHub",
    ]);
    expect(projects.launch.map((button) => button.disabled)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(projects.launchStatus).toBe("");
    const intel = cardByTitle(cards, OVERVIEW_TEXT.techIntelTitle) as OverviewCard;
    expect(intel.intel?.title).toBe("Developer tooling and open-source releases");
    expect(intel.buttons.map((button) => button.text)).toEqual(["Open report"]);
  });

  it("reads a card in the disconnected state as dimmed with its last values", () => {
    const dimmed = BASE_HTML.replace(
      '<section class="ccc-card" data-presentation="ready" data-size="wide" aria-labelledby="t-today">',
      '<section class="ccc-card" data-presentation="disconnected" data-size="wide" aria-labelledby="t-today">',
    ).replace(
      '<div class="ccc-card-body">\n      <h4 class="ccc-today-section" data-focal="true">',
      '<div class="ccc-card-body" data-dimmed="true">\n      <p class="ccc-state-heading">Service disconnected</p>\n      <h4 class="ccc-today-section" data-focal="true">',
    );
    const today = cardByTitle(readCards(dimmed), OVERVIEW_TEXT.todayTitle) as OverviewCard;
    expect(today.presentation).toBe("disconnected");
    expect(today.dimmed).toBe(true);
    expect(today.heading).toBe("Service disconnected");
    expect(today.rows).toHaveLength(2);
  });

  it("returns an empty list on a page with no cards", () => {
    expect(readCards("<p>nothing</p>")).toEqual([]);
  });

  it("survives wdio's keepNames transform: the sent text mentions no __name helper", () => {
    expect(rendererText("rendererReadOverviewCards")).not.toMatch(/\b__name\b/);
  });
});

describe("checkSliceCards (item 1)", () => {
  it("passes on the complete slice", () => {
    expect(slice(readCards(BASE_HTML))).toEqual([]);
  });

  it("names a missing card", () => {
    const cards = readCards(BASE_HTML).filter((card) => card.title !== OVERVIEW_TEXT.todayTitle);
    expect(slice(cards)).toContain(`there is no ${OVERVIEW_TEXT.todayTitle} card`);
  });

  it("names a project row or a session that is not there", () => {
    const noProject = BASE_HTML.replaceAll("uat-slice-project", "another-folder");
    expect(slice(readCards(noProject)).join("|")).toContain("project");
    const noSession = BASE_HTML.replaceAll("1a2b3c4d", "ffffffff");
    expect(slice(readCards(noSession)).join("|")).toContain("session");
  });

  it("requires the launch control to be present, named and enabled", () => {
    const gone = BASE_HTML.replace(
      /<button type="button" class="ccc-quick-action" aria-label="Open uat-slice-project in Antigravity"[^>]*>Antigravity<\/button>/,
      "",
    );
    expect(slice(readCards(gone)).join("|")).toContain("launch control");
    const disabled = BASE_HTML.replace(
      'aria-label="Open uat-slice-project in Antigravity" tabindex="0"',
      'aria-label="Open uat-slice-project in Antigravity" aria-disabled="true" tabindex="0"',
    );
    expect(slice(readCards(disabled)).join("|")).toContain("launch control");
  });

  it("requires a managed task row in Today", () => {
    const noRows = BASE_HTML.replace(
      /<ul class="ccc-list">\s*<li class="ccc-list-row">\s*<button[^>]*Open task:[\s\S]*?<\/ul>/,
      "",
    );
    expect(slice(readCards(noRows)).join("|")).toContain("task");
  });

  it("requires the report on the technology card, as Cached and never Live", () => {
    const live = BASE_HTML.replace('data-badge="cached"', 'data-badge="live"').replace(
      '<span class="ccc-badge-label">Cached</span>',
      '<span class="ccc-badge-label">Live</span>',
    );
    expect(slice(readCards(live)).join("|")).toContain("Cached");
    const noReport = BASE_HTML.replace(/<div class="ccc-intel-latest">[\s\S]*?<\/div>/, "");
    expect(slice(readCards(noReport)).join("|")).toContain("report");
  });

  it("requires source and freshness attribution on every card", () => {
    const noBadge = BASE_HTML.replace(
      /<span class="ccc-badge" data-badge="live"><span class="ccc-badge-glyph" aria-hidden="true">●<\/span><span class="ccc-visually-hidden">Freshness: <\/span><span class="ccc-badge-label">Live<\/span><\/span>\s*<button type="button" class="ccc-source-button" aria-expanded="false" aria-controls="panel-sessions">/,
      '<button type="button" class="ccc-source-button" aria-expanded="false" aria-controls="panel-sessions">',
    );
    expect(slice(readCards(noBadge)).join("|")).toContain(
      `${OVERVIEW_TEXT.activeSessionsTitle} shows no freshness`,
    );
    const noSources = BASE_HTML.replace(
      /<li class="ccc-source-row">Claude Code hooks — ok<\/li>/,
      "",
    );
    expect(slice(readCards(noSources)).join("|")).toContain(
      `${OVERVIEW_TEXT.activeSessionsTitle} lists no source`,
    );
    const noTime = BASE_HTML.replace(">3s ago</time>", ">—</time>");
    expect(slice(readCards(noTime)).join("|")).toContain(
      `${OVERVIEW_TEXT.activeSessionsTitle} shows no time`,
    );
  });

  it("refuses a card that is not ready", () => {
    const loading = BASE_HTML.replace(
      'data-presentation="ready" data-size="wide"',
      'data-presentation="loading" data-size="wide"',
    );
    expect(slice(readCards(loading)).join("|")).toContain(`${OVERVIEW_TEXT.todayTitle} is loading`);
  });
});

describe("findFixtureMarkers (Test 2)", () => {
  it("reports nothing for clean text", () => {
    expect(findFixtureMarkers("const a = 1; // the slice reads only service data")).toEqual([]);
    expect(findFixtureMarkers(BASE_HTML)).toEqual([]);
  });

  it("reports each known synthetic fixture title by name, not by context", () => {
    const text = `x ${FIXTURE_MARKERS[0]?.text} y ${FIXTURE_MARKERS[2]?.text}`;
    expect(findFixtureMarkers(text)).toEqual([FIXTURE_MARKERS[0]?.name, FIXTURE_MARKERS[2]?.name]);
  });

  it("lists only markers that really are in the synthetic widget fixture file", () => {
    const fixture = readFileSync(
      join(REPO_ROOT, "packages", "test-fixtures", "src", "widget-fixtures.json"),
      "utf8",
    );
    expect(FIXTURE_MARKERS.length).toBeGreaterThanOrEqual(6);
    for (const marker of FIXTURE_MARKERS) {
      expect(fixture.includes(marker.text), marker.name).toBe(true);
    }
  });

  it("uses unique names that carry no marker text", () => {
    const names = FIXTURE_MARKERS.map((marker) => marker.name);
    expect(new Set(names).size).toBe(names.length);
    for (const marker of FIXTURE_MARKERS) expect(marker.name).not.toContain(marker.text);
  });
});

describe("seedSlice (sandbox only)", () => {
  const runRoot = "/tmp/ccc-uat.AbCd12";
  const paths = pathsForRoot(runRoot, "AbCd12");

  function deps(overrides: Partial<Parameters<typeof seedSlice>[0]> = {}) {
    const calls: string[] = [];
    const base: Parameters<typeof seedSlice>[0] = {
      runRoot,
      paths,
      makeFolder: (folder) => {
        calls.push(`mkdir ${folder}`);
      },
      register: async (folder) => {
        calls.push(`register ${folder}`);
        return { kind: "registered", projectId: "proj-1" };
      },
      startSession: async (folder, sessionId) => {
        calls.push(`session ${folder} ${sessionId}`);
      },
      newSessionId: () => "0a1b2c3d4e5f6a7b",
      ...overrides,
    };
    return { base, calls };
  }

  it("keeps the project folder strictly inside the run root", () => {
    const folder = sliceProjectFolder(paths, runRoot);
    expect(folder.startsWith(`${runRoot}/`)).toBe(true);
    expect(() => sliceProjectFolder(paths, "/tmp/ccc-uat.Other99")).toThrow(/run root/);
  });

  it("registers the folder, then starts the synthetic session in it", async () => {
    const { base, calls } = deps();
    const seed = await seedSlice(base);
    expect(seed.projectName).toBe("uat-slice-project");
    expect(seed.projectId).toBe("proj-1");
    expect(seed.sessionName).toBe("Session 0a1b2c3d");
    expect(seed.folder.startsWith(`${runRoot}/`)).toBe(true);
    expect(calls.map((call) => call.split(" ")[0])).toEqual(["mkdir", "register", "session"]);
  });

  it("refuses a protected-location answer and starts no session", async () => {
    const { base, calls } = deps({
      register: async () => ({ kind: "protected-location" }),
    });
    await expect(seedSlice(base)).rejects.toThrow(/protected/);
    expect(calls.some((call) => call.startsWith("session"))).toBe(false);
  });
});
