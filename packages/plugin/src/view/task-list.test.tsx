import { HOSTILE_TASK_TITLES } from "@ccc/domain/task-corpus.js";
import type { TaskRow } from "@ccc/domain/tasks.js";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  projectIdFor,
  TASK_NOW_MS,
  TASK_ZONE,
  taskRow,
  taskRows,
} from "../test-support/task-view-fixtures.js";
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
    now: TASK_NOW_MS,
    zone: TASK_ZONE,
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

function region(): HTMLElement {
  return document.querySelector(".ccc-task-list-region") as HTMLElement;
}

describe("Test 2: meta line 2 (date, project, tags)", () => {
  const PROJECT = projectIdFor(1);

  it("joins the date phrase, project and tags with a middle dot", () => {
    setup(
      [
        taskRow(1, {
          dueDate: "2026-10-05",
          projectId: PROJECT,
          tags: ["writing", "review"],
          tagCount: 2,
        }),
      ],
      { projectNames: { [PROJECT]: "example-project" } },
    );
    const line = document.querySelector('[data-line="details"]');
    expect(line?.textContent).toBe("Due today · example-project · #writing #review");
  });

  it("shows three tags then +N more", () => {
    setup([taskRow(1, { tags: ["a", "b", "c"], tagCount: 5 })]);
    expect(document.querySelector('[data-line="details"]')?.textContent).toBe("#a #b #c +2 more");
  });

  it("omits empty segments, and the whole line when nothing is left", () => {
    setup([taskRow(1, { projectId: PROJECT }), taskRow(2)], {
      projectNames: { [PROJECT]: "example-project" },
    });
    const [first, second] = screen.getAllByRole("listitem");
    expect(first?.querySelector('[data-line="details"]')?.textContent).toBe("example-project");
    expect(second?.querySelector('[data-line="details"]')).toBeNull();
  });

  it("marks an overdue phrase with a data hook, not a colour", () => {
    setup([taskRow(1, { dueDate: "2026-10-02", overdue: true })]);
    const phrase = document.querySelector(".ccc-task-date");
    expect(phrase?.textContent).toBe("Overdue — due Oct 2");
    expect(phrase?.getAttribute("data-overdue")).toBe("true");
  });

  it("renders each tag with its full text in a title attribute", () => {
    setup([taskRow(1, { tags: ["review"], tagCount: 1 })]);
    expect(document.querySelector(".ccc-task-tag")?.getAttribute("title")).toBe("review");
  });
});

describe("Test 3: the blocked line", () => {
  it("states how many unfinished tasks it waits on, plural-safe, without rewriting the status", () => {
    setup([
      taskRow(1, { unmetDependencies: 2 }),
      taskRow(2, { unmetDependencies: 1 }),
      taskRow(3, { unmetDependencies: 0 }),
    ]);
    const [two, one, none] = screen.getAllByRole("listitem");
    expect(two?.querySelector('[data-line="blocked"]')?.textContent).toBe(
      "‖ Blocked — waiting on 2 unfinished tasks",
    );
    expect(one?.querySelector('[data-line="blocked"]')?.textContent).toBe(
      "‖ Blocked — waiting on 1 unfinished task",
    );
    expect(none?.querySelector('[data-line="blocked"]')).toBeNull();
    expect(two?.querySelector('[data-line="status"]')?.textContent).toContain("Ready");
  });

  it("shows no blocked line on a finished task", () => {
    setup([taskRow(1, { status: "done", unmetDependencies: 3 })]);
    expect(document.querySelector('[data-line="blocked"]')).toBeNull();
  });
});

