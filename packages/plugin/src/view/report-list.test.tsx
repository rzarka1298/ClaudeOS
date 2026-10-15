import type { ResearchListRow } from "@ccc/domain/research-routes.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  iso,
  RESEARCH_NOW_MS,
  RESEARCH_ZONE,
  reportRow,
  unreadableRow,
} from "../test-support/research-view-fixtures.js";
import { ReportList, type ReportListProps } from "./report-list.js";

afterEach(() => {
  cleanup();
});

function props(overrides: Partial<ReportListProps> = {}): ReportListProps {
  return {
    rows: [],
    loaded: true,
    failure: null,
    hasMore: false,
    loadingMore: false,
    selectedNoteId: null,
    connected: true,
    allRunsFailed: false,
    loadedAt: iso(-5),
    now: RESEARCH_NOW_MS,
    zone: RESEARCH_ZONE,
    focusRequest: null,
    onFocusHandled: () => undefined,
    onSelect: () => undefined,
    onOpenNote: () => undefined,
    onShowMore: () => undefined,
    onRefresh: () => undefined,
    ...overrides,
  };
}

function rowsOf(count: number): ResearchListRow[] {
  return Array.from({ length: count }, (_, index) => reportRow(index));
}

function listItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("li.ccc-report-row")];
}

