import { HOSTILE_TASK_TITLES } from "@ccc/domain/task-corpus.js";
import type { TaskAttentionItem } from "@ccc/domain/tasks.js";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttentionList, type AttentionListProps } from "./attention-list.js";

afterEach(cleanup);

function item(n: number, overrides: Partial<TaskAttentionItem> = {}): TaskAttentionItem {
  return {
    path: `tasks/note-${n}.md`,
    title: `Note ${n}`,
    reason: "missing-id",
    otherPaths: [],
    ...overrides,
  };
}

function props(
  items: readonly TaskAttentionItem[],
  overrides: Partial<AttentionListProps> = {},
): AttentionListProps {
  return {
    items,
    total: items.length,
    hasMore: false,
    connected: true,
    onShowMore: vi.fn(),
    onOpenNote: vi.fn(),
    ...overrides,
  };
}

function text(value: string | RegExp): HTMLElement {
  const found = screen.queryByText(value);
  expect(found, `text ${String(value)}`).not.toBeNull();
  return found as HTMLElement;
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".ccc-attention-row")];
}

describe("Test 11: the attention list", () => {
  it("renders nothing when there are no entries", () => {
    const view = render(<AttentionList {...props([])} />);
    expect(view.container.textContent).toBe("");
  });

  it("shows the heading with the count, the intro and one row per note with its fixed reason and path", () => {
    const items = [
      item(1, { reason: "missing-id" }),
      item(2, { reason: "unreadable" }),
      item(3, { reason: "duplicate-id", otherPaths: ["tasks/b.md", "areas/c.md"] }),
      item(4, { reason: "duplicate-id", otherPaths: ["tasks/b.md"] }),
    ];
    render(<AttentionList {...props(items)} />);
    expect(
      screen.queryByRole("heading", { level: 3, name: "Notes need attention (4)" }),
    ).not.toBeNull();
    text(
      "These task notes share an ID, are missing one, or can't be read, so they're left out of the lists above. Nothing was changed for you.",
    );
    const found = rows();
    expect(found).toHaveLength(4);
    expect(found[0]?.textContent).toContain("Note 1");
    expect(found[0]?.textContent).toContain("Missing its ID");
    expect(found[0]?.textContent).toContain("tasks/note-1.md");
    expect(found[1]?.textContent).toContain("Its metadata couldn't be read");
    expect(found[2]?.textContent).toContain("Shares its ID with 2 other notes: b.md, c.md");
    expect(found[3]?.textContent).toContain("Shares its ID with 1 other note: b.md");
    const path = found[0]?.querySelector(".ccc-attention-path");
    expect(path?.textContent).toBe("tasks/note-1.md");
  });

  it("falls back to the file name when a note has no title", () => {
    render(<AttentionList {...props([item(1, { title: undefined })])} />);
    expect(rows()[0]?.textContent).toContain("note-1.md");
  });

  it("opens a note from its row, even while the service is away", () => {
    const onOpenNote = vi.fn();
    render(<AttentionList {...props([item(1), item(2)], { connected: false, onOpenNote })} />);
    const second = rows()[1] as HTMLElement;
    const open = within(second).getByRole("button", { name: /Open note/ });
    expect(open.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(open);
    expect(onOpenNote).toHaveBeenCalledWith("tasks/note-2.md");
  });

  it("pages: 25 rows then Show 25 more, and the remainder when fewer than 25 are left", () => {
    const onShowMore = vi.fn();
    const items = Array.from({ length: 25 }, (_, index) => item(index + 1));
    const view = render(
      <AttentionList {...props(items, { total: 60, hasMore: true, onShowMore })} />,
    );
    expect(rows()).toHaveLength(25);
    fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
    expect(onShowMore).toHaveBeenCalledTimes(1);
    view.rerender(<AttentionList {...props(items, { total: 30, hasMore: true, onShowMore })} />);
    expect(screen.queryByRole("button", { name: "Show 5 more" })).not.toBeNull();
    view.rerender(<AttentionList {...props(items, { total: 25, hasMore: false, onShowMore })} />);
    expect(screen.queryByRole("button", { name: /Show \d+ more/ })).toBeNull();
  });

  it("disables Show more with the standard reason when the service is away", () => {
    const onShowMore = vi.fn();
    const items = Array.from({ length: 25 }, (_, index) => item(index + 1));
    render(
      <AttentionList
        {...props(items, { total: 60, hasMore: true, connected: false, onShowMore })}
      />,
    );
    const more = screen.getByRole("button", { name: "Show 25 more" });
    expect(more.getAttribute("aria-disabled")).toBe("true");
    expect(more.hasAttribute("disabled")).toBe(false);
    expect(document.getElementById(more.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "The companion service isn't running.",
    );
    fireEvent.click(more);
    expect(onShowMore).not.toHaveBeenCalled();
  });

  it("offers no control that mints, rewrites or merges an id", () => {
    const items = [item(1), item(2, { reason: "duplicate-id", otherPaths: ["tasks/b.md"] })];
    render(<AttentionList {...props(items, { total: 40, hasMore: true })} />);
    const names = screen.getAllByRole("button").map((control) => control.textContent ?? "");
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).toMatch(/^(Open note|Show \d+ more)$/);
    }
  });
});

describe("Test 12: hostile text in the attention list", () => {
  it("renders titles and reasons as literal text nodes", () => {
    for (const hostile of HOSTILE_TASK_TITLES) {
      if (hostile === "") continue;
      const view = render(<AttentionList {...props([item(1, { title: hostile })])} />);
      expect(
        view.container.querySelector("script, img, style, a, iframe, svg"),
        hostile,
      ).toBeNull();
      expect(rows()[0]?.querySelector(".ccc-attention-title")?.textContent, hostile).toBe(hostile);
      view.unmount();
    }
  });
});
