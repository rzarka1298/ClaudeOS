import type { EventClientState } from "@ccc/service-api-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionState, type LastEventInfo } from "../connection-state.js";
import { attachEventClient, configureConnectionDisplayHome } from "../service-connection.js";
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

describe("the Service health card shows the scrubbed disconnect reason (D-11, DIAG-06)", () => {
  afterEach(() => {
    configureConnectionDisplayHome(null);
    connectionState.value = { kind: "connecting" };
  });

  it("carries a state that came through the event-client mapping with the socket path as ~/", () => {
    configureConnectionDisplayHome("/Users/USERNAME");
    let emit: ((state: EventClientState) => void) | undefined;
    attachEventClient({
      subscribe(_onEvent, onStateChange) {
        emit = onStateChange;
      },
      dispose: vi.fn(),
    });
    emit?.({
      kind: "disconnected",
      reason: "connect ENOENT /Users/USERNAME/.claude-command-center/service.sock",
    });

    const state = serviceHealthStateFor(connectionState.value, undefined, CHANGED_AT);
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.data).toEqual({
      connection: "disconnected",
      reason: "connect ENOENT ~/.claude-command-center/service.sock",
    });
    expect(JSON.stringify(state)).not.toContain("/Users/");
    expect(JSON.stringify(state)).not.toContain("USERNAME");
  });
});
