import {
  EMPTY_PROJECTS_SNAPSHOT,
  newProjectId,
  type ProjectId,
  type ProjectView,
} from "@ccc/domain";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectActionOutcome, ProjectsActions } from "../projects/projects-actions.js";
import { projectsSnapshot, resetProjectsState } from "../projects/projects-state.js";
import { resetScanState } from "../projects/scan-state.js";
import { configureTaskActionsPort, type TaskActionsPort } from "../tasks/actions-port.js";
import { parseTaskContent } from "../tasks/task-update.js";
import { OPEN_NOTE } from "../test-support/task-note-fixtures.js";
import { configureTasksApi } from "../tasks/api.js";
import {
  contextSnapshot,
  createProjectTasksContext,
  createTasksContext,
} from "../tasks/contexts.js";
import { TASK_NOW_MS, TASK_ZONE, taskRows } from "../test-support/task-view-fixtures.js";
import { fakeTasksApi } from "../test-support/tasks-api-fake.js";
import { ProjectTasksPanel } from "./project-tasks.js";
import { ProjectsView } from "./projects-view.js";
import { TasksDestination } from "./tasks.js";
import { createTasksViewState } from "./tasks-view-state.js";

afterEach(() => {
  cleanup();
  resetProjectsState();
  resetScanState();
  configureTasksApi(null);
  configureTaskActionsPort(null);
});

function noopActions(): ProjectsActions {
  const notCalled: () => Promise<ProjectActionOutcome> = () =>
    Promise.reject(new Error("not expected"));
  return {
    register: notCalled,
    remove: notCalled,
    rename: notCalled,
    pin: notCalled,
    setGithubLink: notCalled,
    refresh: notCalled,
  };
}

function view(projectId: ProjectId, displayName: string): ProjectView {
  return {
    projectId,
    displayName,
    displayPath: "~/code/example",
    pinned: false,
    lastOpenedAt: null,
    observedAt: null,
    gitReadFailed: false,
    git: { kind: "pending" },
    github: { kind: "none" },
  };
}

let first: ProjectId;
let second: ProjectId;
beforeEach(() => {
  first = newProjectId();
  second = newProjectId();
  projectsSnapshot.value = {
    projects: [view(first, "example-project"), view(second, "sample-notes")],
    launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
  };
});

function mountProjects() {
  const api = fakeTasksApi(taskRows(3));
  configureTasksApi(api);
  const result = render(
    <ProjectsView
      actions={noopActions()}
      pickFolder={() => Promise.resolve({ kind: "unavailable" })}
      connection={{ kind: "live" }}
      now={TASK_NOW_MS}
    />,
  );
  return { api, ...result };
}

