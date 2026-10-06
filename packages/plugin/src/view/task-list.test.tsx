import type { TaskRow } from "@ccc/domain/tasks.js";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskRow, taskRows } from "../test-support/task-view-fixtures.js";
import { TaskList, type TaskListProps, type TaskRowAction } from "./task-list.js";

afterEach(cleanup);

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function baseProps(
  rows: readonly TaskRow[],
  overrides: Partial<TaskListProps> = {},
): TaskListProps {
  return {
    filter: "today",
    rows,
    total: rows.length,
    selectedId: null,
    connected: true,
    onSelect: vi.fn(),
    onAction: vi.fn(async () => undefined),
    ...overrides,
  };
}

function setup(rows: readonly TaskRow[], overrides: Partial<TaskListProps> = {}) {
  const props = baseProps(rows, overrides);
  const utils = render(<TaskList {...props} />);
  return { ...utils, props };
}

function titleButton(title: string): HTMLElement {
  return screen.getByRole("button", { name: title });
}

describe("Test 3: rows", () => {
  it("shows the status glyph and word, then the priority glyph and word when set", () => {
    setup([
      taskRow(1, { status: "in-progress", priority: "urgent" }),
      taskRow(2, { status: "inbox" }),
    ]);
    const [first, second] = screen.getAllByRole("listitem");
    expect(first?.textContent).toContain("▰");
    expect(first?.textContent).toContain("In progress");
    expect(first?.textContent).toContain("⇈");
    expect(first?.textContent).toContain("Urgent");
    expect(second?.textContent).toContain("▤");
    expect(second?.textContent).toContain("Inbox");
    expect(second?.textContent).not.toContain("No priority");
    // The glyphs are decoration beside the words.
    for (const glyph of first?.querySelectorAll(".ccc-task-glyph") ?? []) {
      expect(glyph.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("renders the title as a button with the full text in its title attribute", () => {
    setup([taskRow(1, { title: "Draft the weekly review" })]);
    const button = titleButton("Draft the weekly review");
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("title")).toBe("Draft the weekly review");
  });

  it.each(["inbox", "ready", "in-progress", "blocked"])(
    "gives an open %s task exactly one Mark done pill",
    (status) => {
      setup([taskRow(1, { status, title: "Open one" })]);
      const row = screen.getByRole("listitem");
      const pills = within(row)
        .getAllByRole("button")
        .filter((b) => b.dataset.action !== undefined);
      expect(pills.map((pill) => pill.textContent)).toEqual(["Mark done"]);
      expect(pills[0]?.getAttribute("aria-label")).toBe("Mark done: Open one");
    },
  );

  it.each(["done", "cancelled"])("gives a %s task no pill", (status) => {
    setup([taskRow(1, { status })]);
    const row = screen.getByRole("listitem");
    expect(within(row).getAllByRole("button")).toHaveLength(1);
  });

  it("gives a proposed task Accept and Dismiss, in that order", () => {
    setup([taskRow(1, { status: "proposed", title: "Suggested" })]);
    const row = screen.getByRole("listitem");
    const pills = within(row)
      .getAllByRole("button")
      .filter((b) => b.dataset.action !== undefined);
    expect(pills.map((pill) => pill.textContent)).toEqual(["Accept", "Dismiss"]);
    expect(pills.map((pill) => pill.getAttribute("aria-label"))).toEqual([
      "Accept task: Suggested",
      "Dismiss task: Suggested",
    ]);
  });
});

describe("Test 4: action call and busy", () => {
  it("calls the injected action once with the action name and the row", async () => {
    const row = taskRow(1, { title: "Draft" });
    const onAction = vi.fn(async () => undefined);
    setup([row], { onAction });
    fireEvent.click(screen.getByRole("button", { name: "Mark done: Draft" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("mark-done", row);
  });

  it("sets aria-busy and aria-disabled on every pill of the row before the promise settles, and ignores a second press", async () => {
    const pending = deferred<undefined>();
    const onAction = vi.fn((_action: TaskRowAction, _row: TaskRow) => pending.promise);
    setup(
      [taskRow(1, { status: "proposed", title: "Suggested" }), taskRow(2, { title: "Other" })],
      {
        onAction,
      },
    );
    const accept = screen.getByRole("button", { name: "Accept task: Suggested" });
    const dismiss = screen.getByRole("button", { name: "Dismiss task: Suggested" });
    const other = screen.getByRole("button", { name: "Mark done: Other" });
    fireEvent.click(accept);
    for (const pill of [accept, dismiss]) {
      expect(pill.getAttribute("aria-busy")).toBe("true");
      expect(pill.getAttribute("aria-disabled")).toBe("true");
      expect(pill.hasAttribute("disabled")).toBe(false);
    }
    expect(other.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(accept);
    fireEvent.click(dismiss);
    expect(onAction).toHaveBeenCalledTimes(1);
    pending.resolve(undefined);
    await waitFor(() => expect(accept.getAttribute("aria-busy")).toBeNull());
    expect(accept.getAttribute("aria-disabled")).toBeNull();
  });

  it("frees the pills again, keeping focus where it was, when the action fails", async () => {
    const onAction = vi.fn(async () => {
      throw new Error("no");
    });
    setup([taskRow(1, { title: "Draft" })], { onAction });
    const pill = screen.getByRole("button", { name: "Mark done: Draft" });
    pill.focus();
    fireEvent.click(pill);
    await waitFor(() => expect(pill.getAttribute("aria-busy")).toBeNull());
    expect(document.activeElement).toBe(pill);
    fireEvent.click(pill);
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it("is aria-disabled with the standard reason, never native disabled, when the service is down", () => {
    const onAction = vi.fn(async () => undefined);
    setup([taskRow(1, { title: "Draft" })], { connected: false, onAction });
    const pill = screen.getByRole("button", { name: "Mark done: Draft" });
    expect(pill.getAttribute("aria-disabled")).toBe("true");
    expect(pill.hasAttribute("disabled")).toBe(false);
    const reason = document.getElementById(pill.getAttribute("aria-describedby") ?? "none");
    expect(reason?.textContent).toBe("The companion service isn't running.");
    fireEvent.click(pill);
    expect(onAction).not.toHaveBeenCalled();
  });
});

/** A list that removes the acted-on row, like the service's refreshed page does. */
function RemovingList(props: { initial: readonly TaskRow[]; keepAsDone?: boolean }) {
  const [rows, setRows] = useState<readonly TaskRow[]>(props.initial);
  return (
    <TaskList
      {...baseProps(rows, {
        onAction: async (_action, row) => {
          setRows((current) =>
            props.keepAsDone === true
              ? current.map((item) => (item.id === row.id ? { ...item, status: "done" } : item))
              : current.filter((item) => item.id !== row.id),
          );
        },
      })}
    />
  );
}

describe("Test 5: focus after an action", () => {
  it("moves focus to the next row's title button when the acted-on row leaves", async () => {
    render(<RemovingList initial={taskRows(3)} />);
    const pill = screen.getByRole("button", { name: "Mark done: Task 2" });
    pill.focus();
    fireEvent.click(pill);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Task 2" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(titleButton("Task 3")));
  });

  it("moves focus to the previous row's title button when the last row leaves", async () => {
    render(<RemovingList initial={taskRows(3)} />);
    const pill = screen.getByRole("button", { name: "Mark done: Task 3" });
    pill.focus();
    fireEvent.click(pill);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Task 3" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(titleButton("Task 2")));
  });

  it("moves focus to the list heading when the list is now empty", async () => {
    render(<RemovingList initial={taskRows(1)} />);
    const pill = screen.getByRole("button", { name: "Mark done: Task 1" });
    pill.focus();
    fireEvent.click(pill);
    await waitFor(() => expect(screen.queryAllByRole("listitem")).toHaveLength(0));
    await waitFor(() => {
      const heading = screen.getByRole("heading");
      expect(document.activeElement).toBe(heading);
      expect(heading.getAttribute("tabindex")).toBe("-1");
    });
  });

  it("moves focus off a pill that disappeared although its row stayed (All view)", async () => {
    render(<RemovingList initial={taskRows(2)} keepAsDone />);
    const pill = screen.getByRole("button", { name: "Mark done: Task 1" });
    pill.focus();
    fireEvent.click(pill);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Mark done: Task 1" })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(titleButton("Task 2")));
  });

  it("never steals focus the owner already moved elsewhere", async () => {
    const pending = deferred<undefined>();
    const rows = taskRows(3);
    const utils = render(<TaskList {...baseProps(rows, { onAction: () => pending.promise })} />);
    const pill = screen.getByRole("button", { name: "Mark done: Task 2" });
    pill.focus();
    fireEvent.click(pill);
    titleButton("Task 1").focus();
    utils.rerender(<TaskList {...baseProps(rows.filter((row) => row.title !== "Task 2"))} />);
    pending.resolve(undefined);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Task 2" })).toBeNull());
    expect(document.activeElement).toBe(titleButton("Task 1"));
  });
});

describe("Test 6: selection", () => {
  it("calls onSelect with the id and marks only the selected title button current", () => {
    const rows = taskRows(2);
    const onSelect = vi.fn();
    const utils = render(<TaskList {...baseProps(rows, { onSelect })} />);
    fireEvent.click(titleButton("Task 2"));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(rows[1]?.id);
    utils.rerender(
      <TaskList {...baseProps(rows, { onSelect, selectedId: rows[1]?.id ?? null })} />,
    );
    expect(titleButton("Task 2").getAttribute("aria-current")).toBe("true");
    expect(titleButton("Task 1").getAttribute("aria-current")).toBeNull();
    const selectedRows = screen
      .getAllByRole("listitem")
      .filter((item) => item.getAttribute("data-selected") === "true");
    expect(selectedRows).toHaveLength(1);
  });
});
