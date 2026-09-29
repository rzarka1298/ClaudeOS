import { EMPTY_PROJECTS_SNAPSHOT, newProjectId, type ProjectId, type ProjectView } from "@ccc/domain";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectActionOutcome, ProjectsActions } from "../projects/projects-actions.js";
import { projectsSnapshot, resetProjectsState } from "../projects/projects-state.js";
import { ProjectsView } from "./projects-view.js";

/**
 * Task 1's tracer test: register a folder from the Projects destination and
 * see its card, end to end through `pickFolder` → `ProjectsActions.register`
 * → the live `projectsSnapshot` signal → the rendered card.
 */

function noopActions(): ProjectsActions {
  const notCalled: () => Promise<ProjectActionOutcome> = () =>
    Promise.reject(new Error("not expected to be called in this test"));
  return {
    register: notCalled,
    remove: notCalled,
    rename: notCalled,
    pin: notCalled,
    setGithubLink: notCalled,
    refresh: notCalled,
  };
}

function view(overrides: Partial<ProjectView> & { projectId: ProjectId }): ProjectView {
  return {
    displayName: "example-project",
    displayPath: "~/code/example-project",
    pinned: false,
    lastOpenedAt: null,
    observedAt: null,
    gitReadFailed: false,
    git: { kind: "pending" },
    github: { kind: "none" },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  resetProjectsState();
});

describe("ProjectsView (Task 1)", () => {
  it("renders one project card, labelled by its name heading, from the live snapshot", () => {
    const projectId = newProjectId();
    projectsSnapshot.value = {
      projects: [view({ projectId, displayName: "example-project" })],
      launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
    };

    render(
      <ProjectsView
        actions={noopActions()}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        connection={{ kind: "live" }}
        now={Date.now()}
      />,
    );

    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(1);
    const heading = screen.getByRole("heading", { level: 4, name: "example-project" });
    expect(cards[0]?.getAttribute("aria-labelledby")).toBe(heading.id);
  });

  it("clicking Register a project registers the picked path exactly once, then focuses the new card's heading once it arrives", async () => {
    const projectId = newProjectId();
    const pickFolder = vi.fn().mockResolvedValue({
      kind: "picked",
      path: "/Users/USERNAME/code/example-project",
    });
    const register = vi.fn().mockResolvedValue({ kind: "registered", projectId });
    const actions: ProjectsActions = { ...noopActions(), register };

    render(
      <ProjectsView
        actions={actions}
        pickFolder={pickFolder}
        connection={{ kind: "live" }}
        now={Date.now()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Register a project" }));

    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register).toHaveBeenCalledWith("/Users/USERNAME/code/example-project");
    expect(pickFolder).toHaveBeenCalledTimes(1);

    // The register response carries only the ProjectId — its rendered data
    // arrives afterwards over the event stream (D-11), so the card appears
    // only once the snapshot itself gains the project.
    expect(screen.queryByRole("article")).toBeNull();

    projectsSnapshot.value = {
      projects: [view({ projectId, displayName: "example-project" })],
      launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
    };

    await vi.waitFor(() => {
      const heading = screen.getByRole("heading", { level: 4, name: "example-project" });
      expect(document.activeElement).toBe(heading);
    });
  });

  it("cancelling the dialog registers nothing and returns focus to the button", async () => {
    const pickFolder = vi.fn().mockResolvedValue({ kind: "cancelled" });
    const register = vi.fn();
    const actions: ProjectsActions = { ...noopActions(), register };

    render(
      <ProjectsView
        actions={actions}
        pickFolder={pickFolder}
        connection={{ kind: "live" }}
        now={Date.now()}
      />,
    );

    const button = screen.getByRole("button", { name: "Register a project" });
    fireEvent.click(button);

    await vi.waitFor(() => expect(pickFolder).toHaveBeenCalledTimes(1));
    expect(register).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
  });
});
