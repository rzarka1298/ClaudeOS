import type { ProjectGitState } from "@ccc/domain";
import { cleanup, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectActionOutcome, ProjectsActions } from "../projects/projects-actions.js";
import type { ProjectRow } from "../widgets/panels.js";
import { ProjectCard } from "./project-card.js";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");

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

function row(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: "abcdefghi0123456789abcdef",
    name: "example-project",
    pinned: false,
    gitReadFailed: false,
    github: { kind: "none" },
    observedAt: new Date(NOW - 10_000).toISOString(),
    openItems: null,
    sessionCount: null,
    nextTask: null,
    git: { kind: "not-a-repo" },
    ...overrides,
  };
}

const REPO_STATE: ProjectGitState = {
  kind: "repo",
  branch: "main",
  detached: false,
  dirty: false,
  remote: { host: "github.com", path: "owner/repo" },
  commits: [
    { hash: "a1b2c3d4e5f6", subject: "Add the settings page", committedAt: new Date(NOW - 2 * 3_600_000).toISOString() },
    { hash: "b2c3d4e5f6a1", subject: "Fix a bug", committedAt: new Date(NOW - 5 * 3_600_000).toISOString() },
  ],
};

afterEach(cleanup);

describe("ProjectCard (Task 3, S3 card anatomy)", () => {
  it("a pinned repo card renders every S3 field: pinned marker, name, path, branch/dirty, remote, commits (no author), later-fields line, live footer", () => {
    render(
      <ProjectCard
        row={row({ pinned: true, git: REPO_STATE })}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "live" }}
        actions={noopActions()}
        onRemoved={vi.fn()}
      />,
    );

    expect(screen.getByText("Pinned")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: "example-project" })).toBeTruthy();
    expect(screen.getByText("~/code/example-project")).toBeTruthy();
    expect(screen.getByText(/⎇/)).toBeTruthy();
    expect(screen.getByText(/main/)).toBeTruthy();
    expect(screen.getByText(/Clean/)).toBeTruthy();
    expect(screen.getByText("Remote github.com/owner/repo")).toBeTruthy();
    expect(screen.getByText("Add the settings page")).toBeTruthy();
    expect(screen.getByText(/a1b2c3d · /)).toBeTruthy();
    expect(
      screen.getByText("Issues and PRs unavailable · Sessions unavailable · Next task unavailable"),
    ).toBeTruthy();

    const footer = document.querySelector(".ccc-card-footer");
    expect(footer).toBeTruthy();
    expect(within(footer as HTMLElement).getByText("Live")).toBeTruthy();
  });

  it("no commit row renders an author, and no count ever renders as the digit 0", () => {
    const { container } = render(
      <ProjectCard
        row={row({ git: REPO_STATE })}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "live" }}
        actions={noopActions()}
        onRemoved={vi.fn()}
      />,
    );

    for (const commitRow of container.querySelectorAll(".ccc-commit-row")) {
      // Each commit row is subject + "{hash} · {relative time}" only — no
      // third line, no "by {author}" text anywhere (D-46, RR-08).
      expect(commitRow.textContent ?? "").not.toMatch(/\bby\b/i);
    }
    expect(container.textContent ?? "").not.toMatch(/\b0 commits?\b/i);
  });

  it("the footer is WidgetFooter's own markup (.ccc-card-footer), not a second, forked footer implementation", () => {
    const { container } = render(
      <ProjectCard
        row={row({ git: REPO_STATE })}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "live" }}
        actions={noopActions()}
        onRemoved={vi.fn()}
      />,
    );

    expect(container.querySelectorAll("footer.ccc-card-footer")).toHaveLength(1);
    expect(container.querySelector(".ccc-source-button")).toBeTruthy();
  });

  it("badge reads Live within 60s of observedAt and Stale after", () => {
    const { rerender } = render(
      <ProjectCard
        row={row({ git: REPO_STATE, observedAt: new Date(NOW - 30_000).toISOString() })}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "live" }}
        actions={noopActions()}
        onRemoved={vi.fn()}
      />,
    );
    expect(screen.getByText("Live")).toBeTruthy();

    rerender(
      <ProjectCard
        row={row({ git: REPO_STATE, observedAt: new Date(NOW - 90_000).toISOString() })}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "live" }}
        actions={noopActions()}
        onRemoved={vi.fn()}
      />,
    );
    expect(screen.getByText("Stale")).toBeTruthy();
  });

  it("the Partial chip names Local git status when gitReadFailed, and the Source panel lists both sources", () => {
    const { container } = render(
      <ProjectCard
        row={row({ git: REPO_STATE, gitReadFailed: true })}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "live" }}
        actions={noopActions()}
        onRemoved={vi.fn()}
      />,
    );

    expect(screen.getByText("Partial")).toBeTruthy();
    const footer = container.querySelector(".ccc-card-footer") as HTMLElement;
    const disclosure = within(footer).getByRole("button", { name: "Source" });
    disclosure.click();
    const sourceList = footer.querySelector(".ccc-source-list") as HTMLElement;
    expect(within(sourceList).getByText(/Project registry/)).toBeTruthy();
    expect(within(sourceList).getByText(/Local git status/)).toBeTruthy();
  });

  it("not-a-repo hides commits and remote", () => {
    render(
      <ProjectCard
        row={row({ git: { kind: "not-a-repo" } })}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "live" }}
        actions={noopActions()}
        onRemoved={vi.fn()}
      />,
    );

    expect(screen.getByText("Not a Git repository")).toBeTruthy();
    expect(screen.queryByText(/^Remote /)).toBeNull();
    expect(screen.queryByText("No commits yet")).toBeNull();
  });

  it("an unborn repo shows its branch and No commits yet", () => {
    render(
      <ProjectCard
        row={row({
          git: { kind: "repo", branch: "main", detached: false, dirty: false, remote: null, commits: [] },
        })}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "live" }}
        actions={noopActions()}
        onRemoved={vi.fn()}
      />,
    );

    expect(screen.getByText(/main/)).toBeTruthy();
    expect(screen.getByText("No commits yet")).toBeTruthy();
    expect(screen.getByText("No remote")).toBeTruthy();
  });

  it("git-unavailable shows the problem and the install next step", () => {
    render(
      <ProjectCard
        row={row({ git: { kind: "git-unavailable" } })}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "live" }}
        actions={noopActions()}
        onRemoved={vi.fn()}
      />,
    );

    expect(screen.getByText(/Git unavailable/)).toBeTruthy();
    expect(
      screen.getByText("Install Apple's command line developer tools, then choose Refresh git status."),
    ).toBeTruthy();
  });

  it("folder-missing shows the problem and its next step", () => {
    render(
      <ProjectCard
        row={row({ git: { kind: "folder-missing" } })}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "live" }}
        actions={noopActions()}
        onRemoved={vi.fn()}
      />,
    );

    expect(screen.getByText(/Folder not found/)).toBeTruthy();
    expect(screen.getByText("Restore the folder, or remove the project.")).toBeTruthy();
  });

  it("pending shows skeleton lines with aria-busy", () => {
    const { container } = render(
      <ProjectCard
        row={row({ git: { kind: "pending" }, observedAt: null })}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "live" }}
        actions={noopActions()}
        onRemoved={vi.fn()}
      />,
    );

    const busy = container.querySelector('[aria-busy="true"]');
    expect(busy).toBeTruthy();
    expect(busy?.querySelectorAll(".ccc-skeleton-line").length).toBeGreaterThan(0);
  });

  it("disconnected shows the footer as Unavailable and renders no manage toolbar", () => {
    render(
      <ProjectCard
        row={row({ git: REPO_STATE })}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "disconnected", reason: "connect ECONNREFUSED" }}
        actions={noopActions()}
        onRemoved={vi.fn()}
      />,
    );

    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});
