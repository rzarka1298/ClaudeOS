import { EMPTY_PROJECTS_SNAPSHOT } from "@ccc/domain";
import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectActionOutcome, ProjectsActions } from "../projects/projects-actions.js";
import { projectsSnapshot, resetProjectsState } from "../projects/projects-state.js";
import { ProjectsView } from "./projects-view.js";

// Audit (04-08 truth "empty | S3 Projects destination: Nothing here yet /
// Register a folder to open it in ... with Register a project").

function actions(): ProjectsActions {
  const never: () => Promise<ProjectActionOutcome> = () => Promise.reject(new Error("unused"));
  return {
    register: never,
    remove: never,
    rename: never,
    pin: never,
    setGithubLink: never,
    refresh: never,
  };
}

afterEach(() => {
  cleanup();
  resetProjectsState();
});

describe("audit: the Projects empty state (S3)", () => {
  // AUDIT-BUG (04-08): the empty state renders only the body line; the
  // "Nothing here yet" title the truth and UI-SPEC S3 name is missing.
  it("shows Nothing here yet above the body copy, with Register a project", () => {
    projectsSnapshot.value = { projects: [], launchers: EMPTY_PROJECTS_SNAPSHOT.launchers };
    const { container, getByRole } = render(
      <ProjectsView
        actions={actions()}
        pickFolder={() => Promise.resolve({ kind: "cancelled" })}
        connection={{ kind: "live" }}
        now={Date.now()}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Nothing here yet");
    expect(text.indexOf("Nothing here yet")).toBeLessThan(
      text.indexOf("Register a folder to open it"),
    );
    expect(getByRole("button", { name: "Register a project" })).toBeTruthy();
  });
});
