import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { Key } from "webdriverio";
import { REPO_ROOT } from "../repo-paths.js";
import { pathsForRoot } from "../run-root.js";
import { OVERVIEW_TEXT } from "./overview-copy.js";
import {
  assertNoLauncherSaved,
  cardByTitle,
  checkCalendarGmail,
  checkDisconnected,
  checkFailureLine,
  checkLaunchOutcome,
  checkNextOpen,
  checkNoFailures,
  checkNoFixtureOnCards,
  checkOnlyPressedChanged,
  checkRecovered,
  checkSliceCards,
  checkTechEmpty,
  checkTechLatest,
  completeDueAndOverdue,
  ENTER_KEY,
  FIXTURE_MARKERS,
  findFixtureMarkers,
  findLauncherProcesses,
  LAUNCHER_ROWS_SQL,
  markDoneText,
  OVERVIEW_DOM_CONFIG,
  type OverviewBrowser,
  type OverviewCard,
  pressLaunchControl,
  scanBuiltPlugin,
  seedSlice,
  sliceProjectFolder,
  upcomingTaskRequest,
} from "./overview-support.js";
import { checkStatusChangeDiff } from "./tasks-support.js";

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

// ---------------------------------------------------------------------------
// Plan 08-19 Task 2: items 2 to 8

/** Applies `change` to the one card of `html` whose heading id is `id` (a section is `<section ...>` to its end). */
function mapCard(html: string, id: string, change: (card: string) => string): string {
  return html
    .split(/(?=<section class="ccc-card")/)
    .map((part) => (part.includes(`id="${id}"`) ? change(part) : part))
    .join("");
}

const TODAY = "t-today";
const INTEL = "t-intel";
const PROJECTS = "t-projects";

function disconnect(card: string): string {
  return card
    .replace('data-presentation="ready"', 'data-presentation="disconnected"')
    .replace(
      /<div class="ccc-card-body"([^>]*)>/,
      '<div class="ccc-card-body"$1 data-dimmed="true"><p class="ccc-state-heading">Service disconnected</p><p class="ccc-state-body">Showing the last values received 2 minutes ago. They may be out of date.</p>',
    )
    .replace(/data-badge="(?:live|cached)"/, 'data-badge="unavailable"')
    .replace(
      /<span class="ccc-badge-label">(?:Live|Cached)<\/span>/,
      '<span class="ccc-badge-label">Unavailable</span>',
    );
}

describe("checkCalendarGmail (item 2)", () => {
  it("passes on a Today card that names both sources as not part of this version", () => {
    expect(checkCalendarGmail(readCards(BASE_HTML))).toEqual([]);
  });

  it("requires the Partial chip, the note and both source rows", () => {
    const noChip = mapCard(BASE_HTML, TODAY, (card) =>
      card.replace(/<span class="ccc-badge" data-badge="partial">[\s\S]*?<\/span><\/span>/, ""),
    );
    expect(checkCalendarGmail(readCards(noChip)).join("|")).toContain("Partial");
    const noNote = mapCard(BASE_HTML, TODAY, (card) =>
      card.replace(/<p class="ccc-today-note">[\s\S]*?<\/p>/, ""),
    );
    expect(checkCalendarGmail(readCards(noNote)).join("|")).toContain("note");
    const noRow = mapCard(BASE_HTML, TODAY, (card) =>
      card.replace('<li class="ccc-source-row">Gmail — not part of this version</li>', ""),
    );
    expect(checkCalendarGmail(readCards(noRow)).join("|")).toContain("Gmail");
  });

  it("refuses 'no response' for either source, and any calendar count of zero", () => {
    const missing = mapCard(BASE_HTML, TODAY, (card) =>
      card.replace("Google Calendar — not part of this version", "Google Calendar — no response"),
    );
    expect(checkCalendarGmail(readCards(missing)).join("|")).toContain("Google Calendar");
    const zero = mapCard(BASE_HTML, TODAY, (card) =>
      card.replace(
        '<p class="ccc-state-body">No automation failures.</p>',
        '<p class="ccc-state-body">Nothing else on the calendar today.</p>',
      ),
    );
    expect(checkCalendarGmail(readCards(zero)).join("|")).toContain("calendar");
  });

  it("refuses a Today card that is the old permission-required card", () => {
    const old = mapCard(BASE_HTML, TODAY, (card) =>
      card.replace('data-presentation="ready"', 'data-presentation="permission-required"'),
    );
    expect(checkCalendarGmail(readCards(old)).join("|")).toContain("permission-required");
  });
});

