import type { CodexUsageSnapshot, HeadroomSignal } from "@ccc/domain/codex-usage.js";
import { describe, expect, it } from "vitest";
import { type CodexParts, codexStateFor } from "./codex-signals.js";

const observedAt = "2026-10-08T12:00:00.000Z";
const nowMs = Date.parse(observedAt);
const usage: CodexUsageSnapshot = {
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
const headroom: HeadroomSignal = {
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
const sessions = {
  kind: "available" as const,
  sessions: [],
  hiddenCount: 0,
  analysisOn: false,
  observedAt,
  freshness: "live" as const,
  partiality: { partial: false },
};
const tokens = {
  ranges: {
    today: { kind: "unavailable" as const, reason: "analysis-off" as const, version: null },
    "last-7-days": { kind: "unavailable" as const, reason: "analysis-off" as const, version: null },
    "this-month": { kind: "unavailable" as const, reason: "analysis-off" as const, version: null },
  },
  firstScanPending: false,
  observedAt,
};
const integration = {
  codex: { installed: true, version: null },
  hooks: { state: "not-installed" as const, lastEventAt: null, installedSince: null },
  bridge: { state: "not-installed" as const, lastWindowAt: null },
  doctor: null,
};

const none: CodexParts = {
  sessions: null,
  usage: null,
  headroom: null,
  tokens: null,
  integration: null,
};
const stateFor = (parts: CodexParts, time = nowMs) => codexStateFor({ kind: "live" }, parts, time);
describe("Codex card state", () => {
  it("distinguishes no source, setup, and an installed empty card", () => {
    expect(stateFor(none)).toEqual({ kind: "unavailable" });
    expect(
      stateFor({
        ...none,
        integration: { ...integration, codex: { installed: false, version: null } },
      }),
    ).toEqual({ kind: "permission-required", capability: "codex", sourceLabel: "Codex" });
    expect(stateFor({ ...none, integration })).toMatchObject({
      kind: "ready",
      isEmpty: true,
      freshness: "live",
      partiality: { partial: false },
    });
  });
  it("pauses tracking only when all three data sources changed format", () => {
    const changed = {
      kind: "unavailable" as const,
      reason: "format-changed" as const,
      version: null,
    };
    expect(
      stateFor({
        ...none,
        usage: { kind: "unavailable", reason: "shape-changed", version: null, observedAt },
        sessions: changed,
        tokens: {
          ...tokens,
          ranges: { today: changed, "last-7-days": changed, "this-month": changed },
        },
      }),
    ).toEqual({ kind: "unavailable", reason: { code: "codex-data-changed" } });
    expect(stateFor({ ...none, sessions: changed, usage })).toMatchObject({
      kind: "ready",
      partiality: { partial: true, missingSources: ["Codex session records"] },
    });
  });
  it("folds freshness only from producing sources and marks partial sections", () => {
    expect(
      stateFor({ ...none, usage, sessions: { ...sessions, freshness: "stale" } }),
    ).toMatchObject({ kind: "ready", freshness: "live" });
    expect(stateFor({ ...none, usage, tokens, integration, sessions })).toMatchObject({
      kind: "ready",
      freshness: "live",
      partiality: { partial: false },
    });
    expect(
      stateFor({
        ...none,
        usage: { ...usage, freshness: "cached" },
        headroom: {
          ...headroom,
          claude: { ...headroom.claude, kind: "unavailable", reason: "no-report-yet" },
          codex: { ...headroom.codex, freshness: "stale" },
        },
      }),
    ).toMatchObject({ kind: "ready", freshness: "stale" });
    expect(
      stateFor({
        ...none,
        usage,
        sessions: { ...sessions, partiality: { partial: true, missingSources: ["synthetic"] } },
      }),
    ).toMatchObject({
      kind: "ready",
      partiality: { partial: true, missingSources: ["Codex session records"] },
    });
  });
  it("ages usage without a plugin timer and keeps last values", () => {
    expect(stateFor({ ...none, usage }, nowMs + 120001)).toMatchObject({
      kind: "ready",
      freshness: "stale",
      data: { usage },
    });
  });
});

it("treats empty sessions and opted-out tokens as an empty installed card", () => {
  expect(stateFor({ ...none, sessions, tokens, integration })).toMatchObject({
    kind: "ready",
    isEmpty: true,
    freshness: "live",
    partiality: { partial: false },
  });
});
it("does not expose the setup action while disconnected", () => {
  expect(
    codexStateFor(
      { kind: "disconnected", reason: "Service stopped" },
      { ...none, integration: { ...integration, codex: { installed: false, version: null } } },
      nowMs,
    ),
  ).toEqual({ kind: "unavailable" });
});

it("marks a partially unavailable headroom strip as Partial with its source label", () => {
  expect(
    stateFor({
      ...none,
      usage,
      headroom: { ...headroom, claude: { kind: "unavailable", reason: "no-report-yet" } },
    }),
  ).toMatchObject({
    kind: "ready",
    partiality: { partial: true, missingSources: ["Claude and Codex usage reads"] },
  });
});
