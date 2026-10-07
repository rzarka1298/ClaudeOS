import { HOSTILE_TASK_TITLES } from "@ccc/domain/task-corpus.js";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { createRef } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detailTask, suggestedTask } from "../test-support/task-detail-fixtures.js";
import {
  projectIdFor,
  TASK_NOW_MS,
  TASK_ZONE,
  taskId,
} from "../test-support/task-view-fixtures.js";
import {
  TaskDetail,
  type TaskDetailProps,
  type TaskDetailResult,
  type TaskDetailTask,
} from "./task-detail.js";

afterEach(cleanup);

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const APPLIED: TaskDetailResult = { kind: "applied" };

function props(
  task: TaskDetailTask | null,
  overrides: Partial<TaskDetailProps> = {},
): TaskDetailProps {
  return {
    task,
    projects: [{ id: projectIdFor(1), name: "Garden" }],
    connected: true,
    zone: TASK_ZONE,
    nowMs: TASK_NOW_MS,
    onSave: vi.fn(() => Promise.resolve(APPLIED)),
    onAction: vi.fn(() => Promise.resolve(APPLIED)),
    onReload: vi.fn(() => Promise.resolve()),
    onOpenNote: vi.fn(),
    onSelectTask: vi.fn(),
    onStatus: vi.fn(),
    onNotice: vi.fn(),
    ...overrides,
  };
}

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function field(label: string): Field {
  const found = screen.queryByLabelText(label);
  expect(found, `a control labelled ${label}`).not.toBeNull();
  return found as Field;
}

function button(name: string | RegExp): HTMLButtonElement {
  const found = screen.queryByRole("button", { name });
  expect(found, `a button named ${String(name)}`).not.toBeNull();
  return found as HTMLButtonElement;
}

function text(value: string | RegExp): HTMLElement {
  const found = screen.queryByText(value);
  expect(found, `text ${String(value)}`).not.toBeNull();
  return found as HTMLElement;
}

function edit(label: string, value: string): void {
  fireEvent.input(field(label), { target: { value } });
}

function facts(): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>();
  for (const term of document.querySelectorAll(".ccc-detail-fields dt")) {
    map.set(term.textContent ?? "", term.nextElementSibling as HTMLElement);
  }
  return map;
}

describe("Test 1: structure", () => {
  it("renders the heading, state line, fields, actions, facts and hint in order", () => {
    const heading = createRef<HTMLHeadingElement>();
    render(<TaskDetail {...props(detailTask(), { headingRef: heading })} />);
    const h3 = screen.queryByRole("heading", { level: 3, name: "Write the report" });
    expect(h3).not.toBeNull();
    expect(h3?.getAttribute("tabindex")).toBe("-1");
    expect(heading.current).toBe(h3);
    text("◎ Ready");
    const group = screen.queryByRole("group", { name: "Task actions" });
    expect(group).not.toBeNull();
    const title = field("Title");
    const list = document.querySelector(".ccc-detail-fields");
    const hint = text(
      "Parents and dependencies are edited in the note. Scope can't be changed here.",
    );
    const follows = (a: Node, b: Node | null): boolean =>
      b !== null && Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(h3 as Node, title)).toBe(true);
    expect(follows(title, group)).toBe(true);
    expect(follows(group as Node, list)).toBe(true);
    expect(follows(list as Node, hint)).toBe(true);
    for (const label of [
      "Title",
      "Description",
      "Status",
      "Priority",
      "Due",
      "Due time",
      "Scheduled",
      "Project",
      "Tags",
    ]) {
      field(label);
    }
    expect((field("Status") as HTMLSelectElement).options.length).toBe(7);
    expect(field("Title").value).toBe("Write the report");
    expect(field("Tags").value).toBe("work, deep");
  });

  it("always renders every read-only fact in the fixed order, with None or Not provided when empty", () => {
    render(<TaskDetail {...props(detailTask({ assignee: null }))} />);
    expect([...facts().keys()]).toEqual([
      "Scope",
      "Parent",
      "Blocked by",
      "Source",
      "Assignee",
      "Created",
      "Updated",
      "Completed",
      "Task ID",
      "Note",
    ]);
    expect(facts().get("Parent")?.textContent).toBe("None");
    expect(facts().get("Blocked by")?.textContent).toBe("None");
    expect(facts().get("Assignee")?.textContent).toBe("Not provided");
    expect(facts().get("Completed")?.textContent).toBe("None");
  });

  it("shows the blocked fact under the status when dependencies are unmet", () => {
    const blockedBy = [
      { resolved: true as const, id: taskId(2), title: "Dep one", status: "ready" as const },
      { resolved: false as const, id: taskId(7) },
    ];
    render(<TaskDetail {...props(detailTask({ blockedBy }))} />);
    text("‖ Blocked — waiting on 2 unfinished tasks");
  });

  it("shows an empty prompt when no task is selected", () => {
    render(<TaskDetail {...props(null)} />);
    text("Select a task to see its details and edit it.");
  });
});