describe("Test 4: pagination", () => {
  it("shows Show 25 more and a Showing line, and nothing when no more are available", () => {
    const rows = taskRows(25);
    const utils = render(<TaskList {...baseProps(rows, { total: 212, hasMore: true })} />);
    expect(screen.getByRole("button", { name: "Show 25 more" })).toBeTruthy();
    expect(screen.getByRole("heading").textContent).toBe("Showing 25 of 212");
    utils.rerender(<TaskList {...baseProps(rows, { total: 25, hasMore: false })} />);
    expect(screen.queryByRole("button", { name: /Show \d+ more/ })).toBeNull();
  });

  it("calls onLoadMore, then focuses the first new title and announces how many arrived", async () => {
    const rows = taskRows(30);
    const onLoadMore = vi.fn();
    const announce = vi.fn();
    const first = rows.slice(0, 25);
    const utils = render(
      <TaskList {...baseProps(first, { total: 30, hasMore: true, onLoadMore, announce })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show 5 more" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(announce).not.toHaveBeenCalled();
    utils.rerender(
      <TaskList {...baseProps(rows, { total: 30, hasMore: false, onLoadMore, announce })} />,
    );
    await waitFor(() => expect(document.activeElement).toBe(titleButton("Task 26")));
    expect(announce).toHaveBeenCalledExactlyOnceWith("5 more tasks loaded.");
  });

  it("announces 25 more tasks loaded for a full page and 1 more task for a single one", async () => {
    const rows = taskRows(51);
    const announce = vi.fn();
    const utils = render(
      <TaskList {...baseProps(rows.slice(0, 25), { total: 51, hasMore: true, announce })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
    utils.rerender(
      <TaskList {...baseProps(rows.slice(0, 50), { total: 51, hasMore: true, announce })} />,
    );
    await waitFor(() => expect(announce).toHaveBeenLastCalledWith("25 more tasks loaded."));
    fireEvent.click(screen.getByRole("button", { name: "Show 1 more" }));
    utils.rerender(<TaskList {...baseProps(rows, { total: 51, hasMore: false, announce })} />);
    await waitFor(() => expect(announce).toHaveBeenLastCalledWith("1 more task loaded."));
  });

  it("has no live region of its own", () => {
    setup(taskRows(2), { hasMore: true });
    expect(document.querySelector('[role="status"], [aria-live]')).toBeNull();
  });

  it("makes Show more aria-disabled with the reason when the service is down", () => {
    const onLoadMore = vi.fn();
    setup(taskRows(2), { total: 9, hasMore: true, connected: false, onLoadMore });
    const more = screen.getByRole("button", { name: /Show \d+ more/ });
    expect(more.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(more);
    expect(onLoadMore).not.toHaveBeenCalled();
  });
});

describe("Test 5: arrow keys between title buttons", () => {
  it("moves with Down and Up, jumps with Home and End, and never scrolls smoothly", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      setup(taskRows(4));
      const buttons = screen.getAllByRole("button", { name: /^Task \d$/ });
      buttons[0]?.focus();
      fireEvent.keyDown(buttons[0] as HTMLElement, { key: "ArrowDown" });
      expect(document.activeElement).toBe(buttons[1]);
      fireEvent.keyDown(buttons[1] as HTMLElement, { key: "ArrowUp" });
      expect(document.activeElement).toBe(buttons[0]);
      fireEvent.keyDown(buttons[0] as HTMLElement, { key: "End" });
      expect(document.activeElement).toBe(buttons[3]);
      fireEvent.keyDown(buttons[3] as HTMLElement, { key: "ArrowDown" });
      expect(document.activeElement).toBe(buttons[3]);
      fireEvent.keyDown(buttons[3] as HTMLElement, { key: "Home" });
      expect(document.activeElement).toBe(buttons[0]);
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

describe("Test 6: a chip change", () => {
  it("keeps the previous rows visible and marks the list busy, with no spinner", () => {
    setup(taskRows(3), { busy: true });
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(document.querySelector("ul.ccc-task-list")?.getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector('[role="progressbar"], progress, .ccc-spinner')).toBeNull();
  });

  it("is not busy once the page has arrived", () => {
    setup(taskRows(3));
    expect(document.querySelector("ul.ccc-task-list")?.getAttribute("aria-busy")).toBeNull();
  });
});

describe("Test 7: every destination state", () => {
  it("shows three skeleton lines and hidden loading text while loading", () => {
    setup([], { status: "loading" });
    expect(document.querySelectorAll(".ccc-skeleton-line")).toHaveLength(3);
    expect(screen.getByText("Loading tasks").className).toContain("ccc-visually-hidden");
    expect(region().querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it.each([
    ["all", false],
    ["today", true],
  ] as const)(
    "shows the first-run state with Create a task for the %s empty case (no tasks at all: %s)",
    (filter, noTasks) => {
      const onCreate = vi.fn();
      setup([], { filter, noTasksAtAll: noTasks, onCreate });
      expect(screen.getByRole("heading").textContent).toBe("Nothing here yet");
      expect(
        screen.getByText("Tasks has no items right now. New items appear as they arrive."),
      ).toBeTruthy();
      expect(screen.getByText("Create your first task to start your list.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Create a task" }));
      expect(onCreate).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      "today",
      "Nothing due today.",
      "Tasks with a due or scheduled date of today appear here.",
      true,
    ],
    ["upcoming", "Nothing coming up.", "Tasks dated after today appear here.", false],
    ["overdue", "Nothing is overdue.", "Open tasks past their due date appear here.", false],
    [
      "proposed",
      "No suggested tasks.",
      "Tasks suggested by skills or automations appear here for you to accept or dismiss.",
      false,
    ],
    [
      "blocked",
      "Nothing is blocked.",
      "Tasks marked blocked, or waiting on unfinished tasks, appear here.",
      false,
    ],
    ["completed", "Nothing completed yet.", "Tasks you mark done appear here.", false],
  ] as const)("renders the %s empty line and its next step", (filter, heading, next, cta) => {
    setup([], { filter });
    expect(screen.getByRole("heading").textContent).toBe(heading);
    expect(screen.getByText(next)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create a task" }) !== null).toBe(cta);
  });

  it("asks for a project when none is chosen, and names the project when it has no tasks", () => {
    const first = render(
      <TaskList {...baseProps([], { filter: "project", chooseProject: true })} />,
    );
    expect(screen.getByRole("heading").textContent).toBe("Choose a project to see its tasks.");
    expect(screen.getByText("Pick one from the Project list.")).toBeTruthy();
    first.unmount();
    render(<TaskList {...baseProps([], { filter: "project", projectName: "example-project" })} />);
    expect(screen.getByRole("heading").textContent).toBe("No tasks for example-project yet.");
    expect(screen.getByText("Create a task and it appears here.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create a task" })).toBeTruthy();
  });

  it("keeps the rows readable and carries a hook when stale, and says so while rebuilding", () => {
    setup(taskRows(2), { stale: true, rebuilding: true });
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(region().getAttribute("data-stale")).toBe("true");
    expect(screen.getByText("Rebuilding the task index…")).toBeTruthy();
    expect(document.querySelector("ul.ccc-task-list")?.getAttribute("aria-busy")).toBe("true");
  });

  it("dims the list and disables every service-backed control when disconnected", () => {
    const onCreate = vi.fn();
    const rows = [taskRow(1), taskRow(2, { status: "proposed" })];
    render(
      <TaskList
        {...baseProps(rows, { connected: false, lastReceived: "3 minutes ago", onCreate })}
      />,
    );
    expect(screen.getByText("Service disconnected")).toBeTruthy();
    expect(
      screen.getByText("Showing the last values received 3 minutes ago. They may be out of date."),
    ).toBeTruthy();
    expect(screen.getByText("The companion service isn't running.")).toBeTruthy();
    expect(
      screen.getByText(
        "Task notes are still editable in Obsidian; the lists catch up when the service is back.",
      ),
    ).toBeTruthy();
    expect(document.querySelector("ul.ccc-task-list")?.getAttribute("data-dimmed")).toBe("true");
    for (const pill of document.querySelectorAll(".ccc-task-action")) {
      expect(pill.getAttribute("aria-disabled")).toBe("true");
    }
  });

  it("disables Create a task, with the reason, in an empty disconnected list", () => {
    const onCreate = vi.fn();
    setup([], { filter: "today", connected: false, onCreate });
    const create = screen.getByRole("button", { name: "Create a task" });
    expect(create.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(create);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("shows the load failure and its diagnostics hint", () => {
    setup([], { status: "error" });
    expect(document.querySelector(".ccc-state-heading")?.textContent).toBe(
      "▲ Couldn't load tasks.",
    );
    expect(
      screen.getByText("Check the service in Settings → Diagnostics, then refresh."),
    ).toBeTruthy();
  });
});

describe("Test 8: hostile titles", () => {
  it("renders every title in the shared corpus as literal clamped text with no markup", () => {
    expect(HOSTILE_TASK_TITLES.length).toBeGreaterThan(30);
    for (const title of HOSTILE_TASK_TITLES) {
      const { container, unmount } = render(
        <TaskList {...baseProps([taskRow(1, { title, status: "ready" })])} />,
      );
      const button = container.querySelector(".ccc-task-title") as HTMLElement;
      expect(button.textContent, title).toBe(title);
      expect(button.getAttribute("title"), title).toBe(title);
      expect(button.querySelector(".ccc-clamp-2"), title).not.toBeNull();
      expect(container.querySelector("a, img, script, iframe, style, svg"), title).toBeNull();
      expect(button.children, title).toHaveLength(1);
      unmount();
    }
  });

  it("renders a 5,000-character title once as text, with the full text in the title attribute", () => {
    const title = "x".repeat(5000);
    const { container } = render(<TaskList {...baseProps([taskRow(1, { title })])} />);
    const button = container.querySelector(".ccc-task-title") as HTMLElement;
    expect(button.getAttribute("title")).toBe(title);
    expect(button.textContent).toBe(title);
    const occurrences = container.innerHTML.split(title).length - 1;
    // The text node and the title attribute; the accessible names are clamped.
    expect(occurrences).toBe(2);
  });

  it("renders a hostile project name and tag as text only", () => {
    const hostile = "<img src=x onerror=alert(1)>[U+202E]";
    const PROJECT = projectIdFor(2);
    const { container } = render(
      <TaskList
        {...baseProps([taskRow(1, { projectId: PROJECT, tags: [hostile], tagCount: 1 })], {
          projectNames: { [PROJECT]: hostile },
        })}
      />,
    );
    expect(container.querySelector("img, a, script")).toBeNull();
    expect(container.textContent).toContain(hostile);
  });
});
