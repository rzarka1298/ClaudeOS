import type { ResearchReportItemsPage } from "@ccc/domain/research-routes.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
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
  threeKindItems,
  threeSources,
} from "../test-support/research-report-fixtures.js";
import {
  id25,
  listOf,
  RESEARCH_NOW_MS,
  RESEARCH_ZONE,
  reportRow,
} from "../test-support/research-view-fixtures.js";
import { ResearchDestination } from "./research.js";

/**
 * The report reader through the Research destination (plan 07-13 Task 1, the tracer; UI-SPEC R4):
 * opening a report requests its header and first findings page, then the rest of the findings and
 * the sources automatically, and a citation jumps to its source and back.
 */

const scrollIntoView = vi.fn();

beforeEach(() => {
  resetResearchState();
  resetReaderState();
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView =
    scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
});

afterEach(() => {
  cleanup();
  configureResearch(null);
  resetReaderState();
  resetResearchState();
});

function article(): HTMLElement {
  const found = document.querySelector<HTMLElement>("article.ccc-report-reader");
  if (found === null) throw new Error("no reader article");
  return found;
}

function mountWith(
  report: ReturnType<typeof fakeResearchApi>["report"],
  rows = [reportRow(0, { noteId: REPORT_NOTE_ID })],
) {
  const api = fakeResearchApi({ list: vi.fn(() => Promise.resolve(listOf(rows))), report });
  const ports = fakeResearchPorts();
  configureResearch({ api, ...ports });
  render(
    <ResearchDestination
      connection={{ kind: "live" }}
      now={RESEARCH_NOW_MS}
      zone={RESEARCH_ZONE}
    />,
  );
  return { api, ports };
}

async function openRow(index = 0): Promise<void> {
  await waitFor(() =>
    expect(document.querySelectorAll("button.ccc-report-row-button").length).toBeGreaterThan(index),
  );
  const buttons = document.querySelectorAll<HTMLElement>("button.ccc-report-row-button");
  fireEvent.click(buttons[index] as HTMLElement);
}

function tracerReport() {
  return vi.fn((_noteId: string, page: string) =>
    Promise.resolve(page === "items" ? itemsPage(threeKindItems()) : sourcesPage(threeSources())),
  );
}

describe("Test 1 (tracer): opening a report renders its labelled findings, then its sources", () => {
  it("requests the items page, renders the title, the meta line and the three labelled kinds", async () => {
    const report = tracerReport();
    const { api } = mountWith(report as never);
    await openRow();
    await screen.findByRole("heading", { level: 3, name: /Developer tooling/ });
    expect(api.report).toHaveBeenNthCalledWith(1, REPORT_NOTE_ID, "items", undefined);

    const root = article();
    expect(root.getAttribute("aria-labelledby")).not.toBeNull();
    const title = root.querySelector("h3");
    expect(root.getAttribute("aria-labelledby")).toBe(title?.id);

    const tags = [...root.querySelectorAll(".ccc-report-kind")].map((tag) => tag.textContent);
    expect(tags).toEqual(["≡ Reported fact", "“ Source claim", "∴ Model inference"]);
    expect(root.querySelectorAll("li.ccc-report-item")).toHaveLength(3);
    expect(root.querySelector("li.ccc-report-item[data-kind='source-fact']")).not.toBeNull();
    expect(root.querySelector("li.ccc-report-item[data-kind='unverified-claim']")).not.toBeNull();
    expect(root.querySelector("li.ccc-report-item[data-kind='inference']")).not.toBeNull();
    expect(root.textContent).toContain("Generated");
  });

  it("shows the quote under its caption and the citation buttons with the source number and title", async () => {
    mountWith(tracerReport() as never);
    await openRow();
    await screen.findByRole("heading", { level: 3, name: /Developer tooling/ });
    const root = article();
    const first = root.querySelector("li.ccc-report-item") as HTMLElement;
    expect(within(first).getByText("Quoted from source 2")).toBeTruthy();
    expect(first.querySelector("blockquote")?.textContent).toBe("fixes a stream reset in http2");
    const cite = within(first).getByRole("button", { name: "Source 2: Sample runtime releases" });
    expect(cite.textContent).toBe("[2] Sample runtime releases");
    const second = root.querySelectorAll("li.ccc-report-item")[1] as HTMLElement;
    expect(
      within(second)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["[1] Example tools changelog", "[3] Demo language blog"]);
    const third = root.querySelectorAll("li.ccc-report-item")[2] as HTMLElement;
    expect(within(third).getByText("No source cited")).toBeTruthy();
    expect(third.querySelector("button")).toBeNull();
  });

  it("starts each finding with the hidden prefix that names its kind", async () => {
    mountWith(tracerReport() as never);
    await openRow();
    await screen.findByRole("heading", { level: 3, name: /Developer tooling/ });
    const prefixes = [...article().querySelectorAll("li.ccc-report-item")].map(
      (li) => li.querySelector(".ccc-visually-hidden")?.textContent,
    );
    expect(prefixes).toEqual([
      "Finding 1, Reported fact:",
      "Finding 2, Source claim:",
      "Finding 3, Model inference:",
    ]);
  });

  it("then requests the sources page automatically and renders numbered entries", async () => {
    const { api } = mountWith(tracerReport() as never);
    await openRow();
    await waitFor(() =>
      expect(api.report).toHaveBeenNthCalledWith(2, REPORT_NOTE_ID, "sources", undefined),
    );
    await waitFor(() => expect(article().querySelectorAll("li.ccc-report-source")).toHaveLength(3));
    const headings = [...article().querySelectorAll("h5")].map((h5) => h5.textContent);
    expect(headings).toEqual([
      "1. Example tools changelog",
      "2. Sample runtime releases",
      "3. Demo language blog",
    ]);
  });

  it("moves focus to the title once it renders", async () => {
    mountWith(tracerReport() as never);
    await openRow();
    const title = await screen.findByRole("heading", { level: 3, name: /Developer tooling/ });
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(title.getAttribute("tabindex")).toBe("-1");
  });
});