describe("Test 2: read-only facts", () => {
  it("shows the source link as plain monospace text and never as an anchor, and no absolute path", () => {
    const task = detailTask({
      sourceType: "email",
      sourceLink: "https://example.com/thread/1",
      assignee: "claude",
      completedAt: "2026-10-03T12:00:00.000Z",
    });
    const view = render(<TaskDetail {...props(task)} />);
    const source = facts().get("Source");
    expect(source?.textContent).toContain("email");
    expect(source?.textContent).toContain("https://example.com/thread/1");
    expect(view.container.querySelector("a")).toBeNull();
    expect(facts().get("Assignee")?.textContent).toBe("Claude");
    expect(facts().get("Created")?.textContent).toBe("Oct 1, 6:00 AM");
    expect(facts().get("Updated")?.textContent).toBe("Oct 4, 6:00 AM");
    expect(facts().get("Completed")?.textContent).toBe("Oct 3, 8:00 AM");
    expect(facts().get("Task ID")?.textContent).toBe(taskId(1));
    expect(facts().get("Note")?.textContent).toBe("tasks/write-the-report.md");
    expect(view.container.textContent).not.toMatch(/\/Users\/|[A-Za-z]:\\/);
  });

  it("maps the assignee and makes the parent a button that selects it", () => {
    const onSelectTask = vi.fn();
    const task = detailTask({
      assignee: "automation",
      parent: { id: taskId(3), title: "Parent task" },
    });
    render(<TaskDetail {...props(task, { onSelectTask })} />);
    expect(facts().get("Assignee")?.textContent).toBe("Automation");
    fireEvent.click(button("Parent task"));
    expect(onSelectTask).toHaveBeenCalledWith(taskId(3));
  });
});

describe("Test 3: blocked by", () => {
  it("lists unfinished dependencies as buttons and names an unresolved one by the last six characters", () => {
    const onSelectTask = vi.fn();
    const blockedBy = [
      { resolved: true as const, id: taskId(2), title: "Dep one", status: "ready" as const },
      { resolved: false as const, id: taskId(7) },
    ];
    render(<TaskDetail {...props(detailTask({ blockedBy }), { onSelectTask })} />);
    const dep = button(/Dep one/);
    expect(dep.textContent).toContain("Ready");
    fireEvent.click(dep);
    expect(onSelectTask).toHaveBeenCalledWith(taskId(2));
    expect(facts().get("Blocked by")?.textContent).toContain(
      "A task this depends on can't be found (000007)",
    );
  });

  it("says so when a task is marked blocked with no dependencies listed", () => {
    render(<TaskDetail {...props(detailTask({ status: "blocked" }))} />);
    expect(facts().get("Blocked by")?.textContent).toContain(
      "Marked blocked with no dependencies listed.",
    );
  });
});

