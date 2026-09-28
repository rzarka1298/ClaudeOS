import type { ProjectGitState, ProjectId } from "@ccc/domain";
import { ProjectViewSchema } from "@ccc/domain";
import type { LauncherConfigRecord, ProjectRecord } from "@ccc/operational-store";
import { describe, expect, it } from "vitest";
import { buildProjectView, launchersSummary, toDisplayPath } from "./project-views.js";

/** Synthetic fixture values only (Shared Pattern 8, D-45). */
const HOME = "/Users/USERNAME";
const PROJECT_ID = "abcdefghi0123456789abcdef" as ProjectId;

function record(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    projectId: PROJECT_ID,
    path: `${HOME}/code/example-project`,
    displayName: "example-project",
    pinned: false,
    lastOpenedAt: null,
    githubUrlOverride: null,
    registeredAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const PENDING: ProjectGitState = { kind: "pending" };

describe("toDisplayPath (D-43)", () => {
  it("abbreviates a path under home to ~/", () => {
    expect(toDisplayPath("/Users/USERNAME/code/x", "/Users/USERNAME")).toBe("~/code/x");
  });

  it("abbreviates home itself to ~", () => {
    expect(toDisplayPath("/Users/USERNAME", "/Users/USERNAME")).toBe("~");
  });

  it("returns a path outside home unchanged", () => {
    expect(toDisplayPath("/opt/work/x", "/Users/USERNAME")).toBe("/opt/work/x");
  });

  it("does not treat a sibling that merely shares the home prefix as inside home", () => {
    expect(toDisplayPath("/Users/USERNAME2/code/x", "/Users/USERNAME")).toBe(
      "/Users/USERNAME2/code/x",
    );
  });
});

describe("buildProjectView", () => {
  it("never includes the record's absolute path when it is under home", () => {
    const view = buildProjectView(record(), PENDING, null, false, HOME);
    expect(JSON.stringify(view)).not.toContain(HOME);
    expect(view.displayPath).toBe("~/code/example-project");
    expect(ProjectViewSchema.safeParse(view).success).toBe(true);
  });

  it("carries the record's identity, name, pin and last-opened fields", () => {
    const view = buildProjectView(
      record({ pinned: true, lastOpenedAt: "2026-09-02T00:00:00.000Z", displayName: "demo-api" }),
      PENDING,
      "2026-09-03T00:00:00.000Z",
      true,
      HOME,
    );
    expect(view).toMatchObject({
      projectId: PROJECT_ID,
      displayName: "demo-api",
      pinned: true,
      lastOpenedAt: "2026-09-02T00:00:00.000Z",
      observedAt: "2026-09-03T00:00:00.000Z",
      gitReadFailed: true,
      git: PENDING,
    });
  });

  it("uses the owner's GitHub override first", () => {
    const view = buildProjectView(
      record({ githubUrlOverride: "https://github.com/owner/repo" }),
      {
        kind: "repo",
        branch: "main",
        detached: false,
        dirty: false,
        commits: [],
        remote: { host: "github.com", path: "other/thing" },
      },
      null,
      false,
      HOME,
    );
    expect(view.github).toEqual({
      kind: "github",
      label: "github.com/owner/repo",
      source: "override",
    });
  });

  it("falls back to a GitHub remote", () => {
    const view = buildProjectView(
      record(),
      {
        kind: "repo",
        branch: "main",
        detached: false,
        dirty: false,
        commits: [],
        remote: { host: "github.com", path: "owner/repo" },
      },
      null,
      false,
      HOME,
    );
    expect(view.github).toEqual({
      kind: "github",
      label: "github.com/owner/repo",
      source: "remote",
    });
  });

  it("has no GitHub target for a non-GitHub remote or no remote", () => {
    const other = buildProjectView(
      record(),
      {
        kind: "repo",
        branch: "main",
        detached: false,
        dirty: false,
        commits: [],
        remote: { host: "example.com", path: "owner/repo" },
      },
      null,
      false,
      HOME,
    );
    expect(other.github).toEqual({ kind: "none" });
    expect(buildProjectView(record(), PENDING, null, false, HOME).github).toEqual({ kind: "none" });
  });
});

function configRow(
  launcherId: LauncherConfigRecord["launcherId"],
  config: unknown,
  tested = false,
): LauncherConfigRecord {
  return { launcherId, config, tested, updatedAt: "2026-09-01T00:00:00.000Z" };
}

describe("launchersSummary", () => {
  it("maps no rows to all not-set-up with Terminal as the label", () => {
    expect(launchersSummary([])).toEqual({
      antigravity: "not-set-up",
      "claude-code": { status: "not-set-up", terminalLabel: "Terminal" },
      "claude-desktop": "not-set-up",
    });
  });

  it("maps a saved row to set-up and a tested row to tested", () => {
    const summary = launchersSummary([
      configRow("antigravity", { bundleId: "com.example.editor" }),
      configRow("claude-desktop", { bundleId: "com.example.desktop" }, true),
    ]);
    expect(summary.antigravity).toBe("set-up");
    expect(summary["claude-desktop"]).toBe("tested");
  });

  it("labels a custom Claude Code terminal by its preset (UI-SPEC S2)", () => {
    const summary = launchersSummary([
      configRow("claude-code", {
        executablePath: "/usr/local/bin/claude",
        args: [],
        terminal: { kind: "custom", preset: "wezterm", argv: ["/usr/bin/open", "{script}"] },
      }),
    ]);
    expect(summary["claude-code"]).toEqual({ status: "set-up", terminalLabel: "WezTerm" });
  });

  it("treats a row that no longer parses as not set up", () => {
    const summary = launchersSummary([configRow("antigravity", { bundleId: 42 }, true)]);
    expect(summary.antigravity).toBe("not-set-up");
  });
});
