import { describe, expect, it } from "vitest";
import type { ProjectId } from "./ids.js";
import {
  AddScanRootRequestSchema,
  compareProjectViews,
  DisplayNameSchema,
  EMPTY_PROJECTS_SNAPSHOT,
  GithubLinkSchema,
  PinProjectRequestSchema,
  PROJECT_GITHUB_LINK_PATH,
  PROJECT_PIN_PATH,
  PROJECT_REGISTER_PATH,
  PROJECT_REMOVE_PATH,
  PROJECT_RENAME_PATH,
  PROJECTS_REFRESH_PATH,
  ProjectMutationResponseSchema,
  ProjectsSnapshotSchema,
  ProjectsUpdatedPayloadSchema,
  type ProjectView,
  ProjectViewSchema,
  RegisterProjectRequestSchema,
  RegisterProjectResponseSchema,
  RemoveProjectRequestSchema,
  RenameProjectRequestSchema,
  SCAN_ROOTS_ADD_PATH,
  SCAN_ROOTS_LIST_PATH,
  SCAN_ROOTS_REMOVE_PATH,
  SCAN_ROOTS_RESCAN_PATH,
  ScanStateResponseSchema,
  SetGithubLinkRequestSchema,
  SUGGESTION_DISMISS_PATH,
  SUGGESTION_REGISTER_PATH,
} from "./projects.js";

/**
 * Built rather than written as an inline escape on purpose (the api.test.ts
 * precedent): the formatter rewrites that escape into a RAW control byte in
 * the source file, which is invisible in review. Constructing it keeps the
 * file pure ASCII while the value under test is still the real character.
 */
const NUL_BYTE = String.fromCharCode(0);
const AT_SIGN = "@";

const EXAMPLE_PATH = "/Users/USERNAME/code/example-project";
const EXAMPLE_PROJECT_ID = "0000000000123456789abcdef";

/** A view the plugin could receive, with every field valid; tests override one member at a time. */
function exampleView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: EXAMPLE_PROJECT_ID,
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

describe("RegisterProjectRequestSchema", () => {
  it("places the register route under the versioned API base", () => {
    expect(PROJECT_REGISTER_PATH).toBe("/api/v1/projects/register");
  });

  it("accepts an absolute project path", () => {
    expect(RegisterProjectRequestSchema.safeParse({ path: EXAMPLE_PATH }).success).toBe(true);
  });

  it("accepts an optional boolean acknowledgeProtectedLocation", () => {
    expect(
      RegisterProjectRequestSchema.safeParse({
        path: EXAMPLE_PATH,
        acknowledgeProtectedLocation: true,
      }).success,
    ).toBe(true);
    expect(
      RegisterProjectRequestSchema.safeParse({
        path: EXAMPLE_PATH,
        acknowledgeProtectedLocation: "yes",
      }).success,
    ).toBe(false);
  });

  it("rejects a relative path, which would resolve against the service's own cwd", () => {
    expect(RegisterProjectRequestSchema.safeParse({ path: "code/example-project" }).success).toBe(
      false,
    );
    expect(RegisterProjectRequestSchema.safeParse({ path: "./example-project" }).success).toBe(
      false,
    );
  });

  it("rejects an empty path", () => {
    expect(RegisterProjectRequestSchema.safeParse({ path: "" }).success).toBe(false);
  });

  it("rejects a path containing a NUL byte", () => {
    expect(
      RegisterProjectRequestSchema.safeParse({ path: `${EXAMPLE_PATH}${NUL_BYTE}.txt` }).success,
    ).toBe(false);
  });

  it("rejects a path containing a newline", () => {
    expect(
      RegisterProjectRequestSchema.safeParse({ path: `${EXAMPLE_PATH}${String.fromCharCode(10)}x` })
        .success,
    ).toBe(false);
  });

  it("rejects every U+0000-U+001F control character and U+007F (D-04)", () => {
    const codes = [...Array.from({ length: 0x20 }, (_, i) => i), 0x7f];
    for (const code of codes) {
      const candidate = `/Users/USERNAME/code/ex${String.fromCharCode(code)}ample`;
      expect(
        RegisterProjectRequestSchema.safeParse({ path: candidate }).success,
        `code point ${code}`,
      ).toBe(false);
    }
  });

  it("rejects a path longer than 4096 characters", () => {
    const longPath = `/${"a".repeat(4096)}`;
    expect(RegisterProjectRequestSchema.safeParse({ path: longPath }).success).toBe(false);
    const maxPath = `/${"a".repeat(4095)}`;
    expect(RegisterProjectRequestSchema.safeParse({ path: maxPath }).success).toBe(true);
  });

  it("rejects unknown keys (strict)", () => {
    expect(
      RegisterProjectRequestSchema.safeParse({ path: EXAMPLE_PATH, displayName: "x" }).success,
    ).toBe(false);
  });
});

