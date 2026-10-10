import {
  TASK_FILTERS,
  TASK_PROJECT_PANEL_DEFAULT_FILTER,
  TASK_PROJECT_PANEL_FILTERS,
  type TaskFilter,
} from "@ccc/domain/tasks.js";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskChips, type TaskChipsProps } from "./task-chips.js";

afterEach(cleanup);

const COUNTS: Record<TaskFilter, number> = {
  all: 212,
  today: 3,
  upcoming: 12,
  overdue: 1,
  project: 40,
  proposed: 2,
  blocked: 4,
  completed: 56,
};

function setup(overrides: Partial<TaskChipsProps> = {}) {
  const onSelect = vi.fn();
  const props: TaskChipsProps = {
    active: "today",
    counts: COUNTS,
    onSelect,
    ...overrides,
  };
  const utils = render(<TaskChips {...props} />);
  const toolbar = screen.getByRole("toolbar", { name: "Task filters" });
  return { ...utils, props, onSelect, toolbar, chips: within(toolbar).getAllByRole("button") };
}

describe("Test 1: the chip toolbar", () => {
  it("is a toolbar named Task filters with eight toggle buttons in the fixed order", () => {
    const { chips } = setup({ counts: null });
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "All",
      "Today",
      "Upcoming",
      "Overdue",
      "Project",
      "Proposed",
      "Blocked",
      "Completed",
    ]);
    for (const chip of chips) expect(chip.hasAttribute("aria-pressed")).toBe(true);
  });

  it("presses exactly one chip", () => {
    const { chips } = setup({ active: "blocked" });
    const pressed = chips.filter((chip) => chip.getAttribute("aria-pressed") === "true");
    expect(pressed.map((chip) => chip.textContent)).toEqual(["Blocked (4)"]);
  });

  it("states each count in the visible text and the accessible name, plural-safe", () => {
    const { chips } = setup();
    const today = chips[1];
    expect(today?.textContent).toBe("Today (3)");
    expect(today?.getAttribute("aria-label")).toBe("Today, 3 tasks");
    expect(chips[3]?.getAttribute("aria-label")).toBe("Overdue, 1 task");
    expect(chips[0]?.textContent).toBe("All (212)");
  });

  it("renders chips without counts, and without a count in the name, while counts are null", () => {
    const { chips } = setup({ counts: null });
    for (const chip of chips) {
      expect(chip.textContent).not.toMatch(/\d/);
      expect(chip.hasAttribute("aria-label")).toBe(false);
    }
  });

  it("is one Tab stop: only the focused chip has tabindex 0, and it starts on the pressed chip", () => {
    const { chips } = setup({ active: "overdue" });
    const stops = chips.filter((chip) => chip.getAttribute("tabindex") === "0");
    expect(stops.map((chip) => chip.textContent)).toEqual(["Overdue (1)"]);
    for (const chip of chips) {
      if (chip !== stops[0]) expect(chip.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("moves focus with the arrow keys, wrapping at both ends, and moves the tab stop with it", () => {
    const { chips } = setup({ active: "all" });
    chips[0]?.focus();
    fireEvent.keyDown(chips[0] as HTMLElement, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(chips[7]);
    expect(chips[7]?.getAttribute("tabindex")).toBe("0");
    expect(chips[0]?.getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(chips[7] as HTMLElement, { key: "ArrowRight" });
    expect(document.activeElement).toBe(chips[0]);
    fireEvent.keyDown(chips[0] as HTMLElement, { key: "ArrowRight" });
    expect(document.activeElement).toBe(chips[1]);
  });

  it("jumps with Home and End without pressing anything", () => {
    const { chips, onSelect } = setup();
    chips[1]?.focus();
    fireEvent.keyDown(chips[1] as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(chips[7]);
    fireEvent.keyDown(chips[7] as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(chips[0]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("presses a chip with a click, which Enter and Space produce on a native button", () => {
    const { chips, onSelect } = setup();
    expect(
      chips.every((chip) => chip.tagName === "BUTTON" && chip.getAttribute("type") === "button"),
    ).toBe(true);
    fireEvent.click(chips[2] as HTMLElement);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("upcoming");
  });

  it("follows focus that arrives another way, such as a click", () => {
    const { chips } = setup();
    fireEvent.focus(chips[5] as HTMLElement);
    expect(chips[5]?.getAttribute("tabindex")).toBe("0");
    expect(chips[1]?.getAttribute("tabindex")).toBe("-1");
  });
});

describe("Test 2: the project panel's chip set", () => {
  it("omits Project and opens on the filter the props name", () => {
    const { chips } = setup({
      filters: TASK_PROJECT_PANEL_FILTERS,
      active: TASK_PROJECT_PANEL_DEFAULT_FILTER,
      counts: { ...COUNTS, project: 0 },
    });
    expect(chips).toHaveLength(7);
    expect(chips.map((chip) => chip.textContent?.replace(/ \(.*/, ""))).toEqual([
      "All",
      "Today",
      "Upcoming",
      "Overdue",
      "Proposed",
      "Blocked",
      "Completed",
    ]);
    expect(chips[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(chips[0]?.getAttribute("tabindex")).toBe("0");
  });

  it("is the same component for both contexts: the global set has eight, the panel seven", () => {
    expect(TASK_FILTERS).toHaveLength(8);
    expect(TASK_PROJECT_PANEL_FILTERS).toHaveLength(7);
  });
});