describe("Test 2 (paging): findings pages in order, then sources; no Show more inside the article", () => {
  it("loads three items pages for 25 findings before the sources page", async () => {
    const all = Array.from({ length: 25 }, (_, i) => reportItem(i + 1));
    const header = reportHeader({
      kindCounts: { "source-fact": 25, "unverified-claim": 0, inference: 0 },
    });
    const report = vi.fn((_id: string, page: string, cursor?: string) => {
      if (page === "sources") return Promise.resolve(sourcesPage(threeSources()));
      if (cursor === undefined)
        return Promise.resolve(itemsPage(all.slice(0, 10), { header, nextCursor: "c1" }));
      if (cursor === "c1")
        return Promise.resolve(itemsPage(all.slice(10, 20), { header, nextCursor: "c2" }));
      return Promise.resolve(itemsPage(all.slice(20), { header }));
    });
    const { api } = mountWith(report as never);
    await openRow();
    await waitFor(() => expect(article().querySelectorAll("li.ccc-report-source")).toHaveLength(3));
    expect(api.report.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ["items", undefined],
      ["items", "c1"],
      ["items", "c2"],
      ["sources", undefined],
    ]);
    expect(article().querySelectorAll("li.ccc-report-item")).toHaveLength(25);
    for (const button of article().querySelectorAll("button")) {
      expect(button.textContent ?? "").not.toMatch(/show (more|\d+ more)/i);
    }
  });

  it("ends the findings with the shortened-page line when the service trimmed a page", async () => {
    const report = vi.fn((_id: string, page: string) =>
      Promise.resolve(
        page === "items"
          ? itemsPage([reportItem(1), reportItem(2)], { truncated: true })
          : sourcesPage(threeSources()),
      ),
    );
    mountWith(report as never);
    await openRow();
    await waitFor(() => expect(article().querySelectorAll("li.ccc-report-source")).toHaveLength(3));
    expect(article().textContent).toContain(
      "Some items were too long to show here. Open the note to read them in full.",
    );
  });
});

describe("Test 3 (citation focus): a citation moves focus to its source and back", () => {
  it("focuses the cited source's heading without smooth scrolling, then returns focus to the citation", async () => {
    mountWith(tracerReport() as never);
    await openRow();
    await waitFor(() => expect(article().querySelectorAll("li.ccc-report-source")).toHaveLength(3));
    const first = article().querySelector("li.ccc-report-item") as HTMLElement;
    const cite = within(first).getByRole("button", { name: "Source 2: Sample runtime releases" });
    fireEvent.click(cite);

    const target = article().querySelectorAll("li.ccc-report-source h5")[1] as HTMLElement;
    expect(document.activeElement).toBe(target);
    expect(target.getAttribute("tabindex")).toBe("-1");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });

    const entry = target.closest("li") as HTMLElement;
    const back = within(entry).getByRole("button", { name: "Back to finding 1" });
    expect(article().querySelectorAll("button[data-back-to-finding]")).toHaveLength(1);
    fireEvent.click(back);
    expect(document.activeElement).toBe(cite);
  });

  it("offers Back to finding only on the entry that was jumped to", async () => {
    mountWith(tracerReport() as never);
    await openRow();
    await waitFor(() => expect(article().querySelectorAll("li.ccc-report-source")).toHaveLength(3));
    expect(screen.queryByRole("button", { name: /^Back to finding/ })).toBeNull();
  });
});

describe("Test 4 (cancellation): selecting another report ignores the first one's late answers", () => {
  it("shows only the second report when the first answers late", async () => {
    const other = id25("report2");
    let releaseFirst: (page: ResearchReportItemsPage) => void = () => undefined;
    const report = vi.fn((noteId: string, page: string) => {
      if (noteId === REPORT_NOTE_ID && page === "items") {
        return new Promise<ResearchReportItemsPage>((resolve) => {
          releaseFirst = resolve;
        });
      }
      if (page === "items") {
        return Promise.resolve(
          itemsPage([reportItem(1, { text: "Second report finding." })], {
            header: reportHeader({ noteId: other, title: "Second report title" }),
          }),
        );
      }
      return Promise.resolve(sourcesPage([reportSource(1)]));
    });
    const rows = [reportRow(0, { noteId: REPORT_NOTE_ID }), reportRow(1, { noteId: other })];
    mountWith(report as never, rows);
    await openRow(0);
    await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    await openRow(1);
    await screen.findByRole("heading", { level: 3, name: "Second report title" });
    await act(async () => {
      releaseFirst(
        itemsPage([reportItem(1, { text: "First report finding." })], {
          header: reportHeader({ title: "First report title" }),
        }),
      );
      await Promise.resolve();
    });
    expect(article().textContent).toContain("Second report finding.");
    expect(article().textContent).not.toContain("First report finding.");
    expect(screen.queryByText("First report title")).toBeNull();
  });
});