const NEXT_OPEN_INNER =
  '<h4 class="ccc-today-section">Due today</h4><p class="ccc-state-body">Nothing is due today.</p>' +
  '<h4 class="ccc-today-section" data-focal="true">Next open task</h4><ul class="ccc-list"><li class="ccc-list-row">' +
  '<button type="button" class="ccc-list-primary ccc-clamp-2 ccc-session-row-link" title="Plan the invented trip" aria-label="Open task: Plan the invented trip, Next due Oct 30">Plan the invented trip</button>' +
  '<p class="ccc-list-meta">Next due Oct 30</p></li></ul>';

function withToday(inner: string): string {
  return mapCard(BASE_HTML, TODAY, (card) =>
    card.replace(
      /(<div class="ccc-card-body">\s*)<h4 class="ccc-today-section" data-focal="true">Due today<\/h4>[\s\S]*?(<h4 class="ccc-today-section">Automation<\/h4>)/,
      `$1${inner}$2`,
    ),
  );
}

describe("checkNextOpen (item 3)", () => {
  it("passes when nothing is due and a Next open task row labelled Next due opens a task", () => {
    expect(checkNextOpen(readCards(withToday(NEXT_OPEN_INNER)))).toEqual([]);
  });

  it("accepts the undated label", () => {
    const undated = withToday(
      NEXT_OPEN_INNER.replaceAll("Next due Oct 30", "Most recent open task"),
    );
    expect(checkNextOpen(readCards(undated))).toEqual([]);
  });

  it("refuses a Today card that still lists due or overdue rows", () => {
    expect(checkNextOpen(readCards(BASE_HTML)).join("|")).toContain("Nothing is due today");
  });

  it("refuses a missing next-open row, a wrong label and a row that is not a task control", () => {
    const none = withToday(
      '<h4 class="ccc-today-section">Due today</h4><p class="ccc-state-body">Nothing is due today.</p>',
    );
    expect(checkNextOpen(readCards(none)).join("|")).toContain("Next open task");
    const wrong = withToday(NEXT_OPEN_INNER.replaceAll("Next due Oct 30", "Due Oct 30"));
    expect(checkNextOpen(readCards(wrong)).join("|")).toContain("label");
    const notTask = withToday(NEXT_OPEN_INNER.replace("Open task: ", "Look at: "));
    expect(checkNextOpen(readCards(notTask)).join("|")).toContain("task");
  });
});

const TECH_EMPTY = (card: string): string =>
  card
    .replace('data-presentation="ready"', 'data-presentation="empty"')
    .replace(
      /<div class="ccc-card-body" tabindex="0">\s*<div class="ccc-intel-latest">[\s\S]*?<\/div>\s*<\/div>/,
      '<div class="ccc-card-body"><p class="ccc-state-heading">No reports yet</p><p class="ccc-state-body">Press Run now in the research view to write the first cited report.</p><button type="button" class="ccc-list-more">Open the research view</button></div>',
    );