describe("Test 4: dirty state", () => {
  it("enables Save and Revert only while a field differs, shows Unsaved changes and reverts", async () => {
    const onDirtyChange = vi.fn();
    render(<TaskDetail {...props(detailTask(), { onDirtyChange })} />);
    expect(button("Save changes").getAttribute("aria-disabled")).toBe("true");
    expect(button("Revert changes").getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByText("Unsaved changes")).toBeNull();

    edit("Title", "A different title");
    await waitFor(() => expect(button("Save changes").getAttribute("aria-disabled")).toBeNull());
    expect(button("Revert changes").getAttribute("aria-disabled")).toBeNull();
    expect(text("Unsaved changes").classList.contains("ccc-task-dirty")).toBe(true);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(button("Revert changes"));
    await waitFor(() => expect(field("Title").value).toBe("Write the report"));
    expect(button("Save changes").getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("is not dirty again when the same value is typed back", async () => {
    render(<TaskDetail {...props(detailTask())} />);
    edit("Priority", "low");
    fireEvent.change(field("Priority"), { target: { value: "low" } });
    await waitFor(() => text("Unsaved changes"));
    fireEvent.change(field("Priority"), { target: { value: "high" } });
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
  });
});

describe("Test 5: discard guard", () => {
  it("replaces the actions with an inline confirmation focused on Keep editing", async () => {
    const onLeaveDecision = vi.fn();
    const base = props(detailTask(), { onLeaveDecision });
    const view = render(<TaskDetail {...base} />);
    edit("Title", "Changed");
    await waitFor(() => text("Unsaved changes"));
    view.rerender(<TaskDetail {...base} leaveRequest />);
    text('Discard changes to "Write the report"?');
    expect(screen.queryByRole("group", { name: "Task actions" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button("Keep editing")));

    fireEvent.keyDown(button("Keep editing"), { key: "Escape" });
    expect(onLeaveDecision).toHaveBeenLastCalledWith("keep");
    view.rerender(<TaskDetail {...base} leaveRequest={false} />);
    expect(field("Title").value).toBe("Changed");
    expect(screen.queryByRole("group", { name: "Task actions" })).not.toBeNull();

    view.rerender(<TaskDetail {...base} leaveRequest />);
    fireEvent.click(button("Discard changes"));
    expect(onLeaveDecision).toHaveBeenLastCalledWith("discard");
  });
});

describe("Test 6: save", () => {
  it("sends only the changed fields with the content the form started from and reports Saving then Saved", async () => {
    const pending = deferred<TaskDetailResult>();
    const onSave = vi.fn(() => pending.promise);
    const onStatus = vi.fn();
    const task = detailTask();
    render(<TaskDetail {...props(task, { onSave, onStatus })} />);
    edit("Title", "New title");
    fireEvent.change(field("Priority"), { target: { value: "low" } });
    await waitFor(() => expect(button("Save changes").getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button("Save changes"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ title: "New title", priority: "low" }, task.content);
    expect(onStatus).toHaveBeenCalledWith("Saving…");
    pending.resolve(APPLIED);
    await waitFor(() => expect(onStatus).toHaveBeenLastCalledWith("Saved."));
  });

  it("validates before sending: an empty title shows Enter a title. and nothing is sent", async () => {
    const onSave = vi.fn(() => Promise.resolve(APPLIED));
    render(<TaskDetail {...props(detailTask(), { onSave })} />);
    edit("Title", "   ");
    await waitFor(() => expect(button("Save changes").getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button("Save changes"));
    await waitFor(() => text("Enter a title."));
    expect(field("Title").getAttribute("aria-invalid")).toBe("true");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows the conflict line with Reload task, keeps the typed edits and offers no force save", async () => {
    const onSave = vi.fn(() => Promise.resolve<TaskDetailResult>({ kind: "conflict" }));
    render(<TaskDetail {...props(detailTask(), { onSave })} />);
    edit("Title", "My edit");
    await waitFor(() => expect(button("Save changes").getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button("Save changes"));
    await waitFor(() =>
      text(
        "▲ This task changed in its note while you were editing. Reload it to see the latest, then make your change again.",
      ),
    );
    button("Reload task");
    expect(field("Title").value).toBe("My edit");
    for (const control of screen.getAllByRole("button")) {
      expect(control.textContent).not.toMatch(/force|overwrite|anyway|replace the note/i);
    }
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ kind: "missing" } as const, "the note is no longer in the vault"],
    [{ kind: "unreadable" } as const, "the note's metadata couldn't be read"],
  ])("names a fixed reason for %j and does not retry", async (result, reason) => {
    const onSave = vi.fn(() => Promise.resolve<TaskDetailResult>(result));
    render(<TaskDetail {...props(detailTask(), { onSave })} />);
    edit("Title", "My edit");
    await waitFor(() => expect(button("Save changes").getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button("Save changes"));
    await waitFor(() => text(`▲ Couldn't save the task: ${reason}.`));
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe("Test 7: the note changed outside the form", () => {
  it("warns while edits are unsaved, saves against the original content and reloads on request", async () => {
    const onSave = vi.fn(() => Promise.resolve<TaskDetailResult>({ kind: "conflict" }));
    const onReload = vi.fn(() => Promise.resolve());
    const original = detailTask();
    const base = props(original, { onSave, onReload });
    const view = render(<TaskDetail {...base} />);
    edit("Description", "My description");
    await waitFor(() => text("Unsaved changes"));

    const outside = detailTask({ title: "Changed outside", content: "outside content" });
    view.rerender(<TaskDetail {...base} task={outside} />);
    await waitFor(() =>
      text("The note changed outside this form. Saving will ask you to reload first."),
    );
    expect((field("Description") as HTMLTextAreaElement).value).toBe("My description");

    fireEvent.click(button("Save changes"));
    expect(onSave).toHaveBeenCalledWith({ description: "My description" }, original.content);

    await waitFor(() => button("Reload task"));
    fireEvent.click(button("Reload task"));
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    view.rerender(<TaskDetail {...base} task={outside} />);
    await waitFor(() => expect(field("Title").value).toBe("Changed outside"));
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(
      screen.queryByText(
        "The note changed outside this form. Saving will ask you to reload first.",
      ),
    ).toBeNull();
  });

  it("silently follows a clean form when the note changes", async () => {
    const base = props(detailTask());
    const view = render(<TaskDetail {...base} />);
    view.rerender(<TaskDetail {...base} task={detailTask({ title: "Fresh title" })} />);
    await waitFor(() => expect(field("Title").value).toBe("Fresh title"));
  });
});

describe("Test 8: state actions", () => {
  it("offers Mark done on an open task and calls the action once", async () => {
    const pending = deferred<TaskDetailResult>();
    const onAction = vi.fn(() => pending.promise);
    render(<TaskDetail {...props(detailTask(), { onAction })} />);
    expect(screen.queryByRole("button", { name: "Reopen task" })).toBeNull();
    fireEvent.click(button("Mark done"));
    fireEvent.click(button("Mark done"));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith("mark-done");
    await waitFor(() => expect(button("Mark done").getAttribute("aria-busy")).toBe("true"));
    pending.resolve(APPLIED);
    await waitFor(() => expect(button("Mark done").getAttribute("aria-busy")).toBeNull());
  });

  it("offers Reopen task on a done or cancelled task", () => {
    const onAction = vi.fn(() => Promise.resolve(APPLIED));
    render(<TaskDetail {...props(detailTask({ status: "done" }), { onAction })} />);
    expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
    fireEvent.click(button("Reopen task"));
    expect(onAction).toHaveBeenCalledWith("reopen");
  });

  it("offers Accept task and Dismiss task on a proposed task, states the suggestion rule and notices the outcome", async () => {
    const onAction = vi.fn(() => Promise.resolve(APPLIED));
    const onNotice = vi.fn();
    render(<TaskDetail {...props(suggestedTask(), { onAction, onNotice })} />);
    expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
    text("Suggestions are not approval requests. Accepting or dismissing only changes this note.");
    fireEvent.click(button("Accept task"));
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith('Accepted "Write the report". It\'s now ready.'),
    );
    fireEvent.click(button("Dismiss task"));
    expect(onAction).toHaveBeenLastCalledWith("dismiss");
    await waitFor(() =>
      expect(onNotice).toHaveBeenLastCalledWith(
        'Dismissed "Write the report". It\'s kept under All as cancelled.',
      ),
    );
  });

  it("reports a failed action with a fixed reason and leaves the task alone", async () => {
    const onAction = vi.fn(() => Promise.resolve<TaskDetailResult>({ kind: "conflict" }));
    const onStatus = vi.fn();
    render(<TaskDetail {...props(suggestedTask(), { onAction, onStatus })} />);
    fireEvent.click(button("Accept task"));
    await waitFor(() =>
      expect(onStatus).toHaveBeenLastCalledWith(
        "Couldn't accept the task: the note changed while you were editing.",
      ),
    );
  });

  it("says the source is untouched only when the source is not manual", () => {
    const line = "Marking this done changes only this note. The source isn't touched.";
    const manual = render(<TaskDetail {...props(detailTask())} />);
    expect(screen.queryByText(line)).toBeNull();
    manual.unmount();
    render(<TaskDetail {...props(detailTask({ sourceType: "email" }))} />);
    text(line);
  });
});

describe("Test 9: provenance", () => {
  it("shows who suggested a proposed task, the badges and a dashed Provided by block around the description", () => {
    const view = render(<TaskDetail {...props(suggestedTask())} />);
    text("Suggested by weekly-digest");
    expect(text("AI-generated").classList.contains("ccc-badge")).toBe(true);
    expect(text("Confidence: unverified").classList.contains("ccc-badge")).toBe(true);
    const block = view.container.querySelector('.ccc-task-block[data-origin="requester"]');
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain("Provided by weekly-digest");
    expect(block?.contains(field("Description"))).toBe(true);
  });

  it("caps the generated-by label at 64 characters", () => {
    render(<TaskDetail {...props(suggestedTask({ generatedByLabel: "g".repeat(100) }))} />);
    text(`Suggested by ${"g".repeat(64)}…`);
  });

  it("shows none of it for a manual task", () => {
    const view = render(<TaskDetail {...props(detailTask())} />);
    expect(screen.queryByText(/Suggested by/)).toBeNull();
    expect(screen.queryByText("AI-generated")).toBeNull();
    expect(screen.queryByText(/Provided by/)).toBeNull();
    expect(view.container.querySelector("[data-origin]")).toBeNull();
  });
});

describe("Test 10: disconnected and Open note", () => {
  it("disables every service-backed control with the standard reason and keeps Open note enabled", async () => {
    const onOpenNote = vi.fn();
    const onSave = vi.fn(() => Promise.resolve<TaskDetailResult>({ kind: "conflict" }));
    const onAction = vi.fn(() => Promise.resolve(APPLIED));
    const base = props(suggestedTask(), { onOpenNote, onSave, onAction });
    const view = render(<TaskDetail {...base} />);
    edit("Title", "Typed");
    await waitFor(() => expect(button("Save changes").getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button("Save changes"));
    await waitFor(() => button("Reload task"));

    view.rerender(<TaskDetail {...base} connected={false} />);
    await waitFor(() => expect(button("Save changes").getAttribute("aria-disabled")).toBe("true"));
    for (const name of ["Save changes", "Accept task", "Dismiss task", "Reload task"]) {
      const control = button(name);
      expect(control.getAttribute("aria-disabled"), name).toBe("true");
      expect(control.hasAttribute("disabled"), name).toBe(false);
      const reason = document.getElementById(control.getAttribute("aria-describedby") ?? "");
      expect(reason?.textContent, name).toBe("The companion service isn't running.");
    }
    fireEvent.click(button("Accept task"));
    fireEvent.click(button("Save changes"));
    expect(onAction).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledTimes(1);

    expect(button("Open note").getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(button("Open note"));
    expect(onOpenNote).toHaveBeenCalledWith("tasks/write-the-report.md");
  });
});

describe("Test 12: hostile text", () => {
  it("renders every hostile string as a literal text node", () => {
    for (const hostile of HOSTILE_TASK_TITLES) {
      const task = suggestedTask({
        title: hostile === "" ? "x" : hostile,
        description: hostile,
        tags: ["safe"],
        generatedByLabel: hostile === "" ? null : hostile,
        sourceLink: hostile === "" ? null : hostile,
        scopeLabel: hostile === "" ? "Global" : hostile,
        parent: { id: taskId(3), title: hostile === "" ? null : hostile },
      });
      const view = render(<TaskDetail {...props(task)} />);
      expect(
        view.container.querySelector("script, img, style, a, iframe, svg"),
        hostile,
      ).toBeNull();
      const heading = screen.queryByRole("heading", { level: 3 });
      expect(heading?.textContent, hostile).toBe(task.title);
      view.unmount();
    }
  });

  it("keeps a hostile project id out of the selectable projects", () => {
    render(<TaskDetail {...props(detailTask({ projectId: projectIdFor(1) }))} />);
    expect((field("Project") as HTMLSelectElement).value).toBe(projectIdFor(1));
  });
});
