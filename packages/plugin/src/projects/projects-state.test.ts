import type { ProjectsSnapshot, ProjectView } from "@ccc/domain";
import { EMPTY_PROJECTS_SNAPSHOT } from "@ccc/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyProjectsDelta,
  applyProjectsSnapshot,
  projectRowsFrom,
  projectShortcutsStateFor,
  projectsReceivedAt,
  projectsSnapshot,
  quickActionsState,
  quickActionsStateFor,
  resetProjectsState,
} from "./projects-state.js";

/**
 * `projectShortcutsStateFor` (pure) and `projectRowsFrom` (plan 04-07): the
 * Project shortcuts card's `WidgetState` derivation, and the S1 row shape
 * (D-12, D-15, D-43, PROJ-04, PROJ-15).
 */

const NOW_ISO = "2026-09-28T12:00:00.000Z";
/** When the plugin last received the registry from the service. */
const RECEIVED_ISO = "2026-09-28T11:59:40.000Z";

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
    expect(projectShortcutsStateFor(undefined, { kind: "connecting" }, NOW_ISO)).toEqual({
      kind: "loading",
    });
  });

  it("reads unavailable once disconnected with nothing ever received", () => {
    expect(
      projectShortcutsStateFor(undefined, { kind: "disconnected", reason: "x" }, NOW_ISO),
    ).toEqual({ kind: "unavailable" });
  });
});

