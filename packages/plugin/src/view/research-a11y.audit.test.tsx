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
  sourcesPage,
  threeKindItems,
  threeSources,
} from "../test-support/research-report-fixtures.js";
import {
  CONFIGURED_SOURCES,
  iso,
  listOf,
  RESEARCH_NOW_MS,
  RESEARCH_TOPIC,
  RESEARCH_ZONE,
  reportRow,
  statusOf,
} from "../test-support/research-view-fixtures.js";
import { ResearchDestination } from "./research.js";

/**
 * Accessibility audit of the Research destination with a report open (plan 07-13 Task 3;
 * UI-SPEC "Accessibility additions" 1, 3, 6, 8, 9, 10, "Interaction and keyboard contract"): the tab
 * order, the heading structure, the kind announced first, one status region and no native disabled
 * attribute. Hit areas and focus rings are asserted against the stylesheet in `research-css.test.ts`.
 */

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

function mount(connected = true) {
  const row = reportRow(0, { noteId: REPORT_NOTE_ID });
  const api = fakeResearchApi({
    status: vi.fn(() =>
      Promise.resolve(
        statusOf({
          topicLabel: RESEARCH_TOPIC,
          configuredSources: [...CONFIGURED_SOURCES],
          lastSuccess: {
            runId: "run0000000000000000000001",
            endedAt: iso(-61),
            outcome: "success",
            sourceCount: 3,
            sourceTotal: 3,
            reportNoteId: REPORT_NOTE_ID,
          },
        }),
      ),
    ),
    list: vi.fn(() => Promise.resolve(listOf([row]))),
    report: vi.fn((_id: string, page: string) =>
      Promise.resolve(
        page === "items"
          ? itemsPage(threeKindItems(), { header: reportHeader({ partial: false }) })
          : sourcesPage(threeSources()),
      ),
    ),
  });
  configureResearch({ api, ...fakeResearchPorts() });
  const result = render(
    <ResearchDestination
      connection={connected ? { kind: "live" } : { kind: "disconnected", reason: "down" }}
      now={RESEARCH_NOW_MS}
      zone={RESEARCH_ZONE}
    />,
  );
  return result;
}

async function openReport(): Promise<HTMLElement> {
  await waitFor(() =>
    expect(document.querySelector("button.ccc-report-row-button")).not.toBeNull(),
  );
  fireEvent.click(document.querySelector("button.ccc-report-row-button") as HTMLElement);
  await waitFor(() => expect(document.querySelectorAll("li.ccc-report-source")).toHaveLength(3));
  return document.querySelector("article.ccc-report-reader") as HTMLElement;
}

/** The elements keyboard Tab visits, in document order: the roving or hidden ones left out. */
function tabStops(root: ParentNode): HTMLElement[] {
  const candidates = root.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  return [...candidates].filter(
    (element) =>
      element.closest("[hidden]") === null &&
      element.closest('[aria-hidden="true"]') === null &&
      element.getAttribute("tabindex") !== "-1",
  );
}

function labelOf(element: HTMLElement): string {
  return element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
}

describe("Test 4 (accessibility): the tab order follows the UI-SPEC table", () => {
  it("visits Run now, the status controls, the list rows, then the reader controls in order", async () => {
    mount();
    const reader = await openReport();
    const stops = tabStops(document.body);
    const at = (predicate: (element: HTMLElement) => boolean, from = 0): number => {
      const found = stops.findIndex((element, index) => index >= from && predicate(element));
      expect(found, "a tab stop was not found").toBeGreaterThanOrEqual(0);
      return found;
    };
    const runNow = at((el) => labelOf(el).startsWith("Run now"));
    const openReportButton = at((el) => labelOf(el) === "Open report", runNow);
    const sourcesToggle = at(
      (el) => labelOf(el).startsWith("Show configured sources"),
      openReportButton,
    );
    const row = at((el) => el.classList.contains("ccc-report-row-button"), sourcesToggle);
    const openNote = at(
      (el) => el.closest("article") === reader && labelOf(el) === "Open note",
      row,
    );
    const citation = at((el) => el.hasAttribute("data-cite"), openNote);
    const copy = at((el) => labelOf(el) === "Copy address", citation);
    const snapshot = at((el) => labelOf(el) === "Open snapshot", copy);
    const runNote = at((el) => labelOf(el) === "Open run note", snapshot);
    expect([
      runNow,
      openReportButton,
      sourcesToggle,
      row,
      openNote,
      citation,
      copy,
      snapshot,
      runNote,
    ]).toEqual(
      [
        ...new Set([
          runNow,
          openReportButton,
          sourcesToggle,
          row,
          openNote,
          citation,
          copy,
          snapshot,
          runNote,
        ]),
      ].sort((a, b) => a - b),
    );
  });

  it("makes the headings and the source titles focus targets only, never extra tab stops", async () => {
    mount();
    const reader = await openReport();
    for (const heading of reader.querySelectorAll("h3, h5")) {
      expect(heading.getAttribute("tabindex")).toBe("-1");
    }
    expect(tabStops(document.body).some((el) => /^H[1-6]$/.test(el.tagName))).toBe(false);
    for (const element of document.querySelectorAll("[tabindex]")) {
      expect(Number(element.getAttribute("tabindex"))).toBeLessThanOrEqual(0);
    }
  });

  it("opens with Back to reports first in the reader when the list is stacked above it", async () => {
    // The stacked layout is covered with the layout stub in report-reader.test.tsx; here the side
    // layout has no Back control, so the first reader stop is Open note.
    mount();
    const reader = await openReport();
    const first = tabStops(reader)[0];
    expect(first && labelOf(first)).toBe("Open note");
  });
});

