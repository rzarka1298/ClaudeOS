import {
  EMPTY_PROJECTS_SNAPSHOT,
  newProjectId,
  type ProjectId,
  type ProjectView,
} from "@ccc/domain";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
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

describe("ProjectsView (Task 3: loading/empty/error states, disconnected banner, removal focus)", () => {
  it("shows three skeleton cards with hidden 'Loading projects' while connecting and no snapshot has arrived yet", () => {
    render(
      <ProjectsView
        actions={noopActions()}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        connection={{ kind: "connecting" }}
        now={Date.now()}
      />,
    );

    expect(screen.getByText("Loading projects")).toBeTruthy();
    expect(document.querySelectorAll('[aria-busy="true"] .ccc-card')).toHaveLength(3);
    // The toolbar (Register a project) is live immediately, even while loading.
    expect(screen.getByRole("button", { name: "Register a project" })).toBeTruthy();
  });

  it("shows the load-error copy when no snapshot ever arrives and the connection is not merely connecting", () => {
    render(
      <ProjectsView
        actions={noopActions()}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        connection={{ kind: "disconnected", reason: "connect ECONNREFUSED" }}
        now={Date.now()}
      />,
    );

    expect(screen.getByText(/Couldn't load projects\./)).toBeTruthy();
    expect(
      screen.getByText(/Check the service in Settings → Diagnostics, then refresh\./),
    ).toBeTruthy();
  });

  it("shows the empty-state copy once a snapshot arrives with no projects", () => {
    projectsSnapshot.value = { projects: [], launchers: EMPTY_PROJECTS_SNAPSHOT.launchers };

    render(
      <ProjectsView
        actions={noopActions()}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        connection={{ kind: "live" }}
        now={Date.now()}
      />,
    );

    expect(screen.getByRole("heading", { level: 3, name: "Registered projects" })).toBeTruthy();
    expect(
      screen.getByText(
        "Register a folder to open it in Antigravity, Claude Code, Finder or GitHub from here.",
      ),
    ).toBeTruthy();
  });

  it("shows the disconnected banner while a last-good snapshot exists and the connection drops", () => {
    const projectId = newProjectId();
    projectsSnapshot.value = {
      projects: [view({ projectId })],
      launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
    };

    render(
      <ProjectsView
        actions={noopActions()}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        connection={{ kind: "disconnected", reason: "connect ECONNREFUSED" }}
        now={Date.now()}
      />,
    );

    expect(screen.getByText("Service disconnected")).toBeTruthy();
    // The last-good card still renders — disconnected never means empty.
    expect(screen.getByRole("article")).toBeTruthy();
  });

  it("after removing the only project, focus moves to Register a project", async () => {
    const projectId = newProjectId();
    projectsSnapshot.value = {
      projects: [view({ projectId })],
      launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
    };
    const remove = vi.fn().mockResolvedValue({ kind: "ok" });
    const actions: ProjectsActions = { ...noopActions(), remove };

    render(
      <ProjectsView
        actions={actions}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        connection={{ kind: "live" }}
        now={Date.now()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove from projects" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove project" }));
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(projectId));

    // The removal delta lands, leaving no rows.
    projectsSnapshot.value = { projects: [], launchers: EMPTY_PROJECTS_SNAPSHOT.launchers };

    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Register a project" }),
      ),
    );
  });

  it("after removing a project with another still registered, focus moves to the next card's heading", async () => {
    const removedId = newProjectId();
    const survivorId = newProjectId();
    projectsSnapshot.value = {
      projects: [
        view({ projectId: removedId, displayName: "removed-project" }),
        view({ projectId: survivorId, displayName: "survivor-project" }),
      ],
      launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
    };
    const remove = vi.fn().mockResolvedValue({ kind: "ok" });
    const actions: ProjectsActions = { ...noopActions(), remove };

    render(
      <ProjectsView
        actions={actions}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        connection={{ kind: "live" }}
        now={Date.now()}
      />,
    );

    const removedCard = screen
      .getByRole("heading", { level: 4, name: "removed-project" })
      .closest("article") as HTMLElement;
    fireEvent.click(within(removedCard).getByRole("button", { name: "Remove from projects" }));
    fireEvent.click(within(removedCard).getByRole("button", { name: "Remove project" }));
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(removedId));

    projectsSnapshot.value = {
      projects: [view({ projectId: survivorId, displayName: "survivor-project" })],
      launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
    };

    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 4, name: "survivor-project" }),
      ),
    );
  });
  it("shows the skeleton, not the load error, while live but before the first snapshot arrives", () => {
    render(
      <ProjectsView
        actions={noopActions()}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        connection={{ kind: "live" }}
        now={Date.now()}
      />,
    );

    expect(screen.getByText("Loading projects")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load projects\./)).toBeNull();
  });

  it("announces the removal from a view-owned status region that outlives the removed card", async () => {
    const projectId = newProjectId();
    projectsSnapshot.value = {
      projects: [view({ projectId, displayName: "gone-project" })],
      launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
    };
    const remove = vi.fn().mockResolvedValue({ kind: "ok" });

    const { container } = render(
      <ProjectsView
        actions={{ ...noopActions(), remove }}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        connection={{ kind: "live" }}
        now={Date.now()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove from projects" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove project" }));
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(projectId));

    projectsSnapshot.value = { projects: [], launchers: EMPTY_PROJECTS_SNAPSHOT.launchers };

    await vi.waitFor(() => {
      const regions = Array.from(container.querySelectorAll('[role="status"]'));
      const owner = regions.find((r) => r.textContent === "Removed gone-project from projects.");
      expect(owner).toBeTruthy();
      expect(owner?.closest("article")).toBeNull();
    });
  });
});