describe("checkTechEmpty and checkTechLatest (item 4)", () => {
  const row = { title: "Developer tooling and open-source releases", sourceCount: 3, itemCount: 6 };

  it("passes the empty state and refuses a card that already holds a report", () => {
    expect(checkTechEmpty(readCards(mapCard(BASE_HTML, INTEL, TECH_EMPTY)))).toEqual([]);
    expect(checkTechEmpty(readCards(BASE_HTML)).join("|")).toContain(OVERVIEW_TEXT.noReportsYet);
  });

  it("passes the latest report as Cached with its title, counts, AI line and Open report", () => {
    expect(checkTechLatest(readCards(BASE_HTML), row)).toEqual([]);
  });

  it("refuses a Live badge, a wrong title, wrong counts and a missing AI line", () => {
    const live = mapCard(BASE_HTML, INTEL, (card) =>
      card
        .replace('data-badge="cached"', 'data-badge="live"')
        .replace(
          '<span class="ccc-badge-label">Cached</span>',
          '<span class="ccc-badge-label">Live</span>',
        ),
    );
    expect(checkTechLatest(readCards(live), row).join("|")).toContain("Cached");
    expect(
      checkTechLatest(readCards(BASE_HTML), { ...row, title: "Another title" }).join("|"),
    ).toContain("title");
    expect(checkTechLatest(readCards(BASE_HTML), { ...row, sourceCount: 5 }).join("|")).toContain(
      "counts",
    );
    const noAi = mapCard(BASE_HTML, INTEL, (card) =>
      card.replace(
        '<p class="ccc-list-meta">AI-generated summary. Not verified by a person.</p>',
        "",
      ),
    );
    expect(checkTechLatest(readCards(noAi), row).join("|")).toContain("AI-generated");
  });

  it("names the Open report control by its report", () => {
    const unnamed = mapCard(BASE_HTML, INTEL, (card) =>
      card.replace(' aria-label="Open report: Developer tooling and open-source releases"', ""),
    );
    expect(checkTechLatest(readCards(unnamed), row).join("|")).toContain("Open report");
  });
});

const FAILURE_LINE =
  '<p class="ccc-state-body"><span class="ccc-error-glyph" aria-hidden="true">✕</span> Research run failed 2 minutes ago: no source could be fetched.</p><button type="button" class="ccc-list-more">Open the research view</button>';

describe("checkFailureLine and checkNoFailures (item 5)", () => {
  const failed = mapCard(BASE_HTML, TODAY, (card) =>
    card.replace('<p class="ccc-state-body">No automation failures.</p>', FAILURE_LINE),
  );

  it("passes a Today card that shows the failed run with its reason and a way to the research view", () => {
    expect(checkFailureLine(readCards(failed))).toEqual([]);
  });

  it("refuses a Today card without the failure line, or with a line that has no reason", () => {
    expect(checkFailureLine(readCards(BASE_HTML)).join("|")).toContain(OVERVIEW_TEXT.failedStem);
    const noReason = failed.replace(": no source could be fetched.", ".");
    expect(checkFailureLine(readCards(noReason)).join("|")).toContain("reason");
  });

  it("passes the cleared card and refuses one that still shows a failure", () => {
    expect(checkNoFailures(readCards(BASE_HTML))).toEqual([]);
    expect(checkNoFailures(readCards(failed)).join("|")).toContain("still");
    const neither = mapCard(BASE_HTML, TODAY, (card) =>
      card.replace('<p class="ccc-state-body">No automation failures.</p>', ""),
    );
    expect(checkNoFailures(readCards(neither)).join("|")).toContain(OVERVIEW_TEXT.noFailures);
  });
});