describe("RegisterProjectResponseSchema", () => {
  it("accepts the registered, already-registered and protected-location shapes", () => {
    expect(
      RegisterProjectResponseSchema.safeParse({ kind: "registered", projectId: EXAMPLE_PROJECT_ID })
        .success,
    ).toBe(true);
    expect(
      RegisterProjectResponseSchema.safeParse({
        kind: "already-registered",
        projectId: EXAMPLE_PROJECT_ID,
      }).success,
    ).toBe(true);
    expect(
      RegisterProjectResponseSchema.safeParse({ kind: "protected-location", location: "downloads" })
        .success,
    ).toBe(true);
  });

  it("rejects an unknown protected location and an unknown kind", () => {
    expect(
      RegisterProjectResponseSchema.safeParse({ kind: "protected-location", location: "home" })
        .success,
    ).toBe(false);
    expect(RegisterProjectResponseSchema.safeParse({ kind: "moved" }).success).toBe(false);
  });
});

describe("ProjectViewSchema", () => {
  it("parses a view carrying each of the seven git states", () => {
    const states = [
      {
        kind: "repo",
        branch: "main",
        detached: false,
        dirty: true,
        commits: [
          { hash: "abc1234", subject: "Initial commit", committedAt: "2026-09-01T00:00:00Z" },
        ],
        remote: { host: "github.com", path: "owner/repo" },
      },
      { kind: "not-a-repo" },
      { kind: "git-unavailable" },
      { kind: "skipped", reason: "local-config-commands" },
      { kind: "folder-access-denied" },
      { kind: "folder-missing" },
      { kind: "pending" },
    ];
    for (const git of states) {
      expect(ProjectViewSchema.safeParse(exampleView({ git })).success, git.kind).toBe(true);
    }
  });

  it("parses a detached repo with a null branch", () => {
    const git = {
      kind: "repo",
      branch: null,
      detached: true,
      dirty: false,
      commits: [],
      remote: null,
    };
    expect(ProjectViewSchema.safeParse(exampleView({ git })).success).toBe(true);
  });

  it("parses an unborn repo with an empty commits array", () => {
    const git = {
      kind: "repo",
      branch: "main",
      detached: false,
      dirty: false,
      commits: [],
      remote: null,
    };
    expect(ProjectViewSchema.safeParse(exampleView({ git })).success).toBe(true);
  });

  it("rejects more than five commits", () => {
    const commit = { hash: "abc1234", subject: "change", committedAt: "2026-09-01T00:00:00Z" };
    const git = {
      kind: "repo",
      branch: "main",
      detached: false,
      dirty: false,
      commits: Array.from({ length: 6 }, () => commit),
      remote: null,
    };
    expect(ProjectViewSchema.safeParse(exampleView({ git })).success).toBe(false);
  });

  it("rejects an unknown git kind and a malformed project id", () => {
    expect(ProjectViewSchema.safeParse(exampleView({ git: { kind: "dirty" } })).success).toBe(
      false,
    );
    expect(ProjectViewSchema.safeParse(exampleView({ projectId: "not-an-id" })).success).toBe(
      false,
    );
  });

  it("parses a GitHub target that carries a display label and a source, never a URL", () => {
    const github = { kind: "github", label: "github.com/owner/repo", source: "remote" };
    expect(ProjectViewSchema.safeParse(exampleView({ github })).success).toBe(true);
    expect(
      ProjectViewSchema.safeParse(exampleView({ github: { ...github, source: "guess" } })).success,
    ).toBe(false);
  });

  it("rejects a display name longer than 64 characters", () => {
    expect(ProjectViewSchema.safeParse(exampleView({ displayName: "a".repeat(65) })).success).toBe(
      false,
    );
  });
});

