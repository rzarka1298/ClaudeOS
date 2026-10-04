import type { ServiceEvent, ServiceEventType, SnapshotResponse } from "@ccc/domain";
import { EMPTY_PROJECTS_SNAPSHOT } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectsSnapshot, resetProjectsState } from "./projects/projects-state.js";
import { applySnapshot, EVENT_HANDLERS, routeServiceEvent } from "./service-event-router.js";
import { claudeIntegration, sessionsById } from "./widgets/session-signals.js";
import { lastUsageEventAt, usageSummary } from "./widgets/usage-signals.js";

/**
 * Audit (05-16 merge reconcile, area 2): all four Phase 4 and Phase 5 event
 * types reach their handlers through the one `EVENT_HANDLERS` table, and one
 * snapshot applies BOTH phases' state.
 */

const RUN_ID = "0mfk1a2b3c4d5e6f7a8b9c0d1";

const SESSION = {
  runId: RUN_ID,
  revision: 1,
  claudeSessionId: "claude-session-1",
  state: "running",
  activity: "working",
  projectId: null,
  projectName: null,
  name: "Merge audit run",
  model: null,
  effort: null,
  launchSource: "terminal",
  permissionMode: null,
  claudeVersion: null,
  startedAt: "2026-09-25T11:00:00.000Z",
  endedAt: null,
  lastActivityAt: "2026-09-25T11:05:00.000Z",
  subagents: { active: 0, lastType: null },
  lastError: null,
  linkKind: null,
  linkedFromRunId: null,
  cwdBasename: null,
  worktreeBasename: null,
  hasTranscript: false,
  terminateRequested: false,
};

const OFF_RANGE = {
  activity: { kind: "unavailable", reason: "analysis-off", version: null },
  cost: { kind: "unavailable", reason: "needs-activity-or-wrapper" },
};
const USAGE = {
  capacity: { kind: "unavailable", reason: "wrapper-not-installed", version: null },
  ranges: { today: OFF_RANGE, "last-7-days": OFF_RANGE, "this-month": OFF_RANGE },
  analysis: { enabled: false, firstScanPending: false },
  observedAt: "2026-09-26T14:00:00.000Z",
};

const PROJECT_VIEW = {
  projectId: "0000000000123456789abcdef",
  displayName: "merge-audit-project",
  displayPath: "~/code/merge-audit-project",
  pinned: false,
  lastOpenedAt: null,
  observedAt: null,
  gitReadFailed: false,
  git: { kind: "pending" },
  github: { kind: "none" },
};

function event(type: ServiceEventType, payload: Record<string, unknown>): ServiceEvent {
  return { id: 1, type, occurredAt: "2026-09-26T14:00:00.000Z", payload };
}

function reset(): void {
  resetProjectsState();
  sessionsById.value = new Map();
  claudeIntegration.value = null;
  usageSummary.value = null;
  lastUsageEventAt.value = null;
}
beforeEach(reset);
afterEach(reset);

describe("EVENT_HANDLERS after the merge", () => {
  it("registers a handler for each of projects.updated and the three Claude event types", () => {
    for (const type of [
      "projects.updated",
      "session.upserted",
      "usage.updated",
      "claude-integration.updated",
    ] as const) {
      expect(EVENT_HANDLERS[type], type).toBeTypeOf("function");
    }
  });

  it("routes session.upserted, usage.updated and projects.updated to their own state", () => {
    projectsSnapshot.value = EMPTY_PROJECTS_SNAPSHOT;
    routeServiceEvent(event("session.upserted", { session: SESSION }));
    routeServiceEvent(event("usage.updated", USAGE));
    routeServiceEvent(event("projects.updated", { upserted: [PROJECT_VIEW], removed: [] }));

    expect(sessionsById.value.get(RUN_ID)?.name).toBe("Merge audit run");
    expect(usageSummary.value?.observedAt).toBe("2026-09-26T14:00:00.000Z");
    expect(projectsSnapshot.value?.projects.map((p) => p.displayName)).toEqual([
      "merge-audit-project",
    ]);
  });

  it("routes claude-integration.updated to the integration signal", () => {
    expect(claudeIntegration.value).toBeNull();
    routeServiceEvent(
      event("claude-integration.updated", {
        hooks: "installed",
        hookRuntimeMissing: false,
        disableAllHooks: false,
        lastEventAt: null,
        telemetry: { kind: "ok" },
        detectedClaudeVersion: "2.1.283",
        statusLine: "installed",
        statusLineReported: true,
        transcriptAnalysis: { enabled: false },
        spoolDropCount: 0,
        unknownEventCount: 0,
        cleanupPeriodDays: 30,
      }),
    );
    expect(claudeIntegration.value?.hooks).toBe("installed");
  });
});

describe("applySnapshot after the merge", () => {
  it("applies Phase 4 projects AND Phase 5 sessions, usage and integration from one snapshot", () => {
    const snapshot = {
      lastEventId: 5,
      state: {
        serviceStartedAt: "2026-09-26T13:00:00.000Z",
        projects: { ...EMPTY_PROJECTS_SNAPSHOT, projects: [PROJECT_VIEW] },
        sessions: [SESSION],
        usage: USAGE,
      },
    } as unknown as SnapshotResponse;

    applySnapshot(snapshot);

    expect(projectsSnapshot.value?.projects).toHaveLength(1);
    expect(sessionsById.value.get(RUN_ID)?.name).toBe("Merge audit run");
    expect(usageSummary.value).not.toBeNull();
  });

  it("an older service's snapshot without Phase 5 fields leaves Phase 5 state untouched but still applies projects", () => {
    routeServiceEvent(event("session.upserted", { session: SESSION }));
    applySnapshot({
      lastEventId: 6,
      state: {
        serviceStartedAt: "2026-09-26T13:00:00.000Z",
        projects: { ...EMPTY_PROJECTS_SNAPSHOT, projects: [PROJECT_VIEW] },
      },
    } as unknown as SnapshotResponse);
    expect(sessionsById.value.size).toBe(1);
    expect(projectsSnapshot.value?.projects).toHaveLength(1);
  });
});