describe("checkDisconnected and checkRecovered (item 7)", () => {
  const down = mapCard(mapCard(BASE_HTML, TODAY, disconnect), INTEL, disconnect);

  it("passes Today and Technology both dimmed, disconnected and Unavailable", () => {
    expect(checkDisconnected(readCards(down))).toEqual([]);
  });

  it("names a card that stayed live, was not dimmed, or kept a freshness other than Unavailable", () => {
    expect(checkDisconnected(readCards(BASE_HTML)).join("|")).toContain(OVERVIEW_TEXT.todayTitle);
    const undimmed = down.replaceAll(' data-dimmed="true"', "");
    expect(checkDisconnected(readCards(undimmed)).join("|")).toContain("dimmed");
    const stillLive = mapCard(down, TODAY, (card) =>
      card
        .replace('data-badge="unavailable"', 'data-badge="live"')
        .replace(
          '<span class="ccc-badge-label">Unavailable</span>',
          '<span class="ccc-badge-label">Live</span>',
        ),
    );
    expect(checkDisconnected(readCards(stillLive)).join("|")).toContain(
      OVERVIEW_TEXT.freshnessUnavailable,
    );
  });

  it("passes the recovered page and refuses one that is still disconnected", () => {
    expect(checkRecovered(readCards(BASE_HTML))).toEqual([]);
    expect(checkRecovered(readCards(down)).join("|")).toContain("disconnected");
  });
});

describe("checkLaunchOutcome (item 6)", () => {
  const outcome = mapCard(BASE_HTML, PROJECTS, (card) =>
    card.replace(
      '<p role="status" class="ccc-launch-status"></p>',
      '<p role="status" class="ccc-launch-status" data-tone="error"><span class="ccc-error-glyph" aria-hidden="true">▲</span>Antigravity isn\'t set up yet.<br>Set it up in Settings → Launchers, then try again.</p>',
    ),
  );

  it("passes the typed not-set-up outcome for the pressed launcher", () => {
    expect(checkLaunchOutcome(readCards(outcome), "antigravity")).toEqual([]);
  });

  it("refuses an empty status line, a success line and the service-unreachable outcome", () => {
    expect(checkLaunchOutcome(readCards(BASE_HTML), "antigravity").join("|")).toContain("status");
    const success = outcome.replace("Antigravity isn't set up yet.", "Opened in Antigravity");
    expect(checkLaunchOutcome(readCards(success), "antigravity").join("|")).toContain("set up");
    const down = outcome.replace(
      "Antigravity isn't set up yet.",
      "Couldn't reach the command center service.",
    );
    expect(checkLaunchOutcome(readCards(down), "antigravity").join("|")).toContain("service");
  });
});

