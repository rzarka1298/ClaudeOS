import type { ProjectsSnapshot, ProjectView } from "@ccc/domain";
import { EMPTY_PROJECTS_SNAPSHOT } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { projectRowsFrom, projectShortcutsStateFor } from "./projects-state.js";

/**
 * `projectShortcutsStateFor` (pure) and `projectRowsFrom` (plan 04-07): the
 * Project shortcuts card's `WidgetState` derivation, and the S1 row shape
 * (D-12, D-15, D-43, PROJ-04, PROJ-15).
 */

const NOW_ISO = "2026-09-28T12:00:00.000Z";

function view(overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    projectId: "abcdefghi0123456789abcdef0123456" as ProjectView["projectId"],
    displayName: "example-project",
    displayPath: "~/code/example-project",
    pinned: false,
    lastOpenedAt: null,
    observedAt: NOW_ISO,
    gitReadFailed: false,
    git: { kind: "repo", branch: "main", detached: false, dirty: false, commits: [], remote: null },
    github: { kind: "none" },
    ...overrides,
  };
}

function snapshotOf(projects: readonly ProjectView[]): ProjectsSnapshot {
  return { projects: [...projects], launchers: EMPTY_PROJECTS_SNAPSHOT.launchers };
}

describe("projectShortcutsStateFor: undefined snapshot", () => {
  it("reads loading while the connection is still connecting", () => {
    expect(
      projectShortcutsStateFor(undefined, { kind: "connecting" }, NOW_ISO),
    ).toEqual({ kind: "loading" });
  });

  it("reads unavailable once disconnected with nothing ever received", () => {
    expect(
      projectShortcutsStateFor(undefined, { kind: "disconnected", reason: "x" }, NOW_ISO),
    ).toEqual({ kind: "unavailable" });
  });
});

describe("projectShortcutsStateFor: a defined snapshot is always ready", () => {
  it("is ready with isEmpty true for a snapshot with no projects", () => {
    const state = projectShortcutsStateFor(snapshotOf([]), { kind: "live" }, NOW_ISO);
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") throw new Error("unreachable");
    expect(state.isEmpty).toBe(true);
    expect(state.data.projects).toEqual([]);
  });

  it("orders rows with compareProjectViews (pinned first, then last-opened, then name)", () => {
    const a = view({ projectId: "a".repeat(9) + "0".repeat(16) as ProjectView["projectId"], displayName: "Zeta", pinned: false, lastOpenedAt: "2026-09-28T10:00:00.000Z" });
    const b = view({ projectId: "b".repeat(9) + "0".repeat(16) as ProjectView["projectId"], displayName: "Alpha", pinned: true, lastOpenedAt: null });
    const state = projectShortcutsStateFor(snapshotOf([a, b]), { kind: "live" }, NOW_ISO);
    if (state.kind !== "ready") throw new Error("unreachable");
    expect(state.data.projects.map((r) => r.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("is freshness live when every observedAt is within 60s of now and the connection is live", () => {
    const state = projectShortcutsStateFor(snapshotOf([view()]), { kind: "live" }, NOW_ISO);
    if (state.kind !== "ready") throw new Error("unreachable");
    expect(state.freshness).toBe("live");
  });

  it("is stale when an observedAt is older than 60s, even while live", () => {
    const stale = view({ observedAt: "2026-09-28T11:00:00.000Z" });
    const state = projectShortcutsStateFor(snapshotOf([stale]), { kind: "live" }, NOW_ISO);
    if (state.kind !== "ready") throw new Error("unreachable");
    expect(state.freshness).toBe("stale");
  });

  it("is stale whenever the connection itself is not live, even with a fresh observedAt", () => {
    const state = projectShortcutsStateFor(
      snapshotOf([view()]),
      { kind: "disconnected", reason: "x" },
      NOW_ISO,
    );
    if (state.kind !== "ready") throw new Error("unreachable");
    expect(state.freshness).toBe("stale");
  });

  it("a null observedAt (pending) never counts against the live window", () => {
    const pending = view({ observedAt: null, git: { kind: "pending" } });
    const state = projectShortcutsStateFor(snapshotOf([pending]), { kind: "live" }, NOW_ISO);
    if (state.kind !== "ready") throw new Error("unreachable");
    expect(state.freshness).toBe("live");
  });

  it("any gitReadFailed row marks the whole card Partial, naming Local git status", () => {
    const failed = view({ gitReadFailed: true });
    const state = projectShortcutsStateFor(snapshotOf([failed]), { kind: "live" }, NOW_ISO);
    if (state.kind !== "ready") throw new Error("unreachable");
    expect(state.partiality).toEqual({ partial: true, missingSources: ["Local git status"] });
  });

  it("no gitReadFailed row keeps the card not partial", () => {
    const state = projectShortcutsStateFor(snapshotOf([view()]), { kind: "live" }, NOW_ISO);
    if (state.kind !== "ready") throw new Error("unreachable");
    expect(state.partiality).toEqual({ partial: false });
  });

  it("never produces the number 0 for openItems or sessionCount — both are always null", () => {
    const state = projectShortcutsStateFor(snapshotOf([view()]), { kind: "live" }, NOW_ISO);
    if (state.kind !== "ready") throw new Error("unreachable");
    for (const row of state.data.projects) {
      expect(row.openItems).toBeNull();
      expect(row.sessionCount).toBeNull();
    }
  });
});

describe("projectRowsFrom", () => {
  it("maps a ProjectView to the S1 row shape, never inventing openItems/sessionCount/nextTask", () => {
    const rows = projectRowsFrom(snapshotOf([view({ pinned: true })]));
    expect(rows).toEqual([
      {
        id: "abcdefghi0123456789abcdef0123456",
        name: "example-project",
        pinned: true,
        git: { kind: "repo", branch: "main", detached: false, dirty: false, commits: [], remote: null },
        gitReadFailed: false,
        github: { kind: "none" },
        observedAt: NOW_ISO,
        openItems: null,
        sessionCount: null,
        nextTask: null,
      },
    ]);
  });
});