describe("Test 1: rows", () => {
  it("renders newest first with the title clamped and the full text in title", () => {
    const long = `${"A long report title ".repeat(8)}end`;
    render(
      <ReportList
        {...props({ rows: [reportRow(0, { title: long }), reportRow(1), reportRow(2)] })}
      />,
    );
    const items = listItems();
    expect(items).toHaveLength(3);
    const title = items[0]?.querySelector(".ccc-clamp-2");
    expect(title?.textContent).toBe(long);
    expect(title?.getAttribute("title")).toBe(long);
    expect(items[1]?.textContent).toContain(reportRow(1).title);
    expect(items[2]?.textContent).toContain(reportRow(2).title);
  });

  it("shows the relative time with the absolute one in title and in a hidden span", () => {
    render(<ReportList {...props({ rows: [reportRow(0)] })} />);
    const time = listItems()[0]?.querySelector("time");
    expect(time?.textContent).toBe("1 hour ago");
    expect(time?.getAttribute("title")).toBe("Oct 14, 11:00 AM");
    const hidden = document.getElementById(time?.getAttribute("aria-describedby") ?? "");
    expect(hidden?.textContent).toBe("Oct 14, 11:00 AM");
    expect(hidden?.className).toContain("ccc-visually-hidden");
  });

  it("derives Cached or Stale from generatedAt with the domain threshold", () => {
    render(
      <ReportList
        {...props({
          rows: [reportRow(0), reportRow(1, { generatedAt: "2026-10-12T21:59:00.000Z" })],
        })}
      />,
    );
    const [fresh, old] = listItems();
    const freshBadge = fresh?.querySelector(".ccc-badge");
    expect(freshBadge?.getAttribute("data-badge")).toBe("cached");
    expect(freshBadge?.textContent).toContain("◐");
    expect(freshBadge?.textContent).toContain("Cached");
    const oldBadge = old?.querySelector(".ccc-badge");
    expect(oldBadge?.getAttribute("data-badge")).toBe("stale");
    expect(oldBadge?.textContent).toContain("◷");
    expect(oldBadge?.textContent).toContain("Stale");
  });

  it("shows a partial report with its badge, accessible name and n of m sources", () => {
    render(
      <ReportList
        {...props({
          rows: [
            reportRow(0, { partial: true, sourceCount: 4, sourceTotal: 6, unavailableCount: 2 }),
          ],
        })}
      />,
    );
    const item = listItems()[0];
    const badge = item?.querySelector('.ccc-badge[data-badge="partial"]');
    expect(badge?.textContent).toContain("Partial");
    expect(badge?.textContent).toContain("Partial — 2 sources didn't respond");
    expect(item?.textContent).toContain("4 of 6 sources");
    expect(item?.textContent).toContain("12 items");
  });

  it("pluralises one source and one item, and one unavailable source", () => {
    render(
      <ReportList
        {...props({
          rows: [
            reportRow(0, {
              partial: true,
              sourceCount: 1,
              sourceTotal: 2,
              unavailableCount: 1,
              itemCount: 1,
            }),
            reportRow(1, { sourceCount: 1, sourceTotal: 1, itemCount: 1 }),
          ],
        })}
      />,
    );
    const [first, second] = listItems();
    expect(first?.textContent).toContain("1 of 2 sources");
    expect(first?.textContent).toContain("Partial — 1 source didn't respond");
    expect(first?.textContent).toContain("1 item");
    expect(first?.textContent).not.toContain("1 items");
    expect(second?.textContent).toContain("1 source");
    expect(second?.textContent).not.toContain("1 sources");
  });

  it("renders one report as one row with no count chrome", () => {
    render(<ReportList {...props({ rows: [reportRow(0)] })} />);
    expect(listItems()).toHaveLength(1);
    expect(screen.queryByText(/1 report/)).toBeNull();
    expect(screen.queryByText(/\(1\)/)).toBeNull();
  });

  it("selects through the row button and marks the selected row", () => {
    const onSelect = vi.fn();
    const rows = [reportRow(0), reportRow(1)];
    const { rerender } = render(<ReportList {...props({ rows, onSelect })} />);
    fireEvent.click(listItems()[1]?.querySelector("button") as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith((rows[1] as { noteId: string }).noteId);
    rerender(
      <ReportList
        {...props({ rows, onSelect, selectedNoteId: (rows[1] as { noteId: string }).noteId })}
      />,
    );
    const buttons = [...document.querySelectorAll("li.ccc-report-row button")];
    expect(buttons[0]?.getAttribute("aria-current")).toBeNull();
    expect(buttons[1]?.getAttribute("aria-current")).toBe("true");
    expect(listItems()[1]?.getAttribute("data-selected")).toBe("true");
  });
});

describe("Test 2: keyboard and paging", () => {
  function buttons(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("button.ccc-report-row-button")];
  }

  it("moves between row buttons with the arrow keys, Home and End", () => {
    render(<ReportList {...props({ rows: rowsOf(4) })} />);
    const all = buttons();
    all[0]?.focus();
    fireEvent.keyDown(all[0] as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(all[1]);
    fireEvent.keyDown(all[1] as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(all[2]);
    fireEvent.keyDown(all[2] as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(all[1]);
    fireEvent.keyDown(all[1] as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(all[3]);
    fireEvent.keyDown(all[3] as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(all[3]);
    fireEvent.keyDown(all[3] as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(all[0] as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(all[0]);
  });

  it("offers Show 25 more only when there is another page, and calls the handler", () => {
    const onShowMore = vi.fn();
    const { rerender } = render(<ReportList {...props({ rows: rowsOf(25), onShowMore })} />);
    expect(screen.queryByRole("button", { name: "Show 25 more" })).toBeNull();
    rerender(<ReportList {...props({ rows: rowsOf(25), hasMore: true, onShowMore })} />);
    fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
    expect(onShowMore).toHaveBeenCalledTimes(1);
  });

  it("moves focus to the first newly loaded row, once", () => {
    const handled = vi.fn();
    const { rerender } = render(
      <ReportList {...props({ rows: rowsOf(25), hasMore: true, onFocusHandled: handled })} />,
    );
    rerender(
      <ReportList {...props({ rows: rowsOf(50), focusRequest: 25, onFocusHandled: handled })} />,
    );
    expect(document.activeElement).toBe(buttons()[25]);
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("keeps a focused row where it is when a new report arrives at the top", () => {
    const { rerender } = render(<ReportList {...props({ rows: rowsOf(3) })} />);
    const second = buttons()[1] as HTMLElement;
    second.focus();
    const fresh = reportRow(9, { generatedAt: iso(-1), title: "A brand new report" });
    rerender(<ReportList {...props({ rows: [fresh, ...rowsOf(3)] })} />);
    expect(listItems()).toHaveLength(4);
    expect(listItems()[0]?.textContent).toContain("A brand new report");
    expect(document.activeElement).toBe(second);
  });

  it("makes Show 25 more aria-disabled with the reason when disconnected", () => {
    const onShowMore = vi.fn();
    render(
      <ReportList {...props({ rows: rowsOf(25), hasMore: true, connected: false, onShowMore })} />,
    );
    const more = screen.getByRole("button", { name: "Show 25 more" });
    expect(more.getAttribute("aria-disabled")).toBe("true");
    expect(more.hasAttribute("disabled")).toBe(false);
    fireEvent.click(more);
    expect(onShowMore).not.toHaveBeenCalled();
    expect(document.getElementById(more.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "The companion service isn't running.",
    );
  });
});

describe("Test 3: an unreadable report", () => {
  it("reads Unreadable report with the file name and Open note, and cannot be selected", () => {
    const onSelect = vi.fn();
    const onOpenNote = vi.fn();
    const row = unreadableRow("broken-report.md");
    render(<ReportList {...props({ rows: [row, reportRow(0)], onSelect, onOpenNote })} />);
    const item = listItems()[0];
    expect(item?.textContent).toContain("▲");
    expect(item?.textContent).toContain("Unreadable report");
    expect(item?.textContent).toContain("broken-report.md");
    expect(item?.textContent).toContain("Its metadata couldn't be read.");
    expect(item?.querySelector("button.ccc-report-row-button")).toBeNull();
    fireEvent.click(item?.querySelector("button") as HTMLElement);
    expect(onOpenNote).toHaveBeenCalledWith("global/output/broken-report.md");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps Open note enabled while the service is away", () => {
    const onOpenNote = vi.fn();
    render(<ReportList {...props({ rows: [unreadableRow()], connected: false, onOpenNote })} />);
    const open = screen.getByRole("button", { name: "Open note" });
    expect(open.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(open);
    expect(onOpenNote).toHaveBeenCalledTimes(1);
  });
});

describe("Test 4: the list states", () => {
  it("loading: three skeleton rows, aria-busy and the hidden loading text", () => {
    render(<ReportList {...props({ loaded: false })} />);
    const region = document.querySelector(".ccc-report-list-region");
    expect(region?.getAttribute("aria-busy")).toBe("true");
    expect(region?.querySelectorAll(".ccc-skeleton-line")).toHaveLength(3);
    expect(screen.getByText("Loading research reports").className).toContain("ccc-visually-hidden");
    expect(screen.queryByText("No reports yet")).toBeNull();
  });

  it("empty, never run: the heading and the Run now next step", () => {
    render(<ReportList {...props()} />);
    expect(screen.getByText("No reports yet")).toBeTruthy();
    expect(
      screen.getByText(
        "Press Run now to fetch the configured sources and write your first cited report.",
      ),
    ).toBeTruthy();
  });

  it("empty, every run failed: points at the last failed run", () => {
    render(<ReportList {...props({ allRunsFailed: true })} />);
    expect(screen.getByText("No reports yet")).toBeTruthy();
    expect(
      screen.getByText("No run has produced a report yet. The last failed run says why."),
    ).toBeTruthy();
  });

  it("first-load error: the error copy and Refresh reports", () => {
    const onRefresh = vi.fn();
    render(<ReportList {...props({ loaded: false, failure: "timeout", onRefresh })} />);
    expect(screen.getByText("Couldn't load research reports.")).toBeTruthy();
    expect(
      screen.getByText("Check the service in Settings → Diagnostics, then refresh."),
    ).toBeTruthy();
    expect(document.querySelector(".ccc-error-glyph")?.textContent).toBe("▲");
    fireEvent.click(screen.getByRole("button", { name: "Refresh reports" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("No reports yet")).toBeNull();
  });

  it("a later refresh failure keeps the rows and adds the Couldn't refresh line", () => {
    const onRefresh = vi.fn();
    render(
      <ReportList
        {...props({ rows: rowsOf(2), failure: "timeout", loadedAt: iso(-5), onRefresh })}
      />,
    );
    expect(listItems()).toHaveLength(2);
    expect(
      screen.getByText("Couldn't refresh the report list. Showing what was loaded 5 minutes ago.", {
        exact: false,
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh reports" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("disconnected: dimmed with last-good rows and no repeated banner or refresh line", () => {
    render(
      <ReportList
        {...props({ rows: rowsOf(2), failure: "service-disconnected", connected: false })}
      />,
    );
    expect(document.querySelector(".ccc-report-list-region")?.getAttribute("data-dimmed")).toBe(
      "true",
    );
    expect(listItems()).toHaveLength(2);
    expect(screen.queryByText(/Couldn't refresh/)).toBeNull();
  });
});