describe("assertNoLauncherSaved and pressLaunchControl (T-08-48, D-46)", () => {
  const LABEL = "Open uat-slice-project in Antigravity";
  const outcomeCards = readCards(
    mapCard(BASE_HTML, PROJECTS, (card) =>
      card.replace(
        '<p role="status" class="ccc-launch-status"></p>',
        '<p role="status" class="ccc-launch-status">▲Antigravity isn\'t set up yet.Set it up in Settings → Launchers, then try again.</p>',
      ),
    ),
  );

  it("reads launcher rows with one fixed read-only statement", () => {
    expect(LAUNCHER_ROWS_SQL).toBe("select launcher_id from launcher_config order by launcher_id;");
  });

  it("accepts no rows, or rows for other launchers, and refuses the pressed launcher's row", () => {
    expect(() => assertNoLauncherSaved([], "antigravity")).not.toThrow();
    expect(() =>
      assertNoLauncherSaved([{ launcher_id: "claude-desktop" }], "antigravity"),
    ).not.toThrow();
    expect(() => assertNoLauncherSaved([{ launcher_id: "antigravity" }], "antigravity")).toThrow(
      /launcher is saved/,
    );
    expect(() => assertNoLauncherSaved([{ launcher_id: "claude-code" }], "claude-code")).toThrow(
      /launcher is saved/,
    );
  });

  it("refuses an answer it cannot read, rather than assume no launcher is saved", () => {
    expect(() => assertNoLauncherSaved(undefined as never, "antigravity")).toThrow(/read/);
    expect(() => assertNoLauncherSaved([{ id: "x" }], "antigravity")).toThrow(/read/);
    expect(() => assertNoLauncherSaved([null], "antigravity")).toThrow(/read/);
  });

  function fakeBrowser(scripted: {
    cards: OverviewCard[];
    activeLabel?: string | null;
    /** What holds focus when it is re-read just before Enter (FIX4A m4); defaults to the control. */
    activeNow?: string | null;
    /** The cards after the press; defaults to `cards`. */
    after?: OverviewCard[];
    found?: boolean;
  }): { browser: OverviewBrowser; keys: unknown[]; executed: string[] } {
    const keys: unknown[] = [];
    const executed: string[] = [];
    const browser = {
      execute: async (fn: { name: string }) => {
        executed.push(fn.name);
        if (fn.name === "rendererReadOverviewCards") {
          // The first reads are before the press; once Enter was sent the scripted `after` cards.
          return keys.length > 0 && scripted.after !== undefined ? scripted.after : scripted.cards;
        }
        if (fn.name === "rendererActiveLabel") {
          return scripted.activeNow === undefined ? LABEL : scripted.activeNow;
        }
        if (fn.name === "rendererFocusControl") {
          return { found: scripted.found ?? true, activeLabel: scripted.activeLabel ?? LABEL };
        }
        throw new Error(`unexpected renderer function ${fn.name}`);
      },
      keys: async (value: unknown) => {
        keys.push(value);
      },
      executeObsidian: async () => true,
      executeObsidianCommand: async () => undefined,
    } as unknown as OverviewBrowser;
    return { browser, keys, executed };
  }

  const FAST = { timeoutMs: 50, intervalMs: 1 };

  it("refuses to touch the page at all when the launcher is saved (the helper cannot run)", async () => {
    const { browser, keys, executed } = fakeBrowser({ cards: outcomeCards });
    await expect(
      pressLaunchControl(browser, {
        projectName: "uat-slice-project",
        action: "antigravity",
        readLauncherRows: async () => [{ launcher_id: "antigravity" }],
        poll: FAST,
      }),
    ).rejects.toThrow(/launcher is saved/);
    expect(keys).toEqual([]);
    expect(executed).toEqual([]);
  });

  it("refuses when the store cannot be read", async () => {
    const { browser, keys } = fakeBrowser({ cards: outcomeCards });
    await expect(
      pressLaunchControl(browser, {
        projectName: "uat-slice-project",
        action: "antigravity",
        readLauncherRows: async () => {
          throw new Error("copy failed");
        },
        poll: FAST,
      }),
    ).rejects.toThrow(/copy failed/);
    expect(keys).toEqual([]);
  });

  it("focuses the named control, presses Enter once and returns the typed outcome", async () => {
    const { browser, keys } = fakeBrowser({ cards: outcomeCards });
    const result = await pressLaunchControl(browser, {
      projectName: "uat-slice-project",
      action: "antigravity",
      readLauncherRows: async () => [],
      poll: FAST,
    });
    expect(keys).toEqual([Key.Enter]);
    expect(ENTER_KEY).toBe(Key.Enter);
    expect(result.label).toBe(LABEL);
    expect(result.status).toContain("isn't set up yet");
  });

  it("re-reads the focused control just before Enter and does not press when it moved (FIX4A m4)", async () => {
    const { browser, keys, executed } = fakeBrowser({
      cards: outcomeCards,
      activeNow: "Reveal uat-slice-project in Finder",
    });
    await expect(
      pressLaunchControl(browser, {
        projectName: "uat-slice-project",
        action: "antigravity",
        readLauncherRows: async () => [],
        poll: FAST,
      }),
    ).rejects.toThrow(/moved|focus/);
    expect(keys).toEqual([]);
    // The re-read comes after the focus call and before any key.
    expect(executed.indexOf("rendererActiveLabel")).toBeGreaterThan(
      executed.indexOf("rendererFocusControl"),
    );
  });

  it("does not press when nothing holds focus any more", async () => {
    const { browser, keys } = fakeBrowser({ cards: outcomeCards, activeNow: null });
    await expect(
      pressLaunchControl(browser, {
        projectName: "uat-slice-project",
        action: "antigravity",
        readLauncherRows: async () => [],
        poll: FAST,
      }),
    ).rejects.toThrow(/moved|focus/);
    expect(keys).toEqual([]);
  });

  it("fails when the Finder control's status shows after the press (FIX4A m4)", async () => {
    const finderCards = readCards(
      mapCard(BASE_HTML, PROJECTS, (card) =>
        card.replace(
          '<p role="status" class="ccc-launch-status"></p>',
          '<p role="status" class="ccc-launch-status">▲Antigravity isn\'t set up yet.Set it up in Settings → Launchers, then try again. ✓ Revealed in Finder</p>',
        ),
      ),
    );
    const { browser, keys } = fakeBrowser({ cards: outcomeCards, after: finderCards });
    await expect(
      pressLaunchControl(browser, {
        projectName: "uat-slice-project",
        action: "antigravity",
        readLauncherRows: async () => [],
        poll: FAST,
      }),
    ).rejects.toThrow(/Finder|changed/);
    expect(keys).toEqual([Key.Enter]);
  });

  it("does not press when focus did not land on the named control", async () => {
    const { browser, keys } = fakeBrowser({ cards: outcomeCards, activeLabel: "Something else" });
    await expect(
      pressLaunchControl(browser, {
        projectName: "uat-slice-project",
        action: "antigravity",
        readLauncherRows: async () => [],
        poll: FAST,
      }),
    ).rejects.toThrow(/focus/);
    expect(keys).toEqual([]);
  });

  it("does not press a control that is missing or disabled", async () => {
    const disabled = readCards(
      mapCard(BASE_HTML, PROJECTS, (card) =>
        card.replace(
          'aria-label="Open uat-slice-project in Antigravity" tabindex="0"',
          'aria-label="Open uat-slice-project in Antigravity" aria-disabled="true" tabindex="0"',
        ),
      ),
    );
    const { browser, keys } = fakeBrowser({ cards: disabled });
    await expect(
      pressLaunchControl(browser, {
        projectName: "uat-slice-project",
        action: "antigravity",
        readLauncherRows: async () => [],
        poll: FAST,
      }),
    ).rejects.toThrow(/launch control/);
    expect(keys).toEqual([]);
  });

  it("fails with the last status text when no typed outcome appears", async () => {
    const { browser } = fakeBrowser({ cards: readCards(BASE_HTML) });
    await expect(
      pressLaunchControl(browser, {
        projectName: "uat-slice-project",
        action: "antigravity",
        readLauncherRows: async () => [],
        poll: FAST,
      }),
    ).rejects.toThrow(/outcome/);
  });

  it("only knows the two launchers that need a saved configuration (never Finder or GitHub)", async () => {
    const { browser, keys } = fakeBrowser({ cards: outcomeCards });
    await expect(
      pressLaunchControl(browser, {
        projectName: "uat-slice-project",
        action: "finder" as never,
        readLauncherRows: async () => [],
        poll: FAST,
      }),
    ).rejects.toThrow(/not a launcher/);
    expect(keys).toEqual([]);
  });
});

