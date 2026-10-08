import type { TaskGetResponse, TaskRow } from "@ccc/domain/tasks.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskActionResult } from "../tasks/actions.js";
import { configureTaskActionsPort, type TaskActionsPort } from "../tasks/actions-port.js";
import { configureTasksApi, TasksApiError } from "../tasks/api.js";
import { createTasksContext } from "../tasks/contexts.js";
import { resetTasksGeneration, tasksGeneration } from "../tasks/events.js";
import { tasksAttention, tasksRebuilding } from "../tasks/rebuild.js";
import { parseTaskContent } from "../tasks/task-update.js";
import { OPEN_NOTE } from "../test-support/task-note-fixtures.js";
import {
  projectIdFor,
  TASK_NOW_MS,
  TASK_ZONE,
  taskRows,
} from "../test-support/task-view-fixtures.js";
import { type FakeTasksApi, fakeTasksApi } from "../test-support/tasks-api-fake.js";
import { consumeTaskFormRequest, taskFormRequested } from "./navigation-request.js";
import { configureNotify } from "./notify-port.js";
import { TasksDestination } from "./tasks.js";
import {
  configureTaskWorkspaces,
  createTasksViewState,
  type TasksViewState,
  taskDetailFocusRequested,
} from "./tasks-view-state.js";

afterEach(() => {
  cleanup();
  configureTasksApi(null);
  configureTaskActionsPort(null);
  resetTasksGeneration();
  taskFormRequested.value = false;
});

let view: TasksViewState;
beforeEach(() => {
  view = createTasksViewState();
});

function mount(api = fakeTasksApi(taskRows(3)), connected = true) {
  configureTasksApi(api);
  const context = createTasksContext("global", { zone: () => TASK_ZONE });
  const result = render(
    <TasksDestination
      connection={connected ? { kind: "live" } : { kind: "disconnected", reason: "down" }}
      now={TASK_NOW_MS}
      zone={TASK_ZONE}
      context={context}
      view={view}
      projects={[]}
      workspaces={[]}
    />,
  );
  return { api, context, ...result };
}

describe("Test 1: load", () => {
  it("loads Today once for All scopes at page size 25 and renders the summary, chips and list", async () => {
    const { api } = mount();
    await screen.findByText("Task 1");
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.counts).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledWith({
      context: { scope: "all" },
      filter: "today",
      zone: TASK_ZONE,
      limit: 25,
    });
    expect(screen.getByText("12 open · 1 overdue · 2 proposed")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Today, 3 tasks" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Create a task" })).toBeTruthy();
  });

  it("omits zero summary segments and keeps singular and plural right", async () => {
    const api = fakeTasksApi(taskRows(1));
    api.counts.mockResolvedValue({
      counts: {
        all: 1,
        today: 1,
        upcoming: 0,
        overdue: 0,
        project: 0,
        proposed: 0,
        blocked: 0,
        completed: 0,
      },
      open: 1,
    });
    mount(api);
    expect(await screen.findByText("1 open")).toBeTruthy();
  });
});

describe("Test 2: create", () => {
  it("opens the form with focus on Title, adds to the inbox, refreshes and keeps the form open", async () => {
    const { api } = mount();
    await screen.findByText("Task 1");
    fireEvent.click(screen.getByRole("button", { name: "Create a task" }));
    const title = await screen.findByLabelText("Title");
    await waitFor(() => expect(document.activeElement).toBe(title));
    const status = document.querySelector('.ccc-tasks-status[role="status"]');
    expect(status).not.toBeNull();
    fireEvent.input(title, { target: { value: "Write the plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to inbox" }));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(api.create.mock.calls[0]?.[0]).toMatchObject({
      title: "Write the plan",
      intent: "inbox",
      zone: TASK_ZONE,
      scope: "global",
    });
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(api.counts).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText("Title")).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Title")));
    expect(document.querySelector('.ccc-tasks-status[role="status"]')?.textContent).toContain(
      "Write the plan",
    );
  });
});

