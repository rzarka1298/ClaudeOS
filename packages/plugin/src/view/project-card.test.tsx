import type { ProjectGitState, ProjectId } from "@ccc/domain";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchStatusKey, resetLaunchStatus, setLaunchError } from "../projects/launch-status.js";
import type { ProjectActionOutcome, ProjectsActions } from "../projects/projects-actions.js";
import type { ProjectRow } from "../widgets/panels.js";
import { ProjectCard, projectFooterModel } from "./project-card.js";

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
    {
      hash: "a1b2c3d4e5f6",
      subject: "Add the settings page",
      committedAt: new Date(NOW - 2 * 3_600_000).toISOString(),
    },
    {
      hash: "b2c3d4e5f6a1",
      subject: "Fix a bug",
      committedAt: new Date(NOW - 5 * 3_600_000).toISOString(),
    },
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
          git: {
            kind: "repo",
            branch: "main",
            detached: false,
            dirty: false,
            remote: null,
            commits: [],
          },
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
      screen.getByText(
        "Install Apple's command line developer tools, then choose Refresh git status.",
      ),
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

  // PR-11: the card's next step is the same outcome-agnostic line the launch
  // error uses — true whether macOS refused silently or asked first — and
  // never the older Files & Folders "ask again" wording.
  it("folder-access-denied shows the problem and the PR-11 next step", () => {
    const { container } = render(
      <ProjectCard
        row={row({ git: { kind: "folder-access-denied" } })}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "live" }}
        actions={noopActions()}
        onRemoved={vi.fn()}
      />,
    );

    expect(screen.getByText(/Folder access blocked by macOS/)).toBeTruthy();
    expect(
      screen.getByText(
        "Move the project out of Documents, Desktop, Downloads or iCloud Drive, or allow access in System Settings › Privacy & Security, then try again. Updating Node.js can make macOS block it again.",
      ),
    ).toBeTruthy();
    expect(container.textContent).not.toContain("Files & Folders");
    expect(container.textContent).not.toContain("ask again");
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

describe("ProjectCard when the first git read failed (codex finding 4)", () => {
  // The collector keeps `pending` (there is no last-good value) and sets
  // gitReadFailed when the very first read times out or rejects.
  const FAILED_FIRST_READ = {
    git: { kind: "pending" },
    observedAt: null,
    gitReadFailed: true,
  } as const;

  it("shows the read failure with a next step instead of loading forever", () => {
    const { container } = render(
      <ProjectCard
        row={row(FAILED_FIRST_READ)}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "live" }}
        actions={noopActions()}
        onRemoved={vi.fn()}
      />,
    );

    expect(screen.queryByText("Loading git status…")).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.getByText(/Couldn't read Git status/)).toBeTruthy();
    expect(screen.getByText("Choose Refresh git status to try again.")).toBeTruthy();
    expect(screen.getByText("Partial")).toBeTruthy();
  });

  it("projectFooterModel marks the card Partial, naming Local git status", () => {
    const model = projectFooterModel(row(FAILED_FIRST_READ), { kind: "live" }, NOW);
    expect(model.partiality).toEqual({ partial: true, missingSources: ["Local git status"] });
    expect(model.observedAt).toBeNull();
  });

  it("a first read that has not happened yet is still loading, not partial", () => {
    const model = projectFooterModel(
      row({ git: { kind: "pending" }, observedAt: null, gitReadFailed: false }),
      { kind: "live" },
      NOW,
    );
    expect(model.partiality).toEqual({ partial: false });
  });
});

describe("ProjectCard launch toolbar (plan 04-10 Task 2, UI-SPEC S3 anatomy)", () => {
  afterEach(() => {
    resetLaunchStatus();
  });

  it("mounts the S2 toolbar and its status line between the remote row and Recent commits", () => {
    const onQuickAction = vi.fn();
    const { container } = render(
      <ProjectCard
        row={row({ git: REPO_STATE })}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "live" }}
        actions={noopActions()}
        onRemoved={vi.fn()}
        onQuickAction={onQuickAction}
        terminalLabel="Terminal"
      />,
    );
    const toolbar = screen.getByRole("toolbar", { name: "example-project actions" });
    const remote = screen.getByText("Remote github.com/owner/repo");
    const commits = screen.getByText("Recent commits");
    expect(remote.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      toolbar.compareDocumentPosition(commits) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.querySelector(".ccc-launch-status[role=status]")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open example-project in Antigravity" }));
    expect(onQuickAction.mock.calls[0]?.[0]).toMatchObject({ capability: "launch:antigravity" });
  });

  it("a folder that is not a Git repository can still be launched", () => {
    render(
      <ProjectCard
        row={row({ git: { kind: "not-a-repo" } })}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "live" }}
        actions={noopActions()}
        onRemoved={vi.fn()}
        onQuickAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("toolbar", { name: "example-project actions" })).toBeTruthy();
  });

  it("hides the launch toolbar and status line while disconnected (the banner explains, RR-05)", () => {
    const { container } = render(
      <ProjectCard
        row={row({ git: REPO_STATE })}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "disconnected", reason: "service stopped" }}
        actions={noopActions()}
        onRemoved={vi.fn()}
        onQuickAction={vi.fn()}
      />,
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(container.querySelector(".ccc-launch-status")).toBeNull();
  });

  it("an error in Projects hides Go to Projects (inProjects)", () => {
    const projectId = "abcdefghi0123456789abcdef" as ProjectId;
    setLaunchError(launchStatusKey(projectId, "finder"), "project-moved");
    render(
      <ProjectCard
        row={row({ git: REPO_STATE })}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "live" }}
        actions={noopActions()}
        onRemoved={vi.fn()}
        onQuickAction={vi.fn()}
      />,
    );
    expect(screen.getByText(/moved or was replaced/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Go to Projects" })).toBeNull();
  });

  it("after a launch reorders the cards, the same project's same button keeps focus", () => {
    const first = row({
      id: "abcdefghi0123456789abcdef",
      name: "example-project",
      git: REPO_STATE,
    });
    const second = row({ id: "bcdefghij0123456789abcdef", name: "other-project", git: REPO_STATE });
    function Grid({ rows }: { readonly rows: readonly ProjectRow[] }) {
      return (
        <div>
          {rows.map((r) => (
            <ProjectCard
              key={r.id}
              row={r}
              displayPath="~/code/example-project"
              now={NOW}
              connection={{ kind: "live" }}
              actions={noopActions()}
              onRemoved={vi.fn()}
              onQuickAction={vi.fn()}
            />
          ))}
        </div>
      );
    }
    const { rerender } = render(<Grid rows={[second, first]} />);
    const claude = screen.getByRole("button", { name: "Start Claude Code in example-project" });
    claude.focus();
    fireEvent.click(claude);
    rerender(<Grid rows={[first, second]} />);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Start Claude Code in example-project" }),
    );
  });
});
