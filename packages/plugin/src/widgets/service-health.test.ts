import { describe, expect, it } from "vitest";
import type { LastEventInfo } from "../connection-state.js";
import { serviceHealthStateFor } from "./service-health.js";

/**
 * ADR-0023 "Panel state assignment": this card's DATA is the connection, so a
 * disconnect is CURRENT knowledge — freshness `live` — rather than the D-15
 * disconnected treatment. The three cases below are that decision in test form.
 */

const CHANGED_AT = "2026-09-15T00:00:00.000Z";
const EVENT: LastEventInfo = { type: "service.heartbeat", occurredAt: "2026-09-15T00:10:00.000Z" };

describe("serviceHealthStateFor", () => {
  it("reports loading while the client is still connecting", () => {
    expect(serviceHealthStateFor({ kind: "connecting" }, undefined, CHANGED_AT)).toEqual({
      kind: "loading",
    });
  });

  it("reports the live connection and the last event, observed at the event's own time", () => {
    const state = serviceHealthStateFor({ kind: "live" }, EVENT, CHANGED_AT);
    expect(state).toEqual({
      kind: "ready",
      data: { connection: "live", lastEvent: EVENT },
      observedAt: EVENT.occurredAt,
      freshness: "live",
      partiality: { partial: false },
      isEmpty: false,
    });
  });

  it("falls back to the connection-change time when no event has arrived yet", () => {
    const state = serviceHealthStateFor({ kind: "live" }, undefined, CHANGED_AT);
    expect(state).toEqual({
      kind: "ready",
      data: { connection: "live" },
      observedAt: CHANGED_AT,
      freshness: "live",
      partiality: { partial: false },
      isEmpty: false,
    });
  });

  it("reports a disconnect as live knowledge, because the disconnect IS the data", () => {
    const state = serviceHealthStateFor(
      { kind: "disconnected", reason: "connect ECONNREFUSED" },
      EVENT,
      CHANGED_AT,
    );
    expect(state).toEqual({
      kind: "ready",
      data: { connection: "disconnected", reason: "connect ECONNREFUSED" },
      observedAt: CHANGED_AT,
      freshness: "live",
      partiality: { partial: false },
      isEmpty: false,
    });
  });
});
