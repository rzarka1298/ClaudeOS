import type { CodexUsageSnapshot, HeadroomSignal } from "@ccc/domain/codex-usage.js";
import type { ServiceEvent, SnapshotResponse } from "@ccc/domain/events.js";
import { EMPTY_PROJECTS_SNAPSHOT } from "@ccc/domain/projects.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  applySnapshot,
  EVENT_HANDLERS,
  routeServiceEvent,
  SNAPSHOT_APPLIERS,
} from "../service-event-router.js";
import { adoptCodexSnapshot, applyCodexServiceEvent } from "./codex-events.js";
import { codexInstalled, resetCodexInstalled } from "./codex-install-state.js";
import {
  codexHeadroom,
  codexIntegration,
  codexSessions,
  codexState,
  codexTokens,
  codexUsage,
  lastCodexEventAt,
} from "./codex-signals.js";

export const observedAt = "2026-10-08T12:00:00.000Z";
export const nowMs = Date.parse(observedAt);
export const usage: CodexUsageSnapshot = {
  kind: "available",
  windows: [
    {
      windowMinutes: 10080,
      usedPercent: 41,
      resetsAt: "2026-10-09T16:40:00.000Z",
      limitLabel: null,
    },
  ],
  ordinaryUsageAllowed: true,
  rateLimitReached: false,
  rateLimitReachedType: null,
  source: "app-server",
  observedAt,
  freshness: "live",
};
export const headroom: HeadroomSignal = {
  generatedAt: observedAt,
  claude: {
    kind: "available",
    window: "five-hour",
    usedPercent: 62,
    resetsAt: "2026-10-09T16:40:00.000Z",
    source: "claude-code-status-line",
    observedAt,
    freshness: "live",
  },
  codex: {
    verdict: "allow",
    reason: null,
    worstWindow: { windowMinutes: 10080, usedPercent: 41, resetsAt: "2026-10-09T16:40:00.000Z" },
    source: "app-server",
    observedAt,
    freshness: "live",
    pausedRuns: { count: 0, earliestResetAt: null },
  },
};
export const sessions = {
  kind: "available" as const,
  sessions: [],
  hiddenCount: 0,
  analysisOn: false,
  observedAt,
  freshness: "live" as const,
  partiality: { partial: false },
};
export const tokens = {
  ranges: {
    today: { kind: "unavailable" as const, reason: "analysis-off" as const, version: null },
    "last-7-days": { kind: "unavailable" as const, reason: "analysis-off" as const, version: null },
    "this-month": { kind: "unavailable" as const, reason: "analysis-off" as const, version: null },
  },
  firstScanPending: false,
  observedAt,
};
export const integration = {
  codex: { installed: true, version: null },
  hooks: { state: "not-installed" as const, lastEventAt: null, installedSince: null },
  bridge: { state: "not-installed" as const, lastWindowAt: null },
  doctor: null,
};
export function event(type: ServiceEvent["type"], payload: ServiceEvent["payload"]): ServiceEvent {
  return { id: 1, type, payload, occurredAt: observedAt };
}
export function snapshot(codex?: SnapshotResponse["state"]["codex"]): SnapshotResponse {
  return {
    lastEventId: 1,
    state: {
      serviceStartedAt: observedAt,
      projects: EMPTY_PROJECTS_SNAPSHOT,
      ...(codex === undefined ? {} : { codex }),
    },
  };
}
afterEach(() => {
  codexUsage.value = null;
  codexHeadroom.value = null;
  codexSessions.value = null;
  codexTokens.value = null;
  codexIntegration.value = null;
  lastCodexEventAt.value = null;
  resetCodexInstalled();
});

describe("Codex pushed state", () => {
  it("routes usage and headroom to a ready card", () => {
    routeServiceEvent(event("codex.usage.updated", { usage, headroom }));
    expect(codexUsage.value).toEqual(usage);
    expect(codexHeadroom.value).toEqual(headroom);
    expect(codexState.value.kind).toBe("ready");
  });
  it("ignores malformed and unknown-key payloads without advancing the event time", () => {
    applyCodexServiceEvent(event("codex.usage.updated", { usage, headroom }));
    const previous = codexUsage.value;
    for (const payload of [
      { usage: {}, headroom },
      { usage, headroom: { ...headroom, extra: true } },
    ]) {
      expect(applyCodexServiceEvent(event("codex.usage.updated", payload))).toBe(false);
      expect(codexUsage.value).toBe(previous);
      expect(lastCodexEventAt.value).toBe(observedAt);
    }
  });
  it("adopts all four event types independently and updates installed only on valid integration", () => {
    applyCodexServiceEvent(event("codex.sessions.updated", sessions));
    applyCodexServiceEvent(event("codex.tokens.updated", tokens));
    applyCodexServiceEvent(event("codex.integration.updated", integration));
    applyCodexServiceEvent(event("codex.usage.updated", { usage, headroom }));
    expect(codexSessions.value).toEqual(sessions);
    expect(codexTokens.value).toEqual(tokens);
    expect(codexIntegration.value).toEqual(integration);
    expect(codexInstalled.value).toBe(true);
    applyCodexServiceEvent(
      event("codex.integration.updated", {
        ...integration,
        codex: { installed: false, version: null },
      }),
    );
    expect(codexInstalled.value).toBe(false);
    applyCodexServiceEvent(event("codex.integration.updated", { ...integration, extra: true }));
    expect(codexInstalled.value).toBe(false);
  });
  it("adopts present snapshot parts and never clears an absent part", () => {
    applySnapshot(snapshot({ usage, headroom, integration }));
    adoptCodexSnapshot(snapshot({ sessions, tokens }));
    adoptCodexSnapshot(snapshot());
    expect(codexUsage.value).toEqual(usage);
    expect(codexHeadroom.value).toEqual(headroom);
    expect(codexSessions.value).toEqual(sessions);
    expect(codexTokens.value).toEqual(tokens);
    expect(codexInstalled.value).toBe(true);
  });
  it("appends four routes and the snapshot applier", () => {
    for (const type of [
      "codex.sessions.updated",
      "codex.usage.updated",
      "codex.tokens.updated",
      "codex.integration.updated",
    ] as const)
      expect(EVENT_HANDLERS[type]).toBe(applyCodexServiceEvent);
    expect(SNAPSHOT_APPLIERS.at(-1)).toBe(adoptCodexSnapshot);
  });
});
