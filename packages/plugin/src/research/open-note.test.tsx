import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostRegistry, type HostRegistry } from "../host-registry.js";
import { FakeObsidianHost } from "../test-support/fake-obsidian-host.js";
import {
  itemsPage,
  REPORT_NOTE_ID,
  REPORT_NOTE_PATH,
  reportHeader,
  reportItem,
  sourcesPage,
  threeSources,
} from "../test-support/research-report-fixtures.js";
import {
  EMPTY_STATUS,
  listOf,
  RESEARCH_NOW_MS,
  RESEARCH_ZONE,
  reportRow,
  unreadableRow,
} from "../test-support/research-view-fixtures.js";
import { ResearchDestination } from "../view/research.js";
import { ResearchApiError } from "./api.js";
import { resetReaderState } from "./reader-state.js";
import { resetResearchState } from "./state.js";
import { wireResearch } from "./wiring.js";

/**
 * The open-note affordance end to end (plan 07-15; wave 4 Codex finding 3 and the 07-14 contract
 * that the list route fills `notePath`): every Open note the Research view offers hands the host the
 * vault-relative path the service named, through the wired port, and a note that will not open is
 * said once.
 */

beforeEach(() => {
  resetResearchState();
  resetReaderState();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  resetReaderState();
  resetResearchState();
});

function setup(options: {
  rows: Parameters<typeof listOf>[0];
  report: (noteId: string, page: string) => Promise<unknown>;
  open?: (path: string) => boolean;
}) {
  const registry: HostRegistry = createHostRegistry(new FakeObsidianHost());
  const openFile = vi.fn((path: string) => options.open?.(path) ?? true);
  wireResearch(registry, {
    client: {
      run: () => Promise.reject(new Error("unused")),
      status: () => Promise.resolve(EMPTY_STATUS),
      list: () => Promise.resolve(listOf(options.rows)),
      report: (request: { noteId: string; page: string }) =>
        options.report(request.noteId, request.page),
    } as never,
    notice: vi.fn(),
    openFile,
    copyText: () => Promise.resolve(),
  });
  render(
    <ResearchDestination
      connection={{ kind: "live" }}
      now={RESEARCH_NOW_MS}
      zone={RESEARCH_ZONE}
    />,
  );
  return { registry, openFile };
}

const reportPages = (noteId: string, page: string) =>
  Promise.resolve(
    page === "items"
      ? itemsPage([reportItem(1)], { header: reportHeader({ noteId }) })
      : sourcesPage(threeSources()),
  );

describe("Open note reaches the host with the path the service named", () => {
  it("the reader's Open note opens the report note by its header path", async () => {
    const { registry, openFile } = setup({
      rows: [reportRow(0, { noteId: REPORT_NOTE_ID, notePath: REPORT_NOTE_PATH })],
      report: reportPages,
    });
    await waitFor(() =>
      expect(document.querySelectorAll("button.ccc-report-row-button").length).toBe(1),
    );
    fireEvent.click(document.querySelector("button.ccc-report-row-button") as HTMLElement);
    const reader = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("article.ccc-report-reader");
      if (found === null) throw new Error("no reader yet");
      return found;
    });
    fireEvent.click(await within(reader).findByRole("button", { name: "Open note" }));
    await waitFor(() => expect(openFile).toHaveBeenCalledTimes(1));
    expect(openFile).toHaveBeenCalledWith(REPORT_NOTE_PATH);
    registry.disposeAll();
  });

  it("an unreadable row's Open note opens its own path", async () => {
    const { registry, openFile } = setup({
      rows: [unreadableRow("broken-report.md")],
      report: () => Promise.reject(new ResearchApiError("unreadable-report")),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Open note" }));
    await waitFor(() => expect(openFile).toHaveBeenCalledWith("global/output/broken-report.md"));
    registry.disposeAll();
  });

  it("a report that turns unreadable in the reader still offers Open note with the path the row had", async () => {
    const row = reportRow(0, { noteId: REPORT_NOTE_ID, notePath: REPORT_NOTE_PATH });
    const { registry, openFile } = setup({
      rows: [row],
      report: () => Promise.reject(new ResearchApiError("unreadable-report")),
    });
    await waitFor(() =>
      expect(document.querySelectorAll("button.ccc-report-row-button").length).toBe(1),
    );
    fireEvent.click(document.querySelector("button.ccc-report-row-button") as HTMLElement);
    const reader = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("article.ccc-report-reader");
      if (found === null) throw new Error("no reader yet");
      return found;
    });
    fireEvent.click(await within(reader).findByRole("button", { name: "Open note" }));
    await waitFor(() => expect(openFile).toHaveBeenCalledWith(REPORT_NOTE_PATH));
    registry.disposeAll();
  });

  it("says Couldn't open the note. once when the host cannot open it", async () => {
    const { registry, openFile } = setup({
      rows: [unreadableRow("gone.md")],
      report: () => Promise.reject(new ResearchApiError("not-found")),
      open: () => false,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Open note" }));
    await waitFor(() => expect(openFile).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(document.querySelector('.ccc-research-status[role="status"]')?.textContent).toBe(
        "Couldn't open the note.",
      ),
    );
    registry.disposeAll();
  });
});