describe("Test 1: the entry", () => {
  it("gives each card a Show tasks button outside both roving toolbars, before the footer", () => {
    mountProjects();
    const button = screen.getByRole("button", { name: "Show tasks for example-project" });
    expect(screen.getByRole("button", { name: "Show tasks for sample-notes" })).toBeTruthy();
    expect(button.textContent).toBe("Show tasks");
    expect(button.closest('[role="toolbar"]')).toBeNull();
    const card = button.closest("article") as HTMLElement;
    const footer =
      card.querySelector(".ccc-card-footer, .ccc-widget-footer") ?? card.lastElementChild;
    expect(
      (button.compareDocumentPosition(footer as Node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 ||
        footer === button,
    ).toBe(true);
    expect(within(card).getByText(/Next task unavailable/)).toBeTruthy();
  });
});

describe("Test 2 and 3: the panel", () => {
  it("opens under the grid with its heading focused, seven chips, default All and no Scope select", async () => {
    const { api } = mountProjects();
    fireEvent.click(screen.getByRole("button", { name: "Show tasks for example-project" }));
    const heading = await screen.findByRole("heading", { name: "Tasks · example-project" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const panel = document.querySelector(".ccc-project-tasks") as HTMLElement;
    expect(panel.previousElementSibling?.className ?? "").toContain("ccc-projects-grid");
    const chips = within(panel).getAllByRole("button", { name: /, \d+ tasks?$/ });
    expect(chips.map((chip) => chip.getAttribute("data-filter"))).toEqual([
      "all",
      "today",
      "upcoming",
      "overdue",
      "proposed",
      "blocked",
      "completed",
    ]);
    expect(chips[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(within(panel).queryByLabelText("Scope")).toBeNull();
    await waitFor(() =>
      expect(api.list.mock.calls[0]?.[0]).toMatchObject({
        filter: "all",
        context: { scope: "all", projectId: first },
      }),
    );
  });

  it("preselects the project in its create form and keeps Scope editable", async () => {
    mountProjects();
    fireEvent.click(screen.getByRole("button", { name: "Show tasks for example-project" }));
    const panel = (await screen.findByRole("heading", { name: "Tasks · example-project" })).closest(
      ".ccc-project-tasks",
    ) as HTMLElement;
    fireEvent.click(within(panel).getByRole("button", { name: "Create a task" }));
    const project = await within(panel).findByLabelText("Project");
    expect("value" in project && project.value).toBe(first);
    expect(within(panel).getByLabelText("Scope")).toBeTruthy();
  });

  it("keeps one panel open at a time and returns focus to the originating button on Close and Escape", async () => {
    mountProjects();
    const showFirst = screen.getByRole("button", { name: "Show tasks for example-project" });
    fireEvent.click(showFirst);
    await screen.findByRole("heading", { name: "Tasks · example-project" });
    fireEvent.click(screen.getByRole("button", { name: "Show tasks for sample-notes" }));
    await screen.findByRole("heading", { name: "Tasks · sample-notes" });
    expect(document.querySelectorAll(".ccc-project-tasks")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Close project tasks" }));
    await waitFor(() => expect(document.querySelector(".ccc-project-tasks")).toBeNull());
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Show tasks for sample-notes" }),
    );
    fireEvent.click(showFirst);
    const heading = await screen.findByRole("heading", { name: "Tasks · example-project" });
    fireEvent.keyDown(heading, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".ccc-project-tasks")).toBeNull());
    expect(document.activeElement).toBe(showFirst);
  });

  it("lets Escape close an open create form without closing the panel", async () => {
    mountProjects();
    fireEvent.click(screen.getByRole("button", { name: "Show tasks for example-project" }));
    const panel = (await screen.findByRole("heading", { name: "Tasks · example-project" })).closest(
      ".ccc-project-tasks",
    ) as HTMLElement;
    fireEvent.click(within(panel).getByRole("button", { name: "Create a task" }));
    fireEvent.keyDown(await within(panel).findByLabelText("Title"), { key: "Escape" });
    await waitFor(() => expect(within(panel).queryByLabelText("Title")).toBeNull());
    expect(document.querySelector(".ccc-project-tasks")).not.toBeNull();
  });
});

describe("Test 4: independence (TASK-07)", () => {
  function snapshotOf(
    context: ReturnType<typeof createTasksContext>,
    state: ReturnType<typeof createTasksViewState>,
  ): unknown {
    return JSON.parse(
      JSON.stringify({
        context: contextSnapshot(context),
        formOpen: state.formOpen.value,
        status: state.status.value,
        detail: state.detail.value,
        dirty: state.dirty.value,
        leave: state.leaveRequest.value,
      }),
    );
  }

  it("leaves a full snapshot of each context unchanged by operating the other", async () => {
    configureTasksApi(fakeTasksApi(taskRows(3)));
    const globalContext = createTasksContext("global", { zone: () => TASK_ZONE });
    const globalView = createTasksViewState();
    const projectContext = createProjectTasksContext(first, { zone: () => TASK_ZONE });
    const projectView = createTasksViewState();
    render(
      <>
        <TasksDestination
          connection={{ kind: "live" }}
          now={TASK_NOW_MS}
          zone={TASK_ZONE}
          context={globalContext}
          view={globalView}
          projects={[{ id: first, name: "example-project" }]}
          workspaces={[]}
        />
        <ProjectTasksPanel
          projectId={first}
          projectName="example-project"
          connection={{ kind: "live" }}
          now={TASK_NOW_MS}
          zone={TASK_ZONE}
          context={projectContext}
          view={projectView}
          projects={[{ id: first, name: "example-project" }]}
          workspaces={[]}
          onClose={() => undefined}
        />
      </>,
    );
    const globalRoot = document.querySelector(".ccc-tasks") as HTMLElement;
    const panelRoot = document.querySelector(".ccc-project-tasks") as HTMLElement;
    await waitFor(() =>
      expect(within(globalRoot).getAllByText("Task 1").length).toBeGreaterThan(0),
    );
    await waitFor(() => expect(within(panelRoot).getAllByText("Task 1").length).toBeGreaterThan(0));

    const globalBefore = snapshotOf(globalContext, globalView);
    await act(async () => {
      fireEvent.click(within(panelRoot).getByRole("button", { name: /^Overdue/ }));
      fireEvent.click(within(panelRoot).getByText("Task 2"));
      fireEvent.click(within(panelRoot).getByRole("button", { name: "Create a task" }));
    });
    await waitFor(() => expect(projectContext.filter.value).toBe("overdue"));
    expect(projectContext.selectedTaskId.value).not.toBeNull();
    expect(projectView.formOpen.value).toBe(true);
    expect(snapshotOf(globalContext, globalView)).toEqual(globalBefore);

    const projectBefore = snapshotOf(projectContext, projectView);
    await act(async () => {
      fireEvent.click(within(globalRoot).getByRole("button", { name: /^Upcoming/ }));
      fireEvent.change(within(globalRoot).getByLabelText("Scope"), { target: { value: "global" } });
      fireEvent.click(within(globalRoot).getByText("Task 3"));
    });
    await waitFor(() => expect(globalContext.scope.value).toBe("global"));
    expect(globalContext.filter.value).toBe("upcoming");
    expect(snapshotOf(projectContext, projectView)).toEqual(projectBefore);
  });

  it("makes two panels over time share nothing", async () => {
    configureTasksApi(fakeTasksApi(taskRows(2)));
    const a = createProjectTasksContext(first, { zone: () => TASK_ZONE });
    const b = createProjectTasksContext(second, { zone: () => TASK_ZONE });
    await a.setFilter("overdue");
    a.select("x");
    expect(contextSnapshot(b)).toMatchObject({
      filter: "all",
      selectedTaskId: null,
      projectId: second,
    });
    vi.restoreAllMocks();
  });
});

describe("wave-6: the dirty guard on the project panel", () => {
  async function dirtyProjectPanel() {
    const api = fakeTasksApi(taskRows(3), {
      get: vi.fn(() =>
        Promise.resolve({
          task: {
            row: taskRows(1)[0] as ReturnType<typeof taskRows>[number],
            path: "global/tasks/example-task-3f2a.md",
            createdAt: "2026-10-01T10:00:00.000Z",
            sourceType: "manual" as const,
            blockedBy: [],
            aiGenerated: false,
            confidence: "unverified" as const,
          },
        }),
      ),
    });
    configureTasksApi(api);
    const applied = () =>
      Promise.resolve({
        kind: "applied" as const,
        content: OPEN_NOTE,
        task: {} as never,
        notified: true,
      });
    const port: TaskActionsPort = {
      complete: vi.fn(applied),
      reopen: vi.fn(applied),
      accept: vi.fn(applied),
      dismiss: vi.fn(applied),
      save: vi.fn(applied),
      readForEdit: vi.fn(() => Promise.resolve(parseTaskContent(OPEN_NOTE))),
      openNote: vi.fn(),
    };
    configureTaskActionsPort(port);
    render(
      <ProjectsView
        actions={noopActions()}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        connection={{ kind: "live" }}
        now={TASK_NOW_MS}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show tasks for example-project" }));
    const panel = (await screen.findByRole("heading", { name: "Tasks · example-project" })).closest(
      ".ccc-project-tasks",
    ) as HTMLElement;
    fireEvent.click(await within(panel).findByText("Task 1"));
    const title = await within(panel).findByLabelText("Title");
    fireEvent.input(title, { target: { value: "Changed title" } });
    await waitFor(() => expect(within(panel).getByText(/unsaved/i)).toBeTruthy());
    return { panel, title };
  }

  it("asks before Close project tasks discards unsaved edits, and keeps them on Keep editing", async () => {
    const { panel } = await dirtyProjectPanel();
    fireEvent.click(screen.getByRole("button", { name: "Close project tasks" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(document.querySelector(".ccc-project-tasks")).not.toBeNull();
    expect((within(panel).getByLabelText("Title") as HTMLInputElement).value).toBe("Changed title");
    fireEvent.click(screen.getByRole("button", { name: "Close project tasks" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(document.querySelector(".ccc-project-tasks")).toBeNull());
  });

  it("does not close the panel from Escape inside the title field", async () => {
    const { title } = await dirtyProjectPanel();
    fireEvent.keyDown(title, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector(".ccc-project-tasks")).not.toBeNull();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Changed title");
  });

  it("asks before switching to another project's panel", async () => {
    const { panel } = await dirtyProjectPanel();
    fireEvent.click(screen.getByRole("button", { name: "Show tasks for sample-notes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("heading", { name: "Tasks · sample-notes" })).toBeNull();
    expect((within(panel).getByLabelText("Title") as HTMLInputElement).value).toBe("Changed title");
    fireEvent.click(screen.getByRole("button", { name: "Show tasks for sample-notes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    await screen.findByRole("heading", { name: "Tasks · sample-notes" });
  });
});
