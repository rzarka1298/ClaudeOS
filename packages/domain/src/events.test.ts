import { describe, expect, it } from "vitest";
import {
  EVENTS_PATH,
  LAST_EVENT_ID_HEADER,
  SERVICE_EVENT_TYPES,
  ServiceEventSchema,
  SNAPSHOT_PATH,
  SnapshotResponseSchema,
} from "./events.js";

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

  it("rejects a snapshot missing state", () => {
    const result = SnapshotResponseSchema.safeParse({ lastEventId: 3 });
    expect(result.success).toBe(false);
  });
});

describe("constants", () => {
  it("declares the events, snapshot, and last-event-id constants without drift", () => {
    expect(EVENTS_PATH).toBe("/api/v1/events");
    expect(SNAPSHOT_PATH).toBe("/api/v1/snapshot");
    expect(LAST_EVENT_ID_HEADER).toBe("X-Last-Event-Id");
  });
});
