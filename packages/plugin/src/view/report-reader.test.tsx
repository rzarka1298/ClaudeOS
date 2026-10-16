import type {
  ResearchReportItemsPage,
  ResearchReportResponse,
} from "@ccc/domain/research-routes.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureResearch, ResearchApiError } from "../research/api.js";
import { resetReaderState } from "../research/reader-state.js";
import { refreshList, resetResearchState } from "../research/state.js";
import { fakeResearchApi, fakeResearchPorts } from "../test-support/research-api-fake.js";
import {
  itemsPage,
  partialHeader,
  REPORT_NOTE_ID,
  REPORT_RUN_ID,
  REPORT_RUN_NOTE_PATH,
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

// ---------------------------------------------------------------------------
// Task 2: the header, the partial notice, the run record and every reader state

type Ports = ReturnType<typeof fakeResearchPorts>;

function mountFull(options: {
  report: (noteId: string, page: string, cursor?: string) => Promise<ResearchReportResponse>;
  rows?: ReturnType<typeof reportRow>[];
  list?: () => Promise<ReturnType<typeof listOf>>;
  ports?: Partial<Ports>;
  connected?: boolean;
}) {
  const rows = options.rows ?? [reportRow(0, { noteId: REPORT_NOTE_ID })];
  const api = fakeResearchApi({
    list: vi.fn(options.list ?? (() => Promise.resolve(listOf(rows)))),
    report: vi.fn(options.report),
  });
  const ports = fakeResearchPorts(options.ports);
  configureResearch({ api, ...ports });
  const element = (connected: boolean) => (
    <ResearchDestination
      connection={connected ? { kind: "live" } : { kind: "disconnected", reason: "down" }}
      now={RESEARCH_NOW_MS}
      zone={RESEARCH_ZONE}
    />
  );
  const result = render(element(options.connected !== false));
  return { api, ports, ...result, setConnected: (c: boolean) => result.rerender(element(c)) };
}

function pages(
  header = reportHeader(),
  items = threeKindItems(),
  sources = threeSources(),
): (noteId: string, page: string) => Promise<ResearchReportResponse> {
  return (_noteId, page) =>
    Promise.resolve(page === "items" ? itemsPage(items, { header }) : sourcesPage(sources));
}

function statusLine(): string {
  return document.querySelector('.ccc-research-status[role="status"]')?.textContent ?? "";
}

async function openAndWait(): Promise<void> {
  await openRow();
  await waitFor(() => expect(article().querySelectorAll("li.ccc-report-source")).toHaveLength(3));
}

describe("Task 2 Test 3 (header): the meta line, kind counts, the AI line and the stale line", () => {
  it("shows Generated with the absolute and relative time, the freshness badge and the counts", async () => {
    mountFull({ report: pages(reportHeader({ sourceCount: 3, sourceTotal: 3 })) });
    await openAndWait();
    const meta = article().querySelector(".ccc-report-meta") as HTMLElement;
    expect(meta.textContent).toContain("Generated Oct 14, 11:00 AM (1 hour ago)");
    expect(meta.querySelector('.ccc-badge[data-badge="cached"]')?.textContent).toContain("Cached");
    expect(meta.textContent).toContain("3 of 3 sources");
    expect(meta.textContent).toContain("3 items");
    expect(meta.querySelector('.ccc-badge[data-badge="partial"]')).toBeNull();
  });

  it("shows the Partial badge on a partial report", async () => {
    mountFull({ report: pages(partialHeader()) });
    await openAndWait();
    const meta = article().querySelector(".ccc-report-meta") as HTMLElement;
    expect(meta.querySelector('.ccc-badge[data-badge="partial"]')?.textContent).toContain(
      "Partial",
    );
    expect(meta.textContent).toContain("4 of 6 sources");
  });

  it("keeps zero segments in the kind counts and pluralises the rest", async () => {
    mountFull({
      report: pages(
        reportHeader({ kindCounts: { "source-fact": 1, "unverified-claim": 2, inference: 0 } }),
      ),
    });
    await openAndWait();
    expect(article().querySelector(".ccc-report-counts")?.textContent).toBe(
      "1 reported fact · 2 source claims · 0 model inferences",
    );
  });

  it("names the model id in mono on the AI line", async () => {
    mountFull({ report: pages(reportHeader({ summariser: "claude-haiku-5-5" })) });
    await openAndWait();
    const line = article().querySelector(".ccc-report-ai") as HTMLElement;
    expect(line.textContent).toBe(
      "AI-generated summary by claude-haiku-5-5. Not verified by a person.",
    );
    expect(line.querySelector(".ccc-mono")?.textContent).toBe("claude-haiku-5-5");
  });

  it("says the extractive summariser has no model", async () => {
    mountFull({ report: pages(reportHeader({ summariser: "extractive" })) });
    await openAndWait();
    expect(article().querySelector(".ccc-report-ai")?.textContent).toBe(
      "AI-generated summary by the extractive summariser (no model). Not verified by a person.",
    );
  });

  it("adds the stale line with the hours from the shared constant on a stale report", async () => {
    const stale = reportHeader({
      generatedAt: new Date(RESEARCH_NOW_MS - 40 * 3600_000).toISOString(),
    });
    mountFull({ report: pages(stale) });
    await openAndWait();
    expect(article().querySelector('.ccc-badge[data-badge="stale"]')).not.toBeNull();
    expect(article().textContent).toContain(
      "This report is more than 36 hours old. Press Run now for a fresh one.",
    );
  });

  it("has no stale line on a fresh report", async () => {
    mountFull({ report: pages() });
    await openAndWait();
    expect(article().textContent).not.toContain("hours old");
  });

  it("offers Open note for the report note", async () => {
    const { ports } = mountFull({ report: pages() });
    await openAndWait();
    fireEvent.click(within(article()).getByRole("button", { name: "Open note" }));
    expect(ports.openNote).toHaveBeenCalledWith(reportHeader().notePath);
  });
});

describe("Task 2 Test 4 (partial notice): the unavailable sources, before the findings", () => {
  it("shows the banner with the pluralised intro and one line per source with its reason", async () => {
    mountFull({ report: pages(partialHeader()) });
    await openAndWait();
    const banner = article().querySelector(".ccc-banner") as HTMLElement;
    expect(
      within(banner).getByRole("heading", { level: 4, name: "Unavailable sources" }),
    ).toBeTruthy();
    expect(banner.textContent).toContain(
      "◈ Partial — 2 of 6 sources were unavailable, so this report covers only the rest.",
    );
    expect([...banner.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "✕ Demo build tool releases — Didn't respond in time",
      "✕ Sample package registry — The site returned an error",
    ]);
  });

  it("is shown before the findings", async () => {
    mountFull({ report: pages(partialHeader()) });
    await openAndWait();
    const banner = article().querySelector(".ccc-banner") as HTMLElement;
    const findings = article().querySelector("ol.ccc-report-items") as HTMLElement;
    expect(
      banner.compareDocumentPosition(findings) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("uses the singular for one unavailable source and still lists its reason", async () => {
    mountFull({
      report: pages(
        reportHeader({
          partial: true,
          sourceCount: 2,
          sourceTotal: 3,
          unavailableSources: [{ label: "Demo build tool releases", code: "dns-failure" }],
        }),
      ),
    });
    await openAndWait();
    const banner = article().querySelector(".ccc-banner") as HTMLElement;
    expect(banner.textContent).toContain("1 of 3 sources was unavailable");
    expect(banner.querySelectorAll("li")).toHaveLength(1);
    expect(banner.textContent).toContain("Address not found");
  });

  it("is absent when the report is not partial", async () => {
    mountFull({ report: pages() });
    await openAndWait();
    expect(article().querySelector(".ccc-banner")).toBeNull();
    expect(screen.queryByText("Unavailable sources")).toBeNull();
  });

  it("caps a label at 80 characters and says the text was shortened", async () => {
    const label = "L".repeat(200);
    mountFull({
      report: pages(
        reportHeader({
          partial: true,
          sourceCount: 2,
          sourceTotal: 3,
          unavailableSources: [{ label, code: "timeout" }],
        }),
      ),
    });
    await openAndWait();
    const line = article().querySelector(".ccc-banner li") as HTMLElement;
    expect(line.textContent).toContain("L".repeat(80));
    expect(line.textContent).not.toContain("L".repeat(81));
    expect(line.textContent).toContain("Text shortened for display.");
  });
});

describe("Task 2 Test 5 (run record)", () => {
  it("lists Run, Started, Finished, Outcome and Summariser with Open run note", async () => {
    const { ports } = mountFull({
      report: pages(reportHeader({ summariser: "claude-haiku-5-5" })),
    });
    await openAndWait();
    const run = article().querySelector(".ccc-report-run") as HTMLElement;
    expect(within(run).getByRole("heading", { level: 4, name: "Run record" })).toBeTruthy();
    expect([...run.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual([
      "Run",
      "Started",
      "Finished",
      "Outcome",
      "Summariser",
    ]);
    const dds = [...run.querySelectorAll("dd")];
    expect(dds[0]?.querySelector(".ccc-mono")?.textContent).toBe(REPORT_RUN_ID);
    expect(dds[1]?.textContent).toBe("Oct 14, 10:58 AM");
    expect(dds[2]?.textContent).toBe("Oct 14, 10:59 AM");
    expect(dds[3]?.textContent).toContain("✓ Completed");
    expect(dds[3]?.textContent).not.toContain("Partial");
    expect(dds[4]?.querySelector(".ccc-mono")?.textContent).toBe("claude-haiku-5-5");
    fireEvent.click(within(run).getByRole("button", { name: "Open run note" }));
    expect(ports.openNote).toHaveBeenCalledWith(REPORT_RUN_NOTE_PATH);
  });

  it("shows the Partial badge beside Completed on a partial run", async () => {
    mountFull({ report: pages(partialHeader()) });
    await openAndWait();
    const outcome = [...article().querySelectorAll(".ccc-report-run dd")][3] as HTMLElement;
    expect(outcome.textContent).toContain("✓ Completed");
    expect(outcome.querySelector('.ccc-badge[data-badge="partial"]')).not.toBeNull();
  });

  it("shows Failed as recorded", async () => {
    mountFull({ report: pages(reportHeader({ runOutcome: "failure" })) });
    await openAndWait();
    const outcome = [...article().querySelectorAll(".ccc-report-run dd")][3] as HTMLElement;
    expect(outcome.textContent).toContain("✕ Failed");
  });

  it("hides Open run note, and keeps the rest, when the run note is missing", async () => {
    mountFull({ report: pages(reportHeader({ runNotePath: null })) });
    await openAndWait();
    const run = article().querySelector(".ccc-report-run") as HTMLElement;
    expect(within(run).queryByRole("button", { name: "Open run note" })).toBeNull();
    expect(run.querySelectorAll("dt")).toHaveLength(5);
  });

  it("says Not recorded for a run time the store no longer has", async () => {
    mountFull({
      report: pages(
        reportHeader({ runStartedAt: null, runEndedAt: null, runOutcome: null, runNotePath: null }),
      ),
    });
    await openAndWait();
    const dds = [...article().querySelectorAll(".ccc-report-run dd")];
    expect(dds[1]?.textContent).toBe("Not recorded");
    expect(dds[2]?.textContent).toBe("Not recorded");
    expect(dds[3]?.textContent).toBe("Not recorded");
  });

  it("posts Couldn't open the run note. in the status line when the open fails", async () => {
    mountFull({ report: pages(), ports: { openNote: vi.fn(() => false) } });
    await openAndWait();
    fireEvent.click(within(article()).getByRole("button", { name: "Open run note" }));
    await waitFor(() => expect(statusLine()).toBe("Couldn't open the run note."));
  });
});

describe("Task 2 Test 2 (copy and open): host ports and the status line", () => {
  it("Copy address writes the address and says so", async () => {
    const { ports } = mountFull({ report: pages() });
    await openAndWait();
    const first = article().querySelector("li.ccc-report-source") as HTMLElement;
    fireEvent.click(within(first).getByRole("button", { name: "Copy address" }));
    expect(ports.copyText).toHaveBeenCalledWith("https://changelog.example.invalid/feed/1");
    await waitFor(() => expect(statusLine()).toBe("Address copied."));
  });

  it("says Couldn't copy the address. when the clipboard refuses", async () => {
    mountFull({ report: pages(), ports: { copyText: vi.fn(() => false) } });
    await openAndWait();
    const first = article().querySelector("li.ccc-report-source") as HTMLElement;
    fireEvent.click(within(first).getByRole("button", { name: "Copy address" }));
    await waitFor(() => expect(statusLine()).toBe("Couldn't copy the address."));
  });

  it("says Couldn't copy the address. when the clipboard port rejects", async () => {
    mountFull({
      report: pages(),
      ports: { copyText: vi.fn(() => Promise.reject(new Error("denied"))) },
    });
    await openAndWait();
    const first = article().querySelector("li.ccc-report-source") as HTMLElement;
    fireEvent.click(within(first).getByRole("button", { name: "Copy address" }));
    await waitFor(() => expect(statusLine()).toBe("Couldn't copy the address."));
  });

  it("Open snapshot opens the vault-relative snapshot path", async () => {
    const { ports } = mountFull({ report: pages() });
    await openAndWait();
    const first = article().querySelector("li.ccc-report-source") as HTMLElement;
    fireEvent.click(within(first).getByRole("button", { name: "Open snapshot" }));
    expect(ports.openNote).toHaveBeenCalledWith(threeSources()[0]?.snapshotPath);
  });

  it("a snapshot that will not open is said once in the status line", async () => {
    mountFull({ report: pages(), ports: { openNote: vi.fn(() => false) } });
    await openAndWait();
    const first = article().querySelector("li.ccc-report-source") as HTMLElement;
    fireEvent.click(within(first).getByRole("button", { name: "Open snapshot" }));
    await waitFor(() => expect(statusLine()).toBe("Couldn't open the note."));
  });
});

describe("Task 2 Test 6 (states): each reader state renders its fixed copy", () => {
  it("shows the nothing-selected placeholder before a report is opened", async () => {
    mountFull({ report: pages() });
    await waitFor(() =>
      expect(document.querySelector("button.ccc-report-row-button")).not.toBeNull(),
    );
    expect(screen.getByText("Select a report to read it.")).toBeTruthy();
    expect(document.querySelector("article.ccc-report-reader")).toBeNull();
  });

  it("loads with a skeleton header, three skeleton findings, aria-busy and hidden Loading report", async () => {
    mountFull({ report: () => new Promise(() => undefined) });
    await openRow();
    const root = article();
    expect(root.getAttribute("aria-busy")).toBe("true");
    expect(within(root).getByText("Loading report").className).toContain("ccc-visually-hidden");
    expect(root.querySelectorAll(".ccc-report-skeleton-item")).toHaveLength(3);
    expect(root.querySelector("h3")).toBeNull();
  });

  it("shows the error copy with Try again, which asks again", async () => {
    let fail = true;
    const { api } = mountFull({
      report: (id, page) =>
        fail ? Promise.reject(new ResearchApiError("timeout")) : pages()(id, page),
    });
    await openRow();
    await screen.findByText("Couldn't load this report.");
    expect(
      screen.getByText("Check the service in Settings → Diagnostics, then refresh."),
    ).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { level: 3, name: /Developer tooling/ });
    expect(
      api.report.mock.calls.filter((call) => call[1] === "items").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("explains a report that is gone, refreshes the list and focuses the reader heading", async () => {
    const { api } = mountFull({ report: () => Promise.reject(new ResearchApiError("not-found")) });
    await openRow();
    const heading = await screen.findByRole("heading", {
      level: 3,
      name: "That report isn't in the vault any more.",
    });
    expect(
      screen.getByText("It may have been moved or deleted. The list has been refreshed."),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(heading));
    await waitFor(() => expect(api.list.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("explains an unreadable report", async () => {
    mountFull({ report: () => Promise.reject(new ResearchApiError("unreadable-report")) });
    await openRow();
    await screen.findByRole("heading", {
      level: 3,
      name: "This report's metadata couldn't be read.",
    });
    expect(
      screen.getByText("It may have been edited by hand. Open the note to check it."),
    ).toBeTruthy();
  });

  it("says a report with no findings has none, and still renders the sources and the run record", async () => {
    mountFull({
      report: pages(
        reportHeader({ kindCounts: { "source-fact": 0, "unverified-claim": 0, inference: 0 } }),
        [],
      ),
    });
    await openAndWait();
    expect(article().textContent).toContain(
      "This report has no findings. Nothing in the summariser's answer could be kept.",
    );
    expect(article().querySelector(".ccc-report-run")).not.toBeNull();
    expect(article().querySelector("ol.ccc-report-items")).toBeNull();
  });

  it("shows a skeleton for the sources until they land", async () => {
    mountFull({
      report: (_id, page) =>
        page === "items"
          ? Promise.resolve(itemsPage(threeKindItems()))
          : new Promise(() => undefined),
    });
    await openRow();
    await screen.findByRole("heading", { level: 3, name: /Developer tooling/ });
    const sources = article().querySelector(".ccc-report-sources-section") as HTMLElement;
    expect(sources.querySelector(".ccc-skeleton-line")).not.toBeNull();
    expect(article().getAttribute("aria-busy")).toBeNull();
  });

  it("keeps the findings and offers to load the rest when a later page fails", async () => {
    let failSources = true;
    const { api } = mountFull({
      report: (id, page) =>
        page === "sources" && failSources
          ? Promise.reject(new ResearchApiError("timeout"))
          : pages()(id, page),
    });
    await openRow();
    await screen.findByText("Couldn't load the rest of this report.");
    expect(article().querySelectorAll("li.ccc-report-item")).toHaveLength(3);
    failSources = false;
    fireEvent.click(screen.getByRole("button", { name: "Load the rest of the report" }));
    await waitFor(() => expect(article().querySelectorAll("li.ccc-report-source")).toHaveLength(3));
    expect(api.report.mock.calls.filter((call) => call[1] === "items")).toHaveLength(1);
    expect(screen.queryByText("Couldn't load the rest of this report.")).toBeNull();
  });

  it("says a section that never loaded could not be loaded while the service is away", async () => {
    const { setConnected } = mountFull({
      report: (_id, page) =>
        page === "items"
          ? Promise.resolve(itemsPage(threeKindItems()))
          : new Promise(() => undefined),
    });
    await openRow();
    await screen.findByRole("heading", { level: 3, name: /Developer tooling/ });
    setConnected(false);
    await screen.findByText(
      "This section couldn't be loaded while the companion service isn't running.",
    );
    expect(article().getAttribute("data-dimmed")).toBe("true");
  });

  it("keeps vault and clipboard actions enabled while the service is away", async () => {
    const { setConnected } = mountFull({ report: pages() });
    await openAndWait();
    setConnected(false);
    for (const name of ["Open note", "Copy address", "Open snapshot", "Open run note"]) {
      for (const button of within(article()).getAllByRole("button", { name })) {
        expect(button.getAttribute("aria-disabled"), name).toBeNull();
        expect(button.hasAttribute("disabled"), name).toBe(false);
      }
    }
  });

  it("tells the owner when a citation points at a source that has not loaded", async () => {
    mountFull({
      report: (_id, page) =>
        page === "items"
          ? Promise.resolve(itemsPage(threeKindItems()))
          : new Promise(() => undefined),
    });
    await openRow();
    await screen.findByRole("heading", { level: 3, name: /Developer tooling/ });
    fireEvent.click(screen.getByRole("button", { name: "Source 2: Sample runtime releases" }));
    expect(statusLine()).toBe("That source isn't loaded yet.");
  });
});

describe("Task 2: display caps", () => {
  it("shortens a long finding, quote, source title, author and citation, each with the shortened line", async () => {
    const long = "x".repeat(5000);
    const items = [
      reportItem(1, {
        text: long,
        quote: long,
        quoteSourceNumber: 1,
        citations: [{ number: 1, title: long }],
      }),
    ];
    const sources = [reportSource(1, { title: long, author: long })];
    mountFull({
      report: (_id, page) =>
        Promise.resolve(page === "items" ? itemsPage(items) : sourcesPage(sources)),
    });
    await openRow();
    await waitFor(() => expect(article().querySelectorAll("li.ccc-report-source")).toHaveLength(1));
    const item = article().querySelector("li.ccc-report-item") as HTMLElement;
    expect(item.querySelector(".ccc-report-text")?.textContent).toBe(
      `${"x".repeat(600)} Text shortened for display.`,
    );
    expect(item.querySelector("blockquote")?.textContent).toBe(
      `${"x".repeat(240)} Text shortened for display.`,
    );
    expect(item.querySelector("button[data-cite]")?.textContent).toBe(`[1] ${"x".repeat(60)}`);
    expect(item.querySelector("button[data-cite]")?.getAttribute("title")).toBe(long);
    const entry = article().querySelector("li.ccc-report-source") as HTMLElement;
    expect(entry.querySelector("h5")?.textContent).toBe(
      `1. ${"x".repeat(200)} Text shortened for display.`,
    );
    expect(entry.textContent).toContain("x".repeat(120));
    expect(entry.textContent).not.toContain("x".repeat(121));
  });
});

describe("Task 2: the legend and the section headings", () => {
  it("explains the three kinds with the locked section headings in order", async () => {
    mountFull({ report: pages(partialHeader()) });
    await openAndWait();
    const headings = [...article().querySelectorAll("h4")].map((h) => h.textContent);
    expect(headings).toEqual([
      "Unavailable sources",
      "How to read this report",
      "Findings",
      "Sources",
      "Run record",
    ]);
    const legend = article().querySelector(".ccc-report-legend") as HTMLElement;
    expect([...legend.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual([
      "≡ Reported fact",
      "“ Source claim",
      "∴ Model inference",
    ]);
    expect([...legend.querySelectorAll("dd")].map((dd) => dd.textContent)).toEqual([
      "A source states this, and the quoted words were found in that source.",
      "A source says this. It was not checked against other sources.",
      "The summariser's own reading. No source states it directly.",
    ]);
  });

  it("ends the sources with the shortened line when the service trimmed that page", async () => {
    mountFull({
      report: (_id, page) =>
        Promise.resolve(
          page === "items"
            ? itemsPage(threeKindItems())
            : sourcesPage(threeSources(), { truncated: true }),
        ),
    });
    await openAndWait();
    const section = article().querySelector(".ccc-report-sources-section") as HTMLElement;
    expect(section.textContent).toContain(
      "Some items were too long to show here. Open the note to read them in full.",
    );
  });
});

describe("Task 2 Test 7 (one column): Back to reports and Escape", () => {
  const widths = new Map<Element, number>();
  let observers: { callback: ResizeObserverCallback; target: Element }[] = [];

  beforeEach(() => {
    widths.clear();
    observers = [];
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return widths.get(this) ?? 0;
      },
    });
    class FakeResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        observers.push({ callback: this.callback, target });
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  });

  function setLayoutWidth(px: number): void {
    const layout = document.querySelector(".ccc-research-layout") as HTMLElement;
    widths.set(layout, px);
    act(() => {
      for (const { callback, target } of observers) {
        if (target === layout) {
          callback(
            [{ target, contentRect: { width: px } } as ResizeObserverEntry],
            {} as ResizeObserver,
          );
        }
      }
    });
  }

  it("reports the layout through a data attribute: stacked at 48rem and below, side beside it above", async () => {
    mountFull({ report: pages() });
    const layout = document.querySelector(".ccc-research-layout") as HTMLElement;
    setLayoutWidth(400);
    expect(layout.getAttribute("data-layout")).toBe("stacked");
    setLayoutWidth(900);
    expect(layout.getAttribute("data-layout")).toBe("side");
    setLayoutWidth(768);
    expect(layout.getAttribute("data-layout")).toBe("stacked");
  });

  it("puts Back to reports first in the reader when stacked, and returns focus to the originating row", async () => {
    mountFull({ report: pages() });
    setLayoutWidth(400);
    await openAndWait();
    const root = article();
    const back = within(root).getByRole("button", { name: "Back to reports" });
    expect(root.firstElementChild).toBe(back);
    expect(back.getAttribute("data-variant")).toBe("tertiary");
    fireEvent.click(back);
    expect(screen.getByText("Select a report to read it.")).toBeTruthy();
    expect(document.activeElement).toBe(document.querySelector("button.ccc-report-row-button"));
  });

  it("closes on Escape when stacked", async () => {
    mountFull({ report: pages() });
    setLayoutWidth(400);
    await openAndWait();
    fireEvent.keyDown(article(), { key: "Escape" });
    expect(screen.getByText("Select a report to read it.")).toBeTruthy();
    expect(document.activeElement).toBe(document.querySelector("button.ccc-report-row-button"));
  });

  it("has no Back to reports, and Escape does nothing, when the list sits beside the reader", async () => {
    mountFull({ report: pages() });
    setLayoutWidth(1000);
    await openAndWait();
    expect(within(article()).queryByRole("button", { name: "Back to reports" })).toBeNull();
    fireEvent.keyDown(article(), { key: "Escape" });
    expect(document.querySelector("article.ccc-report-reader")).not.toBeNull();
  });

  it("returns focus to the Reports heading when the originating row has left the list", async () => {
    let calls = 0;
    const row = reportRow(0, { noteId: REPORT_NOTE_ID });
    const { api } = mountFull({
      report: pages(),
      list: () => {
        calls += 1;
        return Promise.resolve(listOf(calls === 1 ? [row] : []));
      },
    });
    setLayoutWidth(400);
    await openAndWait();
    // The list refreshes while the reader is open, and the row is gone.
    await act(async () => {
      await refreshList();
    });
    expect(api.list).toHaveBeenCalledTimes(2);
    fireEvent.click(within(article()).getByRole("button", { name: "Back to reports" }));
    const heading = screen.getByRole("heading", { level: 3, name: "Reports" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
});
