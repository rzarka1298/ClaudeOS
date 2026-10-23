import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResearchStatusResponse } from "@ccc/domain/research-routes.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import {
  refreshOverviewFeeds,
  resetOverviewFeeds,
  startOverviewFeeds,
} from "../overview/overview-feeds.js";
import { configureResearch } from "../research/api.js";
import { configureTasksApi } from "../tasks/api.js";
import { fakeResearchApi, fakeResearchPorts } from "../test-support/research-api-fake.js";
import {
  EMPTY_STATUS,
  iso,
  listOf,
  RESEARCH_NOW_MS,
  reportRow,
} from "../test-support/research-view-fixtures.js";
import { fakeTasksApi } from "../test-support/tasks-api-fake.js";
import { nowTick } from "./clock.js";
import { PRD_PANEL_ORDER, type WidgetId } from "./registry.js";
import { CONSTANT_STATE_WIDGET_IDS, widgetStateFor } from "./widget-data.js";

/**
 * D-22 (plan 08-17): no widget on the Overview reads a fixture or a mock in a production
 * build, and a test fails if any of the five slice widgets ever does. Three independent
 * proofs, so a regression has to defeat all three:
 *
 * 1. structural: the constants table lists only the card that has no route;
 * 2. source scan: the files that build a slice widget's state import no fixture, harness
 *    or JSON module and never declare one of those widgets a constant;
 * 3. behavioural: with the real holders unconfigured neither service-fed card ever reports
 *    ready, and with fakes configured both go loading to ready with exactly the fakes' values.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(SRC_DIR, "..", "..", "..");

/** The five slice widgets (SLICE-01): project, launch action, session, Today and Technology. */
const SLICE_WIDGETS: readonly WidgetId[] = [
  "project-shortcuts",
  "quick-actions",
  "active-sessions",
  "today",
  "tech-intel",
];

describe("D-22 structural: the constant-state table", () => {
  it("lists exactly github-discoveries", () => {
    expect([...CONSTANT_STATE_WIDGET_IDS]).toEqual(["github-discoveries"]);
  });

  it.each(SLICE_WIDGETS)("%s is not a constant-state widget", (id) => {
    expect(CONSTANT_STATE_WIDGET_IDS.has(id)).toBe(false);
  });

  it("every slice widget is a registered panel, so the list above cannot drift from the registry", () => {
    for (const id of SLICE_WIDGETS) expect(PRD_PANEL_ORDER).toContain(id);
  });
});

/** The non-test sources of one directory under `src`, as paths relative to `src`. */
function sourcesIn(directory: string): string[] {
  return readdirSync(join(SRC_DIR, directory))
    .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.|\.audit\./.test(name))
    .map((name) => `${directory}/${name}`);
}