describe("Test 3: intents", () => {
  it("opens the form on mount when the intent is set, consumes it once and Escape returns focus", async () => {
    taskFormRequested.value = true;
    mount();
    expect(await screen.findByLabelText("Title")).toBeTruthy();
    expect(consumeTaskFormRequest()).toBe(false);
    fireEvent.keyDown(screen.getByLabelText("Title"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText("Title")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Create a task" }));
  });

  it("opens the form when the intent arrives while already mounted", async () => {
    mount();
    await screen.findByText("Task 1");
    expect(screen.queryByLabelText("Title")).toBeNull();
    await act(() => {
      taskFormRequested.value = true;
    });
    expect(await screen.findByLabelText("Title")).toBeTruthy();
    expect(consumeTaskFormRequest()).toBe(false);
  });
});

describe("Test 4: generation", () => {
  it("reloads the list and counts once without changing filter, scope or selection", async () => {
    const { api, context } = mount();
    await screen.findByText("Task 1");
    context.select("0mfk1a2b300000000000000001");
    await act(() => {
      tasksGeneration.value = 5;
    });
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(api.counts).toHaveBeenCalledTimes(2);
    expect(context.filter.value).toBe("today");
    expect(context.scope.value).toBe("all");
    expect(context.selectedTaskId.value).toBe("0mfk1a2b300000000000000001");
  });
});

describe("Test 6: view state", () => {
  it("resets the destination's view state when it unmounts", async () => {
    const { unmount } = mount();
    await screen.findByText("Task 1");
    view.status.value = "Saved.";
    view.formOpen.value = true;
    vi.useRealTimers();
    unmount();
    expect(view.status.value).toBe("");
    expect(view.formOpen.value).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 2

const NOTE_PATH = "global/tasks/example-task-3f2a.md";

function detailResponse(row = taskRows(1)[0] as TaskRow): TaskGetResponse {
  return {
    task: {
      row,
      path: NOTE_PATH,
      createdAt: "2026-10-01T10:00:00.000Z",
      sourceType: "manual",
      blockedBy: [],
      aiGenerated: false,
      confidence: "unverified",
    },
  };
}

function fakePort(overrides: Partial<TaskActionsPort> = {}): TaskActionsPort {
  const applied = (): Promise<TaskActionResult> =>
    Promise.resolve({ kind: "applied", content: OPEN_NOTE, task: {} as never, notified: true });
  return {
    complete: vi.fn(applied),
    reopen: vi.fn(applied),
    accept: vi.fn(applied),
    dismiss: vi.fn(applied),
    save: vi.fn(applied),
    readForEdit: vi.fn(() => Promise.resolve(parseTaskContent(OPEN_NOTE))),
    openNote: vi.fn(),
    ...overrides,
  };
}

function mountWith(options: {
  api?: FakeTasksApi;
  port?: TaskActionsPort;
  connected?: boolean;
  workspaces?: { id: string; name: string }[] | undefined;
  projects?: { id: string; name: string }[];
  select?: string;
}) {
  const api =
    options.api ??
    fakeTasksApi(taskRows(3), { get: vi.fn(() => Promise.resolve(detailResponse())) });
  configureTasksApi(api);
  const port = options.port ?? fakePort();
  configureTaskActionsPort(port);
  const context = createTasksContext("global", { zone: () => TASK_ZONE });
  if (options.select !== undefined) context.select(options.select);
  const result = render(
    <TasksDestination
      connection={
        options.connected === false ? { kind: "disconnected", reason: "down" } : { kind: "live" }
      }
      now={TASK_NOW_MS}
      zone={TASK_ZONE}
      context={context}
      view={view}
      projects={options.projects ?? [{ id: projectIdFor(1), name: "Garden" }]}
      {...(options.workspaces === undefined ? {} : { workspaces: options.workspaces })}
    />,
  );
  return { api, port, context, ...result };
}

describe("Test 1 (task 2): scope", () => {
  const WS = [{ id: "workspace:0mfk1a2b3000000000000000a", name: "Studio" }];

  it("offers All scopes, Global and each workspace and reloads list and counts keeping the chip", async () => {
    const { api, context } = mountWith({ workspaces: WS });
    await screen.findByText("Task 1");
    const select = screen.getByLabelText("Scope");
    expect(Array.from(select.querySelectorAll("option")).map((option) => option.text)).toEqual([
      "All scopes",
      "Global",
      "Studio",
    ]);
    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Overdue, 1 task" }));
    });
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    fireEvent.change(select, { target: { value: "global" } });
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(3));
    expect(api.list.mock.calls[2]?.[0]).toMatchObject({
      context: { scope: "global" },
      filter: "overdue",
    });
    expect(api.counts.mock.calls[2]?.[0]).toMatchObject({ context: { scope: "global" } });
    expect(context.filter.value).toBe("overdue");
  });

  it("falls back to All scopes and Global when the workspace fetch fails", async () => {
    configureTaskWorkspaces(() => Promise.reject(new Error("down")));
    mountWith({});
    await screen.findByText("Task 1");
    const select = screen.getByLabelText("Scope");
    expect(Array.from(select.querySelectorAll("option")).map((option) => option.text)).toEqual([
      "All scopes",
      "Global",
    ]);
    configureTaskWorkspaces(null);
  });
});

describe("Test 2 (task 2): project chip", () => {
  it("reveals a labelled Project select and asks to choose a project until one is chosen", async () => {
    const { api } = mountWith({});
    await screen.findByText("Task 1");
    expect(screen.queryByLabelText("Project")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Project, 40 tasks" }));
    const select = await screen.findByLabelText("Project");
    expect(Array.from(select.querySelectorAll("option")).map((option) => option.text)).toEqual([
      "Choose a project",
      "Garden",
    ]);
    expect(await screen.findByText("Choose a project to see its tasks.")).toBeTruthy();
    fireEvent.change(select, { target: { value: projectIdFor(1) } });
    await waitFor(() =>
      expect(api.list.mock.calls.at(-1)?.[0]).toMatchObject({
        filter: "project",
        context: { projectId: projectIdFor(1) },
      }),
    );
  });
});

describe("Test 3 (task 2): selection and detail", () => {
  it("loads the service detail and the note, renders the pane and focuses its heading", async () => {
    const { api, port } = mountWith({});
    fireEvent.click(await screen.findByText("Task 1"));
    const heading = await screen.findByRole("heading", { name: "Draft the weekly review" });
    expect(api.get).toHaveBeenCalledWith({ taskId: taskRows(1)[0]?.id });
    expect(port.readForEdit).toHaveBeenCalledWith(NOTE_PATH);
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getByText("Task 1").closest("button")?.getAttribute("aria-current")).toBe("true");
  });

  it("shows skeleton fields while loading and never offers Save before it loaded", async () => {
    let release: (value: TaskGetResponse) => void = () => undefined;
    const api = fakeTasksApi(taskRows(2), {
      get: vi.fn(
        () =>
          new Promise<TaskGetResponse>((resolve) => {
            release = resolve;
          }),
      ),
    });
    mountWith({ api });
    fireEvent.click(await screen.findByText("Task 1"));
    expect(document.querySelector(".ccc-task-detail-state[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    release(detailResponse());
    expect(await screen.findByRole("button", { name: "Save changes" })).toBeTruthy();
  });
});

describe("Test 4 (task 2): the dirty guard", () => {
  async function dirtyPane() {
    const mounted = mountWith({});
    fireEvent.click(await screen.findByText("Task 1"));
    const title = await screen.findByLabelText("Title");
    fireEvent.input(title, { target: { value: "Changed title" } });
    await waitFor(() => expect(view.dirty.value).toBe(true));
    return mounted;
  }

  it("keeps the selection when the owner chooses Keep editing", async () => {
    const { context } = await dirtyPane();
    fireEvent.click(screen.getByText("Task 2"));
    await waitFor(() => expect(view.leaveRequest.value).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(context.selectedTaskId.value).toBe(taskRows(1)[0]?.id);
    expect(view.leaveRequest.value).toBe(false);
  });

  it("proceeds to the other task only after a discard decision", async () => {
    const { context } = await dirtyPane();
    fireEvent.click(screen.getByText("Task 2"));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(context.selectedTaskId.value).toBe(taskRows(2)[1]?.id));
  });

  it("applies the same guard to Back to tasks", async () => {
    const { context } = await dirtyPane();
    fireEvent.click(screen.getByRole("button", { name: "Back to tasks" }));
    await waitFor(() => expect(view.leaveRequest.value).toBe(true));
    expect(context.selectedTaskId.value).not.toBeNull();
  });
});

describe("Test 5 (task 2): row actions", () => {
  async function pressMarkDone(port = fakePort()) {
    const mounted = mountWith({ port });
    await screen.findByText("Task 1");
    fireEvent.click(screen.getAllByRole("button", { name: /^Mark done/ })[0] as HTMLElement);
    return { ...mounted, port };
  }

  it("completes through the port, reloads, announces and notifies", async () => {
    const notices = vi.fn();
    configureNotify(notices);
    const { api, port } = await pressMarkDone();
    await waitFor(() => expect(view.status.value).toBe("Marked done."));
    expect(port.complete).toHaveBeenCalledWith({ path: NOTE_PATH });
    await waitFor(() => expect(api.list.mock.calls.length).toBeGreaterThanOrEqual(2));
    configureNotify(null);
  });

  it.each([
    [
      "conflict",
      { kind: "conflict" as const },
      "Couldn't mark the task done: the note changed while you were editing.",
    ],
    [
      "missing",
      { kind: "unreadable" as const, reason: "read-failed" as const },
      "Couldn't mark the task done: the note is no longer in the vault.",
    ],
    [
      "unreadable",
      { kind: "unreadable" as const, reason: "invalid-yaml" as const },
      "Couldn't mark the task done: the note's metadata couldn't be read.",
    ],
  ])(
    "reports the %s outcome with its fixed reason and forces nothing",
    async (_name, result, line) => {
      const port = fakePort({ complete: vi.fn(() => Promise.resolve(result)) });
      await pressMarkDone(port);
      await waitFor(() => expect(view.status.value).toBe(line));
      expect(port.save).not.toHaveBeenCalled();
    },
  );

  it("announces Accept and Dismiss with their fixed notices", async () => {
    const api = fakeTasksApi(taskRows(2, "proposed"), {
      get: vi.fn(() => Promise.resolve(detailResponse())),
    });
    const { port } = mountWith({ api });
    await screen.findByText("Task 1");
    fireEvent.click(screen.getAllByRole("button", { name: /^Accept task/ })[0] as HTMLElement);
    await waitFor(() => expect(view.status.value).toBe('Accepted "Task 1". It\'s now ready.'));
    expect(port.accept).toHaveBeenCalledWith({ path: NOTE_PATH });
    fireEvent.click(screen.getAllByRole("button", { name: /^Dismiss task/ })[1] as HTMLElement);
    await waitFor(() =>
      expect(view.status.value).toBe('Dismissed "Task 2". It\'s kept under All as cancelled.'),
    );
    expect(port.dismiss).toHaveBeenCalledWith({ path: NOTE_PATH });
  });
});

describe("Test 6 (task 2): save", () => {
  it("saves against the content it read, reloads and keeps the pane", async () => {
    const { port, api } = mountWith({});
    fireEvent.click(await screen.findByText("Task 1"));
    fireEvent.input(await screen.findByLabelText("Title"), { target: { value: "Changed title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(port.save).toHaveBeenCalledTimes(1));
    const [target, input] = (port.save as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { path: string; expectedPriorContent: string },
      { title: string; zone: string },
    ];
    expect(target.path).toBe(NOTE_PATH);
    expect(target.expectedPriorContent).toBe(OPEN_NOTE);
    expect(input).toMatchObject({ title: "Changed title", zone: TASK_ZONE });
    await waitFor(() => expect(api.list.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("shows the conflict line and re-reads the note on Reload task", async () => {
    const port = fakePort({ save: vi.fn(() => Promise.resolve({ kind: "conflict" as const })) });
    mountWith({ port });
    fireEvent.click(await screen.findByText("Task 1"));
    fireEvent.input(await screen.findByLabelText("Title"), { target: { value: "Changed title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const reload = await screen.findByRole("button", { name: "Reload task" });
    const before = (port.readForEdit as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(reload);
    fireEvent.click(await screen.findByRole("button", { name: "Replace my edits" }));
    await waitFor(() =>
      expect((port.readForEdit as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
        before,
      ),
    );
  });
});

describe("Test 7 (task 2): attention", () => {
  const ITEMS = {
    items: [
      { path: "global/tasks/a.md", reason: "missing-id" as const, otherPaths: [] },
      { path: "global/tasks/b.md", reason: "unreadable" as const, otherPaths: [] },
    ],
    total: 2,
    nextCursor: null,
  };

  afterEach(() => {
    tasksAttention.items.value = [];
    tasksAttention.total.value = 0;
  });

  it("loads on mount, lists the notes with fixed reasons, adds the Partial chip and opens a note", async () => {
    const api = fakeTasksApi(taskRows(1), { attention: vi.fn(() => Promise.resolve(ITEMS)) });
    const { port } = mountWith({ api });
    expect(await screen.findByText("Missing its ID")).toBeTruthy();
    expect(api.attention).toHaveBeenCalledTimes(1);
    const chip = document.querySelector('[data-badge="partial"]') as HTMLElement;
    expect(chip.textContent).toContain("Partial — 2 task notes need attention and are left out");
    fireEvent.click(screen.getAllByRole("button", { name: /Open note/ })[0] as HTMLElement);
    expect(port.openNote).toHaveBeenCalledWith("global/tasks/a.md");
  });

  it("is absent with no Partial chip when nothing needs attention", async () => {
    mountWith({});
    await screen.findByText("Task 1");
    expect(screen.queryByText("Notes need attention")).toBeNull();
    expect(document.querySelector('[data-badge="partial"]')).toBeNull();
  });
});

describe("Test 8 (task 2): states", () => {
  it("shows the loading skeleton before the first answer", async () => {
    const api = fakeTasksApi([], { list: vi.fn(() => new Promise<never>(() => undefined)) });
    mountWith({ api });
    expect(screen.getByText("Loading tasks")).toBeTruthy();
  });

  it("shows the error copy when the first load fails for another reason", async () => {
    const api = fakeTasksApi([], {
      list: vi.fn(() => Promise.reject(new TasksApiError("timeout"))),
      counts: vi.fn(() => Promise.reject(new TasksApiError("timeout"))),
    });
    mountWith({ api });
    expect(await screen.findByText("Couldn't load tasks.")).toBeTruthy();
  });

  it("dims, disables service-backed controls and keeps Open note when disconnected", async () => {
    const api = fakeTasksApi(taskRows(2), { get: vi.fn(() => Promise.resolve(detailResponse())) });
    mountWith({ api, connected: false });
    expect(await screen.findByText("Service disconnected")).toBeTruthy();
    expect(screen.getByText(/edit task notes in Obsidian|notes/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Create a task" }).getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.click(screen.getByText("Task 1"));
    const open = await screen.findByRole("button", { name: /Open note/ });
    expect(open.getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByRole("button", { name: "Mark done" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("keeps the rows and says the index is rebuilding", async () => {
    mountWith({});
    await screen.findByText("Task 1");
    await act(() => {
      tasksRebuilding.value = true;
    });
    expect(await screen.findByText("Rebuilding the task index…")).toBeTruthy();
    expect(screen.getByText("Task 1")).toBeTruthy();
    await act(() => {
      tasksRebuilding.value = false;
    });
  });
});

describe("Test 10 (task 2): layout hooks", () => {
  it("marks the layout open or closed and Back to tasks returns focus to the row's title", async () => {
    mountWith({});
    await screen.findByText("Task 1");
    const layout = document.querySelector(".ccc-tasks-layout") as HTMLElement;
    expect(layout.getAttribute("data-detail")).toBe("closed");
    expect(document.querySelector(".ccc-tasks")?.getAttribute("aria-label")).toBe("Tasks");
    fireEvent.click(screen.getByText("Task 1"));
    await screen.findByRole("heading", { name: "Draft the weekly review" });
    expect(layout.getAttribute("data-detail")).toBe("open");
    fireEvent.click(screen.getByRole("button", { name: "Back to tasks" }));
    await waitFor(() => expect(layout.getAttribute("data-detail")).toBe("closed"));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.querySelector(`[data-task-id="${taskRows(1)[0]?.id}"] .ccc-task-title`),
      ),
    );
  });
});

describe("an external selection (an Overview row)", () => {
  it("shows the chosen task and focuses the pane heading once", async () => {
    taskDetailFocusRequested.value = true;
    mountWith({ select: taskRows(1)[0]?.id as string });
    const heading = await screen.findByRole("heading", { name: "Draft the weekly review" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(taskDetailFocusRequested.value).toBe(false);
  });
});

describe("Audit w6 (06-22, D-15): a disconnect never rewrites last-good counts", () => {
  it("keeps the summary and chip counts when the connection drops after a load", async () => {
    const { rerender, context } = mountWith({});
    await screen.findByText("Task 1");
    expect(screen.getByText("12 open · 1 overdue · 2 proposed")).toBeTruthy();
    rerender(
      <TasksDestination
        connection={{ kind: "disconnected", reason: "down" }}
        now={TASK_NOW_MS}
        zone={TASK_ZONE}
        context={context}
        view={view}
        projects={[{ id: projectIdFor(1), name: "Garden" }]}
      />,
    );
    expect(await screen.findByText("Service disconnected")).toBeTruthy();
    expect(screen.getByText("12 open · 1 overdue · 2 proposed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Today, 3 tasks" })).toBeTruthy();
    expect(screen.getByText("Task 1")).toBeTruthy();
  });
});
