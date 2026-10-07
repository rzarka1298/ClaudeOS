import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureTaskActionsPort } from "../tasks/actions-port.js";
import { configureTasksApi } from "../tasks/api.js";
import { createTasksContext } from "../tasks/contexts.js";
import { resetTasksGeneration, tasksGeneration } from "../tasks/events.js";
import { TASK_NOW_MS, TASK_ZONE, taskRows } from "../test-support/task-view-fixtures.js";
import { fakeTasksApi } from "../test-support/tasks-api-fake.js";
import { consumeTaskFormRequest, taskFormRequested } from "./navigation-request.js";
import { TasksDestination } from "./tasks.js";
import { createTasksViewState, type TasksViewState } from "./tasks-view-state.js";

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