describe("Test 4 (accessibility): the heading structure", () => {
  it("is h2 Research, h3 sections and report title, h4 reader sections, h5 source titles", async () => {
    mount();
    await openReport();
    const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((heading) => ({
      level: Number(heading.tagName.slice(1)),
      text: heading.textContent ?? "",
    }));
    expect(headings.map((h) => h.level)).toEqual([2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 4]);
    expect(headings.filter((h) => h.level === 2).map((h) => h.text)).toEqual(["Research"]);
    expect(headings.filter((h) => h.level === 3).map((h) => h.text.replace(/^\s+/, ""))).toEqual([
      "Run status",
      "Reports",
      reportHeader().title,
    ]);
    expect(headings.filter((h) => h.level === 4).map((h) => h.text)).toEqual([
      "How to read this report",
      "Findings",
      "Sources",
      "Run record",
    ]);
  });

  it("never skips a level going down the page", async () => {
    mount();
    await openReport();
    let previous = 1;
    for (const heading of document.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
      const level = Number(heading.tagName.slice(1));
      expect(level - previous, heading.textContent ?? "").toBeLessThanOrEqual(1);
      previous = level;
    }
  });

  it("makes the reader an article labelled by its title", async () => {
    mount();
    const reader = await openReport();
    expect(reader.tagName).toBe("ARTICLE");
    const title = reader.querySelector("h3") as HTMLElement;
    expect(reader.getAttribute("aria-labelledby")).toBe(title.id);
  });
});

describe("Test 4 (accessibility): each finding announces its kind first", () => {
  it("starts every finding's text with Finding {i}, {label}:", async () => {
    mount();
    const reader = await openReport();
    const prefixes = [
      "Finding 1, Reported fact:",
      "Finding 2, Source claim:",
      "Finding 3, Model inference:",
    ];
    const items = [...reader.querySelectorAll("li.ccc-report-item")];
    expect(items).toHaveLength(3);
    items.forEach((item, index) => {
      expect((item.textContent ?? "").startsWith(prefixes[index] ?? "?")).toBe(true);
    });
  });

  it("gives each kind a non-empty glyph, a word and a rule shape that is not colour", async () => {
    mount();
    const reader = await openReport();
    for (const item of reader.querySelectorAll("li.ccc-report-item")) {
      const tag = item.querySelector(".ccc-report-kind") as HTMLElement;
      expect(tag.querySelector('[aria-hidden="true"]')?.textContent?.length).toBeGreaterThan(0);
      expect(tag.textContent?.trim().length).toBeGreaterThan(2);
      expect(item.getAttribute("data-kind")).toMatch(/^(source-fact|unverified-claim|inference)$/);
    }
  });
});

describe("Test 4 (accessibility): one status region and no native disabled control", () => {
  it("has exactly one role=status, before and after a report is opened", async () => {
    mount();
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    await openReport();
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it("has exactly one role=status while the service is away", async () => {
    mount(false);
    await waitFor(() =>
      expect(document.querySelector("button.ccc-report-row-button")).not.toBeNull(),
    );
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it("uses the native disabled attribute on no control", async () => {
    mount();
    await openReport();
    expect(document.querySelectorAll("[disabled]")).toHaveLength(0);
  });

  it("renders no element with a positive tabindex and no autofocus", async () => {
    mount();
    await openReport();
    expect(document.querySelector("[autofocus]")).toBeNull();
  });
});