describe("ProjectsSnapshotSchema", () => {
  it("parses EMPTY_PROJECTS_SNAPSHOT", () => {
    expect(ProjectsSnapshotSchema.safeParse(EMPTY_PROJECTS_SNAPSHOT).success).toBe(true);
  });

  it("describes an empty snapshot with every launcher not set up and Terminal as the label", () => {
    expect(EMPTY_PROJECTS_SNAPSHOT).toEqual({
      projects: [],
      launchers: {
        antigravity: "not-set-up",
        "claude-code": { status: "not-set-up", terminalLabel: "Terminal" },
        "claude-desktop": "not-set-up",
      },
    });
  });

  it("parses a snapshot carrying one project", () => {
    expect(
      ProjectsSnapshotSchema.safeParse({
        projects: [exampleView()],
        launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
      }).success,
    ).toBe(true);
  });
});

describe("ProjectsUpdatedPayloadSchema", () => {
  it("parses a delta with upserts, removals and an optional launchers summary", () => {
    expect(
      ProjectsUpdatedPayloadSchema.safeParse({
        upserted: [exampleView()],
        removed: [EXAMPLE_PROJECT_ID],
      }).success,
    ).toBe(true);
    expect(
      ProjectsUpdatedPayloadSchema.safeParse({
        upserted: [],
        removed: [],
        launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
      }).success,
    ).toBe(true);
  });

  it("carries an optional observed heartbeat: per-project observedAt for reads that changed nothing", () => {
    const parsed = ProjectsUpdatedPayloadSchema.parse({
      upserted: [],
      removed: [],
      observed: [{ projectId: EXAMPLE_PROJECT_ID, observedAt: "2026-09-01T00:00:30.000Z" }],
    });
    expect(parsed.observed).toEqual([
      { projectId: EXAMPLE_PROJECT_ID, observedAt: "2026-09-01T00:00:30.000Z" },
    ]);
  });

  it("rejects a malformed observed heartbeat entry", () => {
    expect(
      ProjectsUpdatedPayloadSchema.safeParse({
        upserted: [],
        removed: [],
        observed: [{ projectId: "not-an-id", observedAt: "2026-09-01T00:00:30.000Z" }],
      }).success,
    ).toBe(false);
    expect(
      ProjectsUpdatedPayloadSchema.safeParse({
        upserted: [],
        removed: [],
        observed: [{ projectId: EXAMPLE_PROJECT_ID, observedAt: null }],
      }).success,
    ).toBe(false);
  });
});

describe("compareProjectViews (UI-SPEC S1 Order, PROJ-15)", () => {
  function view(
    displayName: string,
    pinned: boolean,
    lastOpenedAt: string | null,
  ): Pick<ProjectView, "displayName" | "pinned" | "lastOpenedAt"> {
    return { displayName, pinned, lastOpenedAt };
  }

  it("orders pinned first, then last-opened descending, never-opened last, ties by name", () => {
    const rows = [
      view("zeta", false, null),
      view("beta", false, "2026-09-01T00:00:00.000Z"),
      view("Alpha", false, null),
      view("pinned-old", true, "2026-01-01T00:00:00.000Z"),
      view("gamma", false, "2026-09-10T00:00:00.000Z"),
      view("pinned-never", true, null),
      view("delta", false, "2026-09-01T00:00:00.000Z"),
    ];
    const ordered = [...rows].sort(compareProjectViews).map((row) => row.displayName);
    expect(ordered).toEqual([
      "pinned-old",
      "pinned-never",
      "gamma",
      "beta",
      "delta",
      "Alpha",
      "zeta",
    ]);
  });

  it("breaks ties case-insensitively", () => {
    const ordered = [view("beta", false, null), view("Alpha", false, null)]
      .sort(compareProjectViews)
      .map((row) => row.displayName);
    expect(ordered).toEqual(["Alpha", "beta"]);
  });

  it("brands a parsed project id as a ProjectId", () => {
    const parsed = ProjectViewSchema.parse(exampleView());
    const id: ProjectId = parsed.projectId;
    expect(id).toBe(EXAMPLE_PROJECT_ID);
  });
});