describe("checkOnlyPressedChanged (FIX4A m4)", () => {
  const before = readCards(BASE_HTML);
  const withStatus = (text: string) =>
    readCards(
      mapCard(BASE_HTML, PROJECTS, (card) =>
        card.replace(
          '<p role="status" class="ccc-launch-status"></p>',
          `<p role="status" class="ccc-launch-status">${text}</p>`,
        ),
      ),
    );

  it("accepts a status line that holds only the pressed launcher's not-set-up outcome", () => {
    const after = withStatus(
      "▲Antigravity isn't set up yet.Set it up in Settings → Launchers, then try again.",
    );
    expect(checkOnlyPressedChanged(before, after, "antigravity")).toEqual([]);
  });

  it("flags the Finder control's opening or success line on the status line", () => {
    for (const text of ["Revealing uat-slice-project in Finder…", "✓ Revealed in Finder"]) {
      const problems = checkOnlyPressedChanged(before, withStatus(text), "antigravity");
      expect(problems.join(" "), text).toContain("Finder");
    }
  });

  it("flags a change on any card other than the project shortcuts", () => {
    const changed = before.map((card) =>
      card.title === OVERVIEW_TEXT.todayTitle
        ? { ...card, launchStatus: "Opening Antigravity…" }
        : card,
    );
    expect(checkOnlyPressedChanged(before, changed, "antigravity").join(" ")).toContain(
      OVERVIEW_TEXT.todayTitle,
    );
  });

  it("flags a status line that already held a Finder outcome before the press", () => {
    const stale = withStatus("✓ Revealed in Finder");
    expect(checkOnlyPressedChanged(stale, stale, "antigravity").join(" ")).toContain("Finder");
  });
});

