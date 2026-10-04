import type { ProjectGitState } from "@ccc/domain";
import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectActionOutcome, ProjectsActions } from "../projects/projects-actions.js";
import type { ProjectRow } from "../widgets/panels.js";
import { ProjectCard } from "./project-card.js";

// Audit (04-08 truth 5): the five-commit cap and the GitHub link row.

const NOW = Date.parse("2026-09-29T12:00:00.000Z");

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

function row(overrides: Partial<ProjectRow>): ProjectRow {
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

function repo(commitCount: number): ProjectGitState {
  return {
    kind: "repo",
    branch: "main",
    detached: false,
    dirty: false,
    remote: { host: "github.com", path: "owner/repo" },
    commits: Array.from({ length: commitCount }, (_, i) => ({
      hash: `${String(i).padStart(2, "0")}aaaaaaaaaa`,
      subject: `Commit subject ${i}`,
      committedAt: new Date(NOW - (i + 1) * 3_600_000).toISOString(),
    })),
  };
}

function show(r: ProjectRow): Element {
  return render(
    <ProjectCard
      row={r}
      displayPath="~/code/example-project"
      now={NOW}
      connection={{ kind: "live" }}
      actions={actions()}
      onRemoved={vi.fn()}
    />,
  ).container;
}

afterEach(cleanup);

describe("audit: ProjectCard anatomy (04-08 truth 5, D-36)", () => {
  it("renders at most five commits even when the state carries more", () => {
    show(row({ git: repo(7) }));
    for (let i = 0; i < 5; i++) expect(screen.getByText(`Commit subject ${i}`)).toBeTruthy();
    expect(screen.queryByText("Commit subject 5")).toBeNull();
    expect(screen.queryByText("Commit subject 6")).toBeNull();
  });

  // AUDIT-BUG (04-08): UI-SPEC S3 "GitHub link override row: `GitHub link` label +
  // `github.com/owner/repo` when an override is set" — project-card.tsx never reads
  // row.github, so the card shows no GitHub link at all (fixed in 04-wave4).
  it("shows the GitHub link row when an override is set", () => {
    const container = show(
      row({
        git: repo(1),
        github: { kind: "github", label: "github.com/other/linked", source: "override" },
      }),
    );
    expect(container.textContent ?? "").toContain("GitHub link");
    expect(container.textContent ?? "").toContain("github.com/other/linked");
  });

  it("shows the GitHub link row for an override even when the folder is not a repository", () => {
    const container = show(
      row({
        git: { kind: "not-a-repo" },
        github: { kind: "github", label: "github.com/other/linked", source: "override" },
      }),
    );
    expect(container.textContent ?? "").toContain("GitHub link");
    expect(container.textContent ?? "").toContain("github.com/other/linked");
  });

  it("shows no GitHub link row when the link is derived from the remote", () => {
    const container = show(
      row({
        git: repo(1),
        github: { kind: "github", label: "github.com/owner/repo", source: "remote" },
      }),
    );
    expect(container.querySelector(".ccc-github-link-row")).toBeNull();
    expect(container.textContent ?? "").not.toContain("GitHub linkgithub.com");
  });
});
