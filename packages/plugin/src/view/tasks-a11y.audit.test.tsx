import { newProjectId } from "@ccc/domain";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureTaskActionsPort, type TaskActionsPort } from "../tasks/actions-port.js";
import { configureTasksApi } from "../tasks/api.js";
import { createProjectTasksContext, createTasksContext } from "../tasks/contexts.js";
import { TASK_NOW_MS, TASK_ZONE, taskRows } from "../test-support/task-view-fixtures.js";
import { fakeTasksApi, listOf } from "../test-support/tasks-api-fake.js";
import { ProjectTasksPanel } from "./project-tasks.js";
import { TasksDestination } from "./tasks.js";
import { createTasksViewState } from "./tasks-view-state.js";

/**
 * Accessibility audit of both Tasks surfaces (plan 06-22; UI-SPEC accessibility
 * floors): tab order, no native disabled attribute, one status region per
 * context, and focus after a row action in both contexts.
 */

afterEach(() => {
  cleanup();
  configureTasksApi(null);
  configureTaskActionsPort(null);
});

const PROJECT = newProjectId();

function appliedPort(): TaskActionsPort {
  const applied = () =>
    Promise.resolve({ kind: "applied" as const, content: "", task: {} as never, notified: true });
  return {
    complete: vi.fn(applied),
    reopen: vi.fn(applied),
    accept: vi.fn(applied),
    dismiss: vi.fn(applied),
    save: vi.fn(applied),
    readForEdit: vi.fn(() => Promise.reject(new Error("unused"))),
    openNote: vi.fn(),
  };
}

function mountBoth(connected = true) {
  const rows = taskRows(3);
  let calls = 0;
  const api = fakeTasksApi(rows, {
    list: vi.fn(() => {
      calls += 1;
      // After the first load of each surface, the acted row has left the list.
      return Promise.resolve(listOf(calls > 2 ? rows.slice(1) : rows));
    }),
    get: vi.fn(() =>
      Promise.resolve({
        task: {
          row: rows[0],
          path: "global/tasks/example-task-3f2a.md",
          createdAt: "2026-10-01T10:00:00.000Z",
          sourceType: "manual",
          blockedBy: [],
          aiGenerated: false,
          confidence: "unverified",
        },
      } as never),
    ),
  });
  configureTasksApi(api);
  configureTaskActionsPort(appliedPort());
  const connection = connected
    ? ({ kind: "live" } as const)
    : ({ kind: "disconnected", reason: "down" } as const);
  render(
    <>
      <TasksDestination
        connection={connection}
        now={TASK_NOW_MS}
        zone={TASK_ZONE}
        context={createTasksContext("global", { zone: () => TASK_ZONE })}
        view={createTasksViewState()}
        projects={[]}
        workspaces={[]}
      />
      <ProjectTasksPanel
        projectId={PROJECT}
        projectName="example-project"
        connection={connection}
        now={TASK_NOW_MS}
        zone={TASK_ZONE}
        context={createProjectTasksContext(PROJECT, { zone: () => TASK_ZONE })}
        view={createTasksViewState()}
        projects={[]}
        workspaces={[]}
        onClose={() => undefined}
      />
    </>,
  );
  return {
    globalRoot: document.querySelector(".ccc-tasks") as HTMLElement,
    panelRoot: document.querySelector(".ccc-project-tasks") as HTMLElement,
  };
}

describe("Test 10: the Tasks accessibility audit", () => {
  it("makes the chips one tab stop and every title button its own stop in both contexts", async () => {
    const { globalRoot, panelRoot } = mountBoth();
    for (const root of [globalRoot, panelRoot]) {
      await within(root).findAllByText("Task 1");
      const toolbar = root.querySelector('[role="toolbar"]') as HTMLElement;
      expect(toolbar.querySelectorAll('button[tabindex="0"]')).toHaveLength(1);
      expect(toolbar.querySelectorAll('button[tabindex="-1"]').length).toBeGreaterThan(0);
      expect(root.querySelectorAll(".ccc-task-title").length).toBe(3);
    }
  });

  it("uses no native disabled attribute on any task control, connected or not", async () => {
    for (const connected of [true, false]) {
      cleanup();
      const { globalRoot, panelRoot } = mountBoth(connected);
      for (const root of [globalRoot, panelRoot]) {
        await within(root).findAllByText("Task 1");
        expect(root.querySelectorAll("[disabled]")).toHaveLength(0);
      }
    }
  });

  it("has exactly one status region per context", async () => {
    const { globalRoot, panelRoot } = mountBoth();
    for (const root of [globalRoot, panelRoot]) {
      await within(root).findAllByText("Task 1");
      const own = [...root.querySelectorAll('[role="status"]')].filter(
        (element) => !element.closest(".ccc-widget-footer, .ccc-card-footer"),
      );
      expect(own.filter((element) => element.classList.contains("ccc-tasks-status"))).toHaveLength(
        1,
      );
    }
  });

  it("moves focus to a neighbouring title after a row action in both contexts", async () => {
    const { globalRoot, panelRoot } = mountBoth();
    for (const root of [globalRoot, panelRoot]) {
      await within(root).findAllByText("Task 1");
      const pill = within(root).getAllByRole("button", { name: /^Mark done/ })[0] as HTMLElement;
      pill.focus();
      fireEvent.click(pill);
      await waitFor(() => {
        const active = document.activeElement as HTMLElement;
        expect(root.contains(active)).toBe(true);
        expect(active.classList.contains("ccc-task-title")).toBe(true);
      });
    }
  });

  it("keeps Create a task reachable with the reason when disconnected", async () => {
    const { globalRoot } = mountBoth(false);
    const create = within(globalRoot).getByRole("button", { name: "Create a task" });
    expect(create.getAttribute("aria-disabled")).toBe("true");
    const reasonId = create.getAttribute("aria-describedby") as string;
    expect(document.getElementById(reasonId)?.textContent).toBe(
      "The companion service isn't running.",
    );
    expect(screen.getAllByRole("button", { name: "Create a task" }).length).toBeGreaterThan(1);
  });
});
