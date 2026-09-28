import type { ServiceEvent, SnapshotResponse } from "@ccc/domain";
import { EMPTY_PROJECTS_SNAPSHOT } from "@ccc/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyProjectsDelta,
  applyProjectsSnapshot,
  projectsSnapshot,
  resetProjectsState,
} from "./projects-state.js";

/**
 * The plugin's one in-memory Projects picture (D-43, D-11).
 *
 * `projectsSnapshot` is last-good, memory only: a malformed snapshot or
 * delta is dropped, and the previous value is kept — a service that sends
 * garbage never corrupts what the owner already sees.
 */

const PROJECT_ID_A = "0000000000123456789abcdef";
const PROJECT_ID_B = "1111111111123456789abcdef";

function exampleView(projectId: string, overrides: Record<string, unknown> = {}) {
  return {
    projectId,
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

function exampleSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    projects: [exampleView(PROJECT_ID_A)],
    launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
    ...overrides,
  };
}

function snapshotResponse(): SnapshotResponse {
  return {
    lastEventId: 1,
    state: {
      serviceStartedAt: "2026-09-15T00:00:00.000Z",
      projects: exampleSnapshot() as SnapshotResponse["state"]["projects"],
    },
  };
}

function projectsUpdatedEvent(payload: Record<string, unknown>): ServiceEvent {
  return {
    id: 2,
    type: "projects.updated",
    occurredAt: "2026-09-15T00:01:00.000Z",
    payload,
  };
}

afterEach(resetProjectsState);

describe("applyProjectsSnapshot", () => {
  it("sets projectsSnapshot.value from a valid snapshot response", () => {
    applyProjectsSnapshot(snapshotResponse());
    expect(projectsSnapshot.value).toEqual(exampleSnapshot());
  });
});

describe("applyProjectsDelta", () => {
  it("is a no-op when no snapshot has arrived yet", () => {
    applyProjectsDelta(
      projectsUpdatedEvent({ upserted: [exampleView(PROJECT_ID_A)], removed: [] }),
    );
    expect(projectsSnapshot.value).toBeUndefined();
  });

  it("upserts a new project by projectId, keeping the existing one", () => {
    applyProjectsSnapshot(snapshotResponse());
    applyProjectsDelta(
      projectsUpdatedEvent({ upserted: [exampleView(PROJECT_ID_B)], removed: [] }),
    );
    const ids = projectsSnapshot.value?.projects.map((p) => p.projectId).sort();
    expect(ids).toEqual([PROJECT_ID_A, PROJECT_ID_B].sort());
  });

  it("upserts an existing project by projectId, replacing its fields", () => {
    applyProjectsSnapshot(snapshotResponse());
    applyProjectsDelta(
      projectsUpdatedEvent({
        upserted: [exampleView(PROJECT_ID_A, { displayName: "renamed" })],
        removed: [],
      }),
    );
    expect(projectsSnapshot.value?.projects).toHaveLength(1);
    expect(projectsSnapshot.value?.projects[0]?.displayName).toBe("renamed");
  });

  it("removes listed ids", () => {
    applyProjectsSnapshot(snapshotResponse());
    applyProjectsDelta(projectsUpdatedEvent({ upserted: [], removed: [PROJECT_ID_A] }));
    expect(projectsSnapshot.value?.projects).toEqual([]);
  });

  it("replaces launchers when the delta carries them", () => {
    applyProjectsSnapshot(snapshotResponse());
    const newLaunchers = {
      antigravity: "set-up" as const,
      "claude-code": { status: "tested" as const, terminalLabel: "iTerm2" },
      "claude-desktop": "not-set-up" as const,
    };
    applyProjectsDelta(
      projectsUpdatedEvent({ upserted: [], removed: [], launchers: newLaunchers }),
    );
    expect(projectsSnapshot.value?.launchers).toEqual(newLaunchers);
  });

  it("keeps the previous launchers when the delta carries none", () => {
    applyProjectsSnapshot(snapshotResponse());
    applyProjectsDelta(projectsUpdatedEvent({ upserted: [], removed: [] }));
    expect(projectsSnapshot.value?.launchers).toEqual(EMPTY_PROJECTS_SNAPSHOT.launchers);
  });

  it("leaves the previous value unchanged when the payload fails validation", () => {
    applyProjectsSnapshot(snapshotResponse());
    const before = projectsSnapshot.value;
    applyProjectsDelta(projectsUpdatedEvent({ upserted: "not-an-array", removed: [] }));
    expect(projectsSnapshot.value).toEqual(before);
  });

  it("re-sorts after an upsert into the PROJ-15 order: pinned, then most recently opened, then name", () => {
    applyProjectsSnapshot(snapshotResponse());
    const PROJECT_ID_C = "2222222222123456789abcdef";
    applyProjectsDelta(
      projectsUpdatedEvent({
        upserted: [
          exampleView(PROJECT_ID_B, {
            displayName: "beta",
            lastOpenedAt: "2026-09-10T00:00:00.000Z",
          }),
          exampleView(PROJECT_ID_C, { displayName: "gamma", pinned: true }),
        ],
        removed: [],
      }),
    );
    // A pinned project and a recently opened one land AHEAD of the
    // never-opened survivor, not appended after it.
    expect(projectsSnapshot.value?.projects.map((p) => p.projectId)).toEqual([
      PROJECT_ID_C,
      PROJECT_ID_B,
      PROJECT_ID_A,
    ]);
  });
});