describe("projectShortcutsStateFor: a defined snapshot is always ready", () => {
  it("is ready with isEmpty true for a snapshot with no projects", () => {
    const state = projectShortcutsStateFor(snapshotOf([]), { kind: "live" }, NOW_ISO, RECEIVED_ISO);
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") throw new Error("unreachable");
    expect(state.isEmpty).toBe(true);
    expect(state.data.projects).toEqual([]);
  });

  it("orders rows with compareProjectViews (pinned first, then last-opened, then name)", () => {
    const a = view({
      projectId: ("a".repeat(9) + "0".repeat(16)) as ProjectView["projectId"],
      displayName: "Zeta",
      pinned: false,
      lastOpenedAt: "2026-09-28T10:00:00.000Z",
    });
    const b = view({
      projectId: ("b".repeat(9) + "0".repeat(16)) as ProjectView["projectId"],
      displayName: "Alpha",
      pinned: true,
      lastOpenedAt: null,
    });
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
    const pending = view({
      projectId: ("p".repeat(9) + "0".repeat(16)) as ProjectView["projectId"],
      observedAt: null,
      git: { kind: "pending" },
    });
    const state = projectShortcutsStateFor(
      snapshotOf([view(), pending]),
      { kind: "live" },
      NOW_ISO,
    );
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
        git: {
          kind: "repo",
          branch: "main",
          detached: false,
          dirty: false,
          commits: [],
          remote: null,
        },
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

describe("the observed heartbeat keeps freshness honest (wave-3 review MAJOR)", () => {
  const T0 = Date.parse("2026-09-28T12:00:00.000Z");
  const at = (ms: number): string => new Date(T0 + ms).toISOString();
  // A schema-valid id: the heartbeat is zod-validated before it is applied.
  const projectId = "abcdefghi0123456789abcdef" as ProjectView["projectId"];

  afterEach(resetProjectsState);

  function receiveSnapshot(): void {
    applyProjectsSnapshot({
      lastEventId: 1,
      state: {
        serviceStartedAt: at(0),
        projects: snapshotOf([view({ projectId, observedAt: at(0) })]),
      },
    });
  }

  function heartbeat(id: number, observedAt: string, target: string = projectId): void {
    applyProjectsDelta({
      id,
      type: "projects.updated",
      occurredAt: observedAt,
      payload: { upserted: [], removed: [], observed: [{ projectId: target, observedAt }] },
    });
  }

  function freshnessAt(ms: number): string {
    const state = projectShortcutsStateFor(projectsSnapshot.value, { kind: "live" }, at(ms));
    if (state.kind !== "ready") throw new Error(`expected ready, got ${state.kind}`);
    return state.freshness;
  }

  it("a steady connection whose git never changes stays live past two minutes", () => {
    receiveSnapshot();
    for (let tick = 1; tick <= 8; tick += 1) heartbeat(tick + 1, at(tick * 30_000));
    expect(projectsSnapshot.value?.projects[0]?.observedAt).toBe(at(240_000));
    expect(freshnessAt(250_000)).toBe("live");
  });

  it("goes stale once the heartbeats stop (the collector stopped reading)", () => {
    receiveSnapshot();
    heartbeat(2, at(30_000));
    expect(freshnessAt(60_000)).toBe("live");
    expect(freshnessAt(120_000)).toBe("stale");
  });

  it("never moves observedAt backwards, and ignores a heartbeat for an unknown project", () => {
    receiveSnapshot();
    heartbeat(2, at(60_000));
    heartbeat(3, at(30_000));
    heartbeat(4, at(90_000), "zzzzzzzzz0000000000000000");
    expect(projectsSnapshot.value?.projects[0]?.observedAt).toBe(at(60_000));
  });
});

describe("nothing observed yet never claims live at now (wave-3 review, widget contract)", () => {
  const pending = (): ProjectView => view({ observedAt: null, git: { kind: "pending" } });

  it("every row still pending reads loading, not ready-live with observedAt = now", () => {
    expect(
      projectShortcutsStateFor(snapshotOf([pending()]), { kind: "live" }, NOW_ISO, RECEIVED_ISO),
    ).toEqual({ kind: "loading" });
  });

  it("an empty registry dates the card by when the registry was received, not by now", () => {
    const state = projectShortcutsStateFor(snapshotOf([]), { kind: "live" }, NOW_ISO, RECEIVED_ISO);
    if (state.kind !== "ready") throw new Error("unreachable");
    expect(state.observedAt).toBe(RECEIVED_ISO);
    expect(state.isEmpty).toBe(true);
  });

  it("an empty registry with no known receipt time reads loading", () => {
    expect(projectShortcutsStateFor(snapshotOf([]), { kind: "live" }, NOW_ISO)).toEqual({
      kind: "loading",
    });
  });

  it("a first read that failed is stale and partial, dated by receipt, never live", () => {
    const failed = view({ observedAt: null, git: { kind: "pending" }, gitReadFailed: true });
    const state = projectShortcutsStateFor(
      snapshotOf([failed]),
      { kind: "live" },
      NOW_ISO,
      RECEIVED_ISO,
    );
    if (state.kind !== "ready") throw new Error("unreachable");
    expect(state.observedAt).toBe(RECEIVED_ISO);
    expect(state.freshness).toBe("stale");
    expect(state.partiality).toEqual({ partial: true, missingSources: ["Local git status"] });
  });

  it("the live card state carries the time the snapshot was applied", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(RECEIVED_ISO));
      applyProjectsSnapshot({
        lastEventId: 1,
        state: { serviceStartedAt: RECEIVED_ISO, projects: snapshotOf([]) },
      });
      vi.setSystemTime(new Date(NOW_ISO));
      const state = projectShortcutsStateFor(
        projectsSnapshot.value,
        { kind: "live" },
        NOW_ISO,
        projectsReceivedAt.value,
      );
      if (state.kind !== "ready") throw new Error("unreachable");
      expect(state.observedAt).toBe(RECEIVED_ISO);
    } finally {
      vi.useRealTimers();
      resetProjectsState();
    }
  });
});

describe("quickActionsStateFor (S8, D-38)", () => {
  it("is loading until a projects snapshot exists", () => {
    expect(quickActionsStateFor(undefined, null, NOW_ISO)).toEqual({ kind: "loading" });
  });

  it("is ready with the launcher summary once a snapshot exists, live and not partial", () => {
    const snapshot = snapshotOf([]);
    const state = quickActionsStateFor(snapshot, RECEIVED_ISO, NOW_ISO);
    expect(state).toEqual({
      kind: "ready",
      data: { launchers: snapshot.launchers },
      observedAt: RECEIVED_ISO,
      freshness: "live",
      partiality: { partial: false },
      isEmpty: false,
    });
  });

  it("is unavailable, not a skeleton forever, once the connection stops resolving with no snapshot", () => {
    expect(
      quickActionsStateFor(undefined, null, NOW_ISO, { kind: "disconnected", reason: "x" }),
    ).toEqual({ kind: "unavailable" });
    expect(quickActionsStateFor(undefined, null, NOW_ISO, { kind: "live" })).toEqual({
      kind: "unavailable",
    });
  });

  it("dates a snapshot with no receipt time at now", () => {
    const state = quickActionsStateFor(snapshotOf([]), null, NOW_ISO);
    expect(state.kind === "ready" ? state.observedAt : null).toBe(NOW_ISO);
  });

  it("the live signal follows projectsSnapshot", () => {
    resetProjectsState();
    expect(quickActionsState.value.kind).toBe("loading");
    projectsSnapshot.value = snapshotOf([]);
    expect(quickActionsState.value.kind).toBe("ready");
    resetProjectsState();
  });
});