describe("ProjectsView pin reorder keeps keyboard focus (UI-SPEC S2/S3, codex finding 3)", () => {
  function threeUnpinned(): {
    alpha: ProjectId;
    beta: ProjectId;
    gamma: ProjectId;
    views: (gammaPinned: boolean) => ProjectView[];
  } {
    const alpha = newProjectId();
    const beta = newProjectId();
    const gamma = newProjectId();
    return {
      alpha,
      beta,
      gamma,
      views: (gammaPinned) => [
        view({ projectId: alpha, displayName: "alpha-project" }),
        view({ projectId: beta, displayName: "beta-project" }),
        view({ projectId: gamma, displayName: "gamma-project", pinned: gammaPinned }),
      ],
    };
  }

  function cardNames(): string[] {
    return screen
      .getAllByRole("article")
      .map((card) => within(card).getByRole("heading", { level: 4 }).textContent ?? "");
  }

  function gammaCard(): HTMLElement {
    return screen
      .getByRole("heading", { level: 4, name: "gamma-project" })
      .closest("article") as HTMLElement;
  }

  it.each([
    ["the registry delta lands after the pin response", "delta-after"],
    ["the registry delta lands before the pin response", "delta-before"],
  ] as const)(
    "pinning the third card moves it first and focus stays on its pin control when %s",
    async (_label, order) => {
      const fx = threeUnpinned();
      projectsSnapshot.value = {
        projects: fx.views(false),
        launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
      };
      const pinDelta = (): void => {
        projectsSnapshot.value = {
          projects: fx.views(true),
          launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
        };
      };
      const pin = vi.fn(async (): Promise<ProjectActionOutcome> => {
        if (order === "delta-before") pinDelta();
        return { kind: "ok" };
      });
      const actions: ProjectsActions = { ...noopActions(), pin };

      render(
        <ProjectsView
          actions={actions}
          pickFolder={() => Promise.resolve({ kind: "unavailable" })}
          connection={{ kind: "live" }}
          now={Date.now()}
        />,
      );
      expect(cardNames()).toEqual(["alpha-project", "beta-project", "gamma-project"]);

      const pinButton = within(gammaCard()).getByRole("button", { name: "Pin project" });
      pinButton.focus();
      expect(document.activeElement).toBe(pinButton);
      fireEvent.click(pinButton);
      await vi.waitFor(() => expect(pin).toHaveBeenCalledWith(fx.gamma, true));
      if (order === "delta-after") pinDelta();

      await vi.waitFor(() =>
        expect(cardNames()).toEqual(["gamma-project", "alpha-project", "beta-project"]),
      );
      await vi.waitFor(() =>
        expect(document.activeElement).toBe(
          within(gammaCard()).getByRole("button", { name: "Unpin project" }),
        ),
      );
    },
  );
});
