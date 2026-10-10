import type { ServiceEvent, SnapshotResponse } from "@ccc/domain";
import { EMPTY_PROJECTS_SNAPSHOT } from "@ccc/domain";
import type { EventClient, EventClientState } from "@ccc/service-api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalsById, approvalsReady, resetApprovalsState } from "./approvals/signals.js";
import { connectionChangedAt, connectionState, lastEvent } from "./connection-state.js";
import { projectsSnapshot, resetProjectsState } from "./projects/projects-state.js";
import { attachEventClient } from "./service-connection.js";
import {
  applySnapshot,
  EVENT_HANDLERS,
  routeServiceEvent,
  SNAPSHOT_APPLIERS,
} from "./service-event-router.js";
import { approvalsSnapshot, summary } from "./test-support/approval-fixtures.js";

/**
 * The appendable fan-out router (PR-09, D-50): `EVENT_HANDLERS` and
 * `SNAPSHOT_APPLIERS` are the Phase 5 extension point — a later phase adds
 * one entry per event type it owns, never edits Phase 4's.
 */

function projectsUpdatedEvent(payload: Record<string, unknown>): ServiceEvent {
  return { id: 2, type: "projects.updated", occurredAt: "2026-09-15T00:01:00.000Z", payload };
}

function heartbeatEvent(): ServiceEvent {
  return { id: 3, type: "service.heartbeat", occurredAt: "2026-09-15T00:02:00.000Z", payload: {} };
}

function snapshotResponse(): SnapshotResponse {
  return {
    lastEventId: 1,
    state: { serviceStartedAt: "2026-09-15T00:00:00.000Z", projects: EMPTY_PROJECTS_SNAPSHOT },
  };
}

beforeEach(resetProjectsState);
afterEach(() => {
  resetProjectsState();
  connectionState.value = { kind: "connecting" };
  lastEvent.value = undefined;
});

describe("routeServiceEvent", () => {
  it("routes a projects.updated event to applyProjectsDelta (EVENT_HANDLERS)", () => {
    projectsSnapshot.value = EMPTY_PROJECTS_SNAPSHOT;
    const view = {
      projectId: "0000000000123456789abcdef",
      displayName: "example-project",
      displayPath: "~/code/example-project",
      pinned: false,
      lastOpenedAt: null,
      observedAt: null,
      gitReadFailed: false,
      git: { kind: "pending" },
      github: { kind: "none" },
    };
    routeServiceEvent(projectsUpdatedEvent({ upserted: [view], removed: [] }));
    expect(projectsSnapshot.value?.projects).toHaveLength(1);
  });

  it("is a no-op for an event type with no handler", () => {
    projectsSnapshot.value = EMPTY_PROJECTS_SNAPSHOT;
    expect(() => routeServiceEvent(heartbeatEvent())).not.toThrow();
    expect(projectsSnapshot.value).toEqual(EMPTY_PROJECTS_SNAPSHOT);
    expect(EVENT_HANDLERS["service.heartbeat"]).toBeUndefined();
  });
});

describe("applySnapshot", () => {
  it("runs every SNAPSHOT_APPLIERS entry against the snapshot", () => {
    applySnapshot(snapshotResponse());
    expect(projectsSnapshot.value).toEqual(EMPTY_PROJECTS_SNAPSHOT);
    expect(SNAPSHOT_APPLIERS.length).toBeGreaterThan(0);
  });
});

describe("attachEventClient wiring the router and the snapshot applier", () => {
  it("passes three callbacks, and the third applies a snapshot into projectsSnapshot", () => {
    let onSnapshotCb: ((snapshot: SnapshotResponse) => void) | undefined;
    const fakeClient: EventClient = {
      subscribe(_onEvent, _onStateChange, onSnapshot) {
        onSnapshotCb = onSnapshot;
      },
      dispose: vi.fn(),
    };

    attachEventClient(fakeClient);

    expect(onSnapshotCb).toBeDefined();
    onSnapshotCb?.(snapshotResponse());
    expect(projectsSnapshot.value).toEqual(EMPTY_PROJECTS_SNAPSHOT);
  });

  it("still sets lastEvent and connectionState exactly as before", () => {
    let onEventCb: ((event: ServiceEvent) => void) | undefined;
    let onStateCb: ((state: EventClientState) => void) | undefined;
    const fakeClient: EventClient = {
      subscribe(onEvent, onStateChange) {
        onEventCb = onEvent;
        onStateCb = onStateChange;
      },
      dispose: vi.fn(),
    };

    attachEventClient(fakeClient);
    onStateCb?.({ kind: "live" });
    onEventCb?.(heartbeatEvent());

    expect(connectionState.value).toEqual({ kind: "live" });
    expect(lastEvent.value).toEqual({
      type: "service.heartbeat",
      occurredAt: heartbeatEvent().occurredAt,
    });
    expect(connectionChangedAt.value).toBeTruthy();
  });
});

describe("the approval entries (plan 06-10, Test 7)", () => {
  afterEach(resetApprovalsState);

  it("routes an approval.upserted event to the approval handler", () => {
    resetApprovalsState();
    routeServiceEvent({
      id: 9,
      type: "approval.upserted",
      occurredAt: "2026-10-06T10:00:00.000Z",
      payload: { approval: summary(1) },
    });
    expect(approvalsById.value.get(summary(1).proposalId)?.state).toBe("pending");
    expect(EVENT_HANDLERS["approval.upserted"]).toBeDefined();
  });

  it("runs the approvals applier from applySnapshot, beside every earlier applier", () => {
    resetApprovalsState();
    const withApprovals = {
      lastEventId: 1,
      state: {
        serviceStartedAt: "2026-10-06T10:00:00.000Z",
        projects: EMPTY_PROJECTS_SNAPSHOT,
        approvals: approvalsSnapshot({ pending: [summary(1), summary(2)] }),
      },
    } as unknown as SnapshotResponse;
    applySnapshot(withApprovals);
    expect(approvalsById.value.size).toBe(2);
    expect(approvalsReady.value).toBe(true);
    expect(projectsSnapshot.value).toEqual(EMPTY_PROJECTS_SNAPSHOT);
  });

  it("keeps every earlier table entry", () => {
    for (const type of [
      "projects.updated",
      "session.upserted",
      "usage.updated",
      "claude-integration.updated",
    ] as const) {
      expect(EVENT_HANDLERS[type]).toBeDefined();
    }
  });
});