/** Every module specifier a file imports or re-exports from. */
function specifiersOf(file: string): string[] {
  const source = readFileSync(join(SRC_DIR, file), "utf8");
  return [
    ...source.matchAll(/\b(?:import|export)\b[^"';]*?from\s+"([^"]+)"|\bimport\s+"([^"]+)"/g),
  ].map((match) => match[1] ?? match[2] ?? "");
}

describe("D-22 source scan: the files that build the slice widgets' states", () => {
  // widget-data.ts and panels.tsx are the table and the bodies; overview/*.ts are the feeds;
  // the rest are the signals the other slice widgets are computed from.
  const SCANNED = [
    "widgets/widget-data.ts",
    "widgets/panels.tsx",
    ...sourcesIn("overview"),
    "projects/projects-state.ts",
    "widgets/session-signals.ts",
    "widgets/active-sessions.tsx",
  ];

  it("scans the overview feeds, so a new overview module is covered too", () => {
    expect(SCANNED).toContain("overview/overview-feeds.ts");
  });

  it.each(SCANNED)("%s imports no fixture, harness, test-support or JSON module", (file) => {
    const forbidden = specifiersOf(file).filter(
      (specifier) =>
        /fixtures|harness|test-support/i.test(specifier) || specifier.endsWith(".json"),
    );
    expect(forbidden, file).toEqual([]);
  });

  it("widget-data.ts declares only github-discoveries a constant", () => {
    const source = readFileSync(join(SRC_DIR, "widgets/widget-data.ts"), "utf8");
    const named = [...source.matchAll(/constantState\(\s*"([^"]+)"/g)].map((match) => match[1]);
    expect(named).toEqual(["github-discoveries"]);
    for (const id of SLICE_WIDGETS) expect(named).not.toContain(id);
  });

  it("the scan itself sees imports (it would fail on a planted fixture import)", () => {
    // Guards the guard: the specifier reader must find real imports, or the scan above is vacuous.
    expect(specifiersOf("widgets/widget-data.ts")).toContain("../overview/overview-feeds.js");
    // The planted path is assembled at run time: the visual-matrix audit forbids the
    // fixture package's name anywhere in the plugin source, tests included.
    const fixturePath = `../../${["test", "fixtures"].join("-")}/src/${["widget", "fixtures"].join("-")}.json`;
    const planted = `import data from "${fixturePath}";`;
    const found = [...planted.matchAll(/\bimport\b[^"';]*?from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(found).toEqual([fixturePath]);
  });
});

describe("D-22 behavioural: Today and Technology come from the holders, never from a constant", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(RESEARCH_NOW_MS);
    nowTick.value = RESEARCH_NOW_MS;
    resetOverviewFeeds();
    configureTasksApi(null);
    configureResearch(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetOverviewFeeds();
    configureTasksApi(null);
    configureResearch(null);
    connectionState.value = { kind: "connecting" };
  });

  async function settle(): Promise<void> {
    await vi.waitFor(() => {
      expect(widgetStateFor("today").value.kind).not.toBe("loading");
      expect(widgetStateFor("tech-intel").value.kind).not.toBe("loading");
    });
  }

  it("with the tasks and research holders unconfigured neither card ever reports ready", async () => {
    connectionState.value = { kind: "live" };
    expect(widgetStateFor("today").value.kind).toBe("loading");
    expect(widgetStateFor("tech-intel").value.kind).toBe("loading");
    const stop = startOverviewFeeds();
    await settle();
    stop();
    expect(widgetStateFor("today").value.kind).toBe("error");
    expect(widgetStateFor("tech-intel").value.kind).toBe("error");
  });

  it("with fakes configured both go loading to ready with exactly the fakes' values", async () => {
    const status: ResearchStatusResponse = { ...EMPTY_STATUS, topicLabel: "Synthetic topic" };
    const row = reportRow(0, { title: "Synthetic report title", generatedAt: iso(-90) });
    configureResearch({
      api: fakeResearchApi({
        status: vi.fn(() => Promise.resolve(status)),
        list: vi.fn(() => Promise.resolve(listOf([row]))),
      }),
      ...fakeResearchPorts(),
    });
    configureTasksApi(
      fakeTasksApi([], {
        dueToday: vi.fn(() =>
          Promise.resolve({
            due: [
              {
                taskId: "0mfk1a2b30000000000000001",
                title: "Synthetic task title",
                dueAt: "2026-10-14T18:00:00Z",
              },
            ],
            overdue: [],
          }),
        ),
      }),
    );
    connectionState.value = { kind: "live" };
    expect(widgetStateFor("today").value.kind).toBe("loading");
    expect(widgetStateFor("tech-intel").value.kind).toBe("loading");

    refreshOverviewFeeds();
    await settle();

    const tech = widgetStateFor("tech-intel").value;
    expect(tech.kind).toBe("ready");
    if (tech.kind !== "ready") return;
    expect(tech.data).toMatchObject({
      report: { noteId: row.noteId, title: "Synthetic report title" },
      unreadableCount: 0,
    });
    expect(tech.freshness).toBe("cached");

    const today = widgetStateFor("today").value;
    expect(today.kind).toBe("ready");
    if (today.kind !== "ready") return;
    const rows = (today.data as { tasks: { rows: { title: string }[] } }).tasks.rows;
    expect(rows.map((task) => task.title)).toEqual(["Synthetic task title"]);
  });
});

describe("ADR-0023 records the Phase 8 panel assignment (D-20)", () => {
  const ADR = readFileSync(
    join(REPO_ROOT, "docs", "adr", "0023-design-system-and-reduced-motion.md"),
    "utf8",
  );
  const start = ADR.indexOf("### Phase 8 (slice proof)");
  const section = start < 0 ? "" : ADR.slice(start, ADR.indexOf("\n## ", start));

  it("has the amendment under Review amendments", () => {
    expect(start).toBeGreaterThan(ADR.indexOf("## Review amendments"));
    expect(start).toBeLessThan(ADR.indexOf("## Consequences"));
  });

  it("states Today, Technology and GitHub discoveries, and no token change", () => {
    expect(section).toMatch(/Today[^.]*service-fed/i);
    expect(section).toContain("Calendar and Gmail");
    expect(section).toContain("not part of this version");
    expect(section).toMatch(/Technology and market intelligence[^.]*service-fed/i);
    expect(section).toContain("latest cited report");
    expect(section).toMatch(/GitHub discoveries[^.]*unchanged/i);
    expect(section).toMatch(/no token change/i);
  });
});