describe("findLauncherProcesses", () => {
  const node = (command: string) => ({ pid: 100, ppid: 1, command });

  it("finds programs that open an app, a Finder window, a terminal or a browser", () => {
    const found = findLauncherProcesses([
      node("/usr/bin/open -b com.example.app /tmp/x"),
      node("/usr/bin/osascript -e tell"),
      node("/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"),
      node("/usr/bin/git status --porcelain"),
      node("/usr/bin/security find-generic-password -a x"),
    ]);
    expect(found.map((entry) => entry.command.split(" ")[0])).toEqual([
      "/usr/bin/open",
      "/usr/bin/osascript",
      "/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    ]);
  });

  it("finds nothing among harmless descendants", () => {
    expect(findLauncherProcesses([node("/usr/bin/git rev-parse HEAD")])).toEqual([]);
    expect(findLauncherProcesses([])).toEqual([]);
  });
});

describe("scanBuiltPlugin (item 8)", () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  function runRootWith(mainJs: string | null): { runRoot: string; stage: string } {
    const runRoot = mkdtempSync(join(tmpdir(), "ccc-uat."));
    folders.push(runRoot);
    const stage = join(runRoot, "plugin-stage");
    mkdirSync(stage, { recursive: true });
    if (mainJs !== null) writeFileSync(join(stage, "main.js"), mainJs);
    return { runRoot, stage };
  }

  it("reads main.js of the staged copy and reports no marker for clean code", () => {
    const { runRoot, stage } = runRootWith("var a = 1; // service data only");
    expect(scanBuiltPlugin(stage, runRoot)).toEqual({ bytes: 31, markers: [] });
  });

  it("reports a fixture marker by name only", () => {
    const first = FIXTURE_MARKERS[0];
    const { runRoot, stage } = runRootWith(`var t = "${first?.text}";`);
    const result = scanBuiltPlugin(stage, runRoot);
    expect(result.markers).toEqual([first?.name]);
    expect(JSON.stringify(result)).not.toContain(first?.text ?? "unreachable");
  });

  it("refuses a stage folder outside the run root, a missing main.js and a linked main.js", () => {
    const { runRoot } = runRootWith("x");
    const outside = mkdtempSync(join(tmpdir(), "ccc-outside."));
    folders.push(outside);
    writeFileSync(join(outside, "main.js"), "x");
    expect(() => scanBuiltPlugin(outside, runRoot)).toThrow(/run root/);
    const empty = runRootWith(null);
    expect(() => scanBuiltPlugin(empty.stage, empty.runRoot)).toThrow(/main\.js/);
    const linked = runRootWith(null);
    writeFileSync(join(outside, "real.js"), "x");
    symlinkSync(join(outside, "real.js"), join(linked.stage, "main.js"));
    expect(() => scanBuiltPlugin(linked.stage, linked.runRoot)).toThrow(/link/);
  });
});

describe("checkNoFixtureOnCards (item 8)", () => {
  it("passes the real-looking cards", () => {
    expect(checkNoFixtureOnCards(readCards(BASE_HTML))).toEqual([]);
  });

  it("names a fixture marker that reached a card", () => {
    const first = FIXTURE_MARKERS[1];
    const dirty = BASE_HTML.replaceAll("Sort the synthetic backlog", first?.text ?? "");
    const problems = checkNoFixtureOnCards(readCards(dirty));
    expect(problems.join("|")).toContain(first?.name);
    expect(problems.join("|")).not.toContain(first?.text ?? "unreachable");
  });
});

describe("completing the tasks due today and overdue (item 3)", () => {
  const NOW = "2026-10-23T12:00:00.000Z";
  const NOTE = [
    "---",
    "id: abc",
    "scope: global",
    "updated: '2026-10-08T06:57:00.000Z'",
    "title: 'A task'",
    "status: ready",
    "due: 2026-10-05",
    "tags:",
    "  - ops",
    "---",
    "Synthetic task 1.",
    "",
  ].join("\n");

  it("marks a note done by changing only status, updated and completed", () => {
    const done = markDoneText(NOTE, NOW);
    expect(checkStatusChangeDiff(NOTE, done, { expectStatus: "done" })).toEqual({ ok: true });
    expect(done).toContain("status: done");
  });

  it("refuses text that is not a task note", () => {
    expect(() => markDoneText("no front matter", NOW)).toThrow(/front matter/);
    expect(() => markDoneText(NOTE.replace("status: ready\n", ""), NOW)).toThrow(/status/);
  });

  it("keeps the due line byte for byte", () => {
    const done = markDoneText(NOTE, NOW);
    expect(done.split("\n").find((line) => line.startsWith("due:"))).toBe("due: 2026-10-05");
  });

  function world(ids: string[]) {
    const notes = new Map(ids.map((id) => [`${id}.md`, NOTE.replace("id: abc", `id: ${id}`)]));
    const writes: string[] = [];
    const open = new Set(ids);
    return {
      writes,
      deps: {
        zone: "UTC",
        nowIso: NOW,
        dueToday: async () => ({
          due: [],
          overdue: [...open].map((taskId) => ({ taskId, title: "t" })),
        }),
        readNotes: () =>
          [...notes.entries()].map(([name, text]) => ({
            path: `global/tasks/${name}`,
            name,
            text,
          })),
        writeNote: (name: string, text: string) => {
          writes.push(name);
          notes.set(name, text);
          open.delete(name.replace(/\.md$/, ""));
        },
        poll: { timeoutMs: 50, intervalMs: 1 },
      },
    };
  }

  it("completes every row the service lists, round by round, until none is left", async () => {
    const { deps, writes } = world(["a1", "b2", "c3"]);
    const total = await completeDueAndOverdue(deps);
    expect(total).toBe(3);
    expect(writes.sort()).toEqual(["a1.md", "b2.md", "c3.md"]);
  });

  it("returns zero when nothing is due", async () => {
    const { deps, writes } = world([]);
    expect(await completeDueAndOverdue(deps)).toBe(0);
    expect(writes).toEqual([]);
  });

  it("stops with a message when a listed task has no note it can edit", async () => {
    const { deps } = world(["a1"]);
    const stuck = {
      ...deps,
      dueToday: async () => ({ due: [], overdue: [{ taskId: "missing", title: "t" }] }),
    };
    await expect(completeDueAndOverdue(stuck)).rejects.toThrow(/no note/);
  });
});

describe("the upcoming task request (item 3)", () => {
  it("is a ready task due a week after the machine's today, in the owner's zone", () => {
    const request = upcomingTaskRequest("UTC", Date.parse("2026-10-23T12:00:00Z"));
    expect(request).toEqual({
      title: "Slice proof upcoming task",
      intent: "ready",
      zone: "UTC",
      dueDate: "2026-10-30",
    });
  });
});