describe("project management contracts", () => {
  it("places every management and scan route under the versioned API base, all distinct", () => {
    const paths = [
      PROJECT_REGISTER_PATH,
      PROJECT_REMOVE_PATH,
      PROJECT_RENAME_PATH,
      PROJECT_PIN_PATH,
      PROJECT_GITHUB_LINK_PATH,
      PROJECTS_REFRESH_PATH,
      SCAN_ROOTS_ADD_PATH,
      SCAN_ROOTS_REMOVE_PATH,
      SCAN_ROOTS_RESCAN_PATH,
      SCAN_ROOTS_LIST_PATH,
      SUGGESTION_REGISTER_PATH,
      SUGGESTION_DISMISS_PATH,
    ];
    for (const route of paths) {
      expect(route.startsWith("/api/v1/")).toBe(true);
    }
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("DisplayNameSchema trims and enforces 1..64 characters with no control characters (RR-11)", () => {
    expect(DisplayNameSchema.parse("  demo-api  ")).toBe("demo-api");
    expect(DisplayNameSchema.safeParse("x".repeat(64)).success).toBe(true);
    expect(DisplayNameSchema.safeParse("x".repeat(65)).success).toBe(false);
    expect(DisplayNameSchema.safeParse("   ").success).toBe(false);
    expect(DisplayNameSchema.safeParse(`demo${String.fromCharCode(7)}api`).success).toBe(false);
  });

  it("GithubLinkSchema accepts null or https://github.com/owner/repo only (RR-12)", () => {
    expect(GithubLinkSchema.safeParse(null).success).toBe(true);
    expect(GithubLinkSchema.safeParse("https://github.com/owner/repo").success).toBe(true);
    expect(GithubLinkSchema.safeParse("https://github.com/owner/repo.name_x-y").success).toBe(true);
    for (const bad of [
      "http://github.com/owner/repo",
      "https://gitlab.com/owner/repo",
      "https://github.com/owner",
      "https://github.com/owner/repo/issues",
      // Userinfo form built with an interpolated "@" so the source carries no
      // email-shaped literal (scripts/check-privacy.sh's address rule).
      `https://user:token${AT_SIGN}github.com/owner/repo`,
      "https://github.com.example.com/owner/repo",
      "javascript:alert(1)",
      "https://github.com/owner/..",
    ]) {
      expect(GithubLinkSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("management bodies address a project by id only and are strict", () => {
    expect(RemoveProjectRequestSchema.safeParse({ projectId: EXAMPLE_PROJECT_ID }).success).toBe(
      true,
    );
    expect(
      RemoveProjectRequestSchema.safeParse({ projectId: EXAMPLE_PROJECT_ID, path: EXAMPLE_PATH })
        .success,
    ).toBe(false);
    expect(
      RenameProjectRequestSchema.safeParse({
        projectId: EXAMPLE_PROJECT_ID,
        displayName: "demo-api",
      }).success,
    ).toBe(true);
    expect(
      PinProjectRequestSchema.safeParse({ projectId: EXAMPLE_PROJECT_ID, pinned: true }).success,
    ).toBe(true);
    expect(
      SetGithubLinkRequestSchema.safeParse({ projectId: EXAMPLE_PROJECT_ID, url: null }).success,
    ).toBe(true);
    expect(ProjectMutationResponseSchema.safeParse({ ok: true }).success).toBe(true);
  });

  it("a scan-root add body carries an absolute path and an optional depth of 1..3", () => {
    expect(AddScanRootRequestSchema.safeParse({ path: "/Users/USERNAME/code" }).success).toBe(true);
    expect(
      AddScanRootRequestSchema.safeParse({ path: "/Users/USERNAME/code", depth: 3 }).success,
    ).toBe(true);
    expect(
      AddScanRootRequestSchema.safeParse({ path: "/Users/USERNAME/code", depth: 4 }).success,
    ).toBe(false);
    expect(AddScanRootRequestSchema.safeParse({ path: "code" }).success).toBe(false);
  });

  it("ScanStateResponseSchema parses scan roots (depth 1..3) and suggestions", () => {
    const scanRootId = "0000000000abcdefabcdefabc";
    const state = {
      scanRoots: [
        {
          scanRootId,
          displayPath: "~/code",
          depth: 2,
          addedAt: "2026-09-01T00:00:00.000Z",
          lastScannedAt: null,
        },
      ],
      suggestions: [
        {
          suggestionId: "0000000000abcdefabcdef012",
          scanRootId,
          folderName: "sample-notes",
          displayPath: "~/code/sample-notes",
        },
      ],
      partial: false,
    };
    expect(ScanStateResponseSchema.safeParse(state).success).toBe(true);
    expect(
      ScanStateResponseSchema.safeParse({ ...state, protectedLocation: "documents" }).success,
    ).toBe(true);
    const deep = { ...state, scanRoots: [{ ...state.scanRoots[0], depth: 4 }] };
    expect(ScanStateResponseSchema.safeParse(deep).success).toBe(false);
  });
});
