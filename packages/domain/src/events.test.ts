import { describe, expect, it } from "vitest";
import {
  EVENTS_PATH,
  LAST_EVENT_ID_HEADER,
  SERVICE_EVENT_TYPES,
  ServiceEventSchema,
  SNAPSHOT_PATH,
  SnapshotResponseSchema,
} from "./events.js";
import type { RunId } from "./ids.js";
import { SessionUpsertedPayloadSchema, type SessionView } from "./session.js";

const SESSION_VIEW: SessionView = {
  runId: "0mfk1a2b3c4d5e6f7a8b9c0d1" as RunId,
  revision: 1,
  claudeSessionId: "0f3c2a8e-5b1d-4c7e-9a2f-1e6d8b4c3a90",
  state: "running",
  activity: "idle",
  projectId: null,
  projectName: null,
  name: null,
  model: null,
  effort: null,
  launchSource: "terminal",
  permissionMode: null,
  claudeVersion: null,
  startedAt: "2026-09-26T13:00:00.000Z",
  endedAt: null,
  lastActivityAt: null,
  subagents: { active: 0, lastType: null },
  lastError: null,
  linkKind: null,
  linkedFromRunId: null,
  cwdBasename: "alpha",
  worktreeBasename: null,
  hasTranscript: false,
  terminateRequested: false,
};

describe("ServiceEventSchema", () => {
  it("parses a valid service.heartbeat envelope", () => {
    const result = ServiceEventSchema.safeParse({
      id: 1,
      type: "service.heartbeat",
      occurredAt: new Date().toISOString(),
      payload: { ok: true },
    });
    expect(result.success).toBe(true);
  });

  it("accepts every declared event type", () => {
    for (const type of SERVICE_EVENT_TYPES) {
      const result = ServiceEventSchema.safeParse({
        id: 1,
        type,
        occurredAt: new Date().toISOString(),
        payload: null,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects a type outside the declared union", () => {
    const result = ServiceEventSchema.safeParse({
      id: 1,
      type: "some.unknown.type",
      occurredAt: new Date().toISOString(),
      payload: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative id", () => {
    const result = ServiceEventSchema.safeParse({
      id: -1,
      type: "service.heartbeat",
      occurredAt: new Date().toISOString(),
      payload: null,
    });
    expect(result.success).toBe(false);
  });

  it("accepts id 0, reserved for the stream.resync control event", () => {
    const result = ServiceEventSchema.safeParse({
      id: 0,
      type: "stream.resync",
      occurredAt: new Date().toISOString(),
      payload: null,
    });
    expect(result.success).toBe(true);
  });
});

describe("SnapshotResponseSchema", () => {
  it("parses a valid snapshot response", () => {
    const result = SnapshotResponseSchema.safeParse({
      lastEventId: 3,
      state: { serviceStartedAt: new Date().toISOString() },
    });
    expect(result.success).toBe(true);
  });

  it("parses a snapshot from an older service carrying only serviceStartedAt (Pitfall 17)", () => {
    const input = { lastEventId: 0, state: { serviceStartedAt: "2026-09-26T13:00:00.000Z" } };
    const result = SnapshotResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(input);
  });

  it("parses a snapshot carrying sessions and keeps them (Test 7)", () => {
    const input = {
      lastEventId: 7,
      state: { serviceStartedAt: "2026-09-26T13:00:00.000Z", sessions: [SESSION_VIEW] },
    };
    const result = SnapshotResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(input);
  });

  it("rejects a snapshot whose sessions carry an invalid view", () => {
    const result = SnapshotResponseSchema.safeParse({
      lastEventId: 7,
      state: {
        serviceStartedAt: "2026-09-26T13:00:00.000Z",
        sessions: [{ ...SESSION_VIEW, state: "stuck" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("parses a snapshot carrying usage and claudeIntegration and keeps them (Task 2 Test 7)", () => {
    const input = {
      lastEventId: 9,
      state: {
        serviceStartedAt: "2026-09-26T13:00:00.000Z",
        usage: {
          capacity: { kind: "unavailable", reason: "wrapper-not-installed", version: null },
          ranges: {
            today: {
              activity: { kind: "unavailable", reason: "analysis-off", version: null },
              cost: { kind: "unavailable", reason: "needs-activity-or-wrapper" },
            },
            "last-7-days": {
              activity: { kind: "unavailable", reason: "analysis-off", version: null },
              cost: { kind: "unavailable", reason: "needs-activity-or-wrapper" },
            },
            "this-month": {
              activity: { kind: "unavailable", reason: "analysis-off", version: null },
              cost: { kind: "unavailable", reason: "needs-activity-or-wrapper" },
            },
          },
          analysis: { enabled: false, firstScanPending: false },
          observedAt: "2026-09-26T13:00:00.000Z",
        },
        claudeIntegration: {
          hooks: "not-installed",
          hookRuntimeMissing: false,
          disableAllHooks: null,
          lastEventAt: null,
          telemetry: { kind: "ok" },
          detectedClaudeVersion: null,
          statusLine: "not-installed",
          statusLineReported: false,
          transcriptAnalysis: { enabled: false },
          spoolDropCount: 0,
          unknownEventCount: 0,
          cleanupPeriodDays: 30,
        },
      },
    };
    const result = SnapshotResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(input);
  });

  it("rejects a snapshot missing state", () => {
    const result = SnapshotResponseSchema.safeParse({ lastEventId: 3 });
    expect(result.success).toBe(false);
  });
});

describe("Phase 5 event types (append-only, D-59)", () => {
  it("keeps the Phase 1 types first and appends the three Phase 5 types", () => {
    expect(SERVICE_EVENT_TYPES.slice(0, 3)).toEqual([
      "service.heartbeat",
      "connection.state",
      "stream.resync",
    ]);
    expect(SERVICE_EVENT_TYPES).toEqual(
      expect.arrayContaining(["session.upserted", "usage.updated", "claude-integration.updated"]),
    );
    const phase5 = SERVICE_EVENT_TYPES.filter((type) =>
      ["session.upserted", "usage.updated", "claude-integration.updated"].includes(type),
    );
    expect(phase5).toEqual(["session.upserted", "usage.updated", "claude-integration.updated"]);
  });

  it("carries a session.upserted event whose payload parses as a SessionView (Test 7)", () => {
    const event = {
      id: 12,
      type: "session.upserted",
      occurredAt: "2026-09-26T13:00:01.000Z",
      payload: { session: SESSION_VIEW },
    };
    const envelope = ServiceEventSchema.safeParse(event);
    expect(envelope.success).toBe(true);
    const payload = SessionUpsertedPayloadSchema.safeParse(envelope.data?.payload);
    expect(payload.success).toBe(true);
    expect(payload.data).toEqual({ session: SESSION_VIEW });
  });
});

describe("constants", () => {
  it("declares the events, snapshot, and last-event-id constants without drift", () => {
    expect(EVENTS_PATH).toBe("/api/v1/events");
    expect(SNAPSHOT_PATH).toBe("/api/v1/snapshot");
    expect(LAST_EVENT_ID_HEADER).toBe("X-Last-Event-Id");
  });
});
