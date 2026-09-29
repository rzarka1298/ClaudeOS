import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServiceEvent, SessionView, SnapshotResponse } from "@ccc/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { adoptClaudeSnapshot, applyClaudeServiceEvent } from "./claude-events.js";
import {
  applySessionUpserted,
  claudeIntegration,
  lastSessionEventAt,
  orderSessionRows,
  sessionsById,
} from "./session-signals.js";

/**
 * Task 1 (tracer): a `session.upserted` event becomes a stored, honestly
 * validated {@link SessionView} — never a reduction of the raw hook record
 * (SESS-05), and never applied out of order (SESS-06, ADR-0007).
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** A 25-char `[0-9a-z]` RunId, varied by `n` (RUN_ID_PATTERN). */
function runId(n: number): string {
  return `0mfk1a2b3c4d5e6f7a8b9c0d${(n % 36).toString(36)}`;
}

function baseSession(overrides: Record<string, unknown> = {}): unknown {
  return {
    runId: runId(1),
    revision: 1,
    claudeSessionId: "claude-session-1",
    state: "running",
    activity: "working",
    projectId: "proj-1",
    projectName: "Example project",
    name: "Refactor parser",
    model: "Opus",
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
    ...overrides,
  };
}

function resetSignals(): void {
  sessionsById.value = new Map();
  claudeIntegration.value = null;
  lastSessionEventAt.value = null;
}

beforeEach(resetSignals);

describe("applySessionUpserted: revision monotonicity (Test 2, ADR-0007)", () => {
  it("applies the first valid event for a RunId", () => {
    const applied = applySessionUpserted({ session: baseSession() });
    expect(applied).toBe(true);
    expect(sessionsById.value.get(runId(1))).toMatchObject({
      revision: 1,
      name: "Refactor parser",
    });
  });

  it("ignores an event whose revision is not greater than the stored one", () => {
    applySessionUpserted({ session: baseSession({ revision: 3 }) });
    const before = sessionsById.value.get(runId(1));
    const appliedEqual = applySessionUpserted({
      session: baseSession({ revision: 3, name: "Should not apply" }),
    });
    const appliedLower = applySessionUpserted({
      session: baseSession({ revision: 2, name: "Should not apply either" }),
    });
    expect(appliedEqual).toBe(false);
    expect(appliedLower).toBe(false);
    expect(sessionsById.value.get(runId(1))).toBe(before);
  });

  it("applies an event whose revision is strictly greater, replacing the stored view", () => {
    applySessionUpserted({ session: baseSession({ revision: 1 }) });
    const applied = applySessionUpserted({
      session: baseSession({ revision: 2, name: "Now applied" }),
    });
    expect(applied).toBe(true);
    expect(sessionsById.value.get(runId(1))).toMatchObject({ name: "Now applied", revision: 2 });
  });

  it("builds a new Map rather than mutating the previous one (Pattern 8 identity)", () => {
    applySessionUpserted({ session: baseSession({ revision: 1 }) });
    const before = sessionsById.value;
    applySessionUpserted({ session: baseSession({ revision: 2 }) });
    expect(sessionsById.value).not.toBe(before);
  });
});

describe("applySessionUpserted: schema safety (Test 3, T-05-23, SESS-05)", () => {
  it("ignores a payload whose session fails SessionUpsertedPayloadSchema, and the previous state stands", () => {
    applySessionUpserted({ session: baseSession() });
    const before = sessionsById.value;
    const applied = applySessionUpserted({
      session: baseSession({ state: "not-a-real-run-state" }),
    });
    expect(applied).toBe(false);
    expect(sessionsById.value).toBe(before);
  });

  it("ignores a payload with no session field at all", () => {
    expect(applySessionUpserted({ notSession: true })).toBe(false);
    expect(applySessionUpserted("not even an object")).toBe(false);
    expect(applySessionUpserted(null)).toBe(false);
  });

  it("never imports anything hook-related from @ccc/domain: the plugin never reduces a raw hook event", () => {
    // Comments may legitimately NAME the forbidden identifiers to explain why
    // they are absent (as this file's own docblock does); only CODE counts.
    const source = readFileSync(join(HERE, "session-signals.ts"), "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(code).toMatch(/\bfrom\s*["']@ccc\/domain["']/);
    expect(code).not.toMatch(/classifyHookRecord|HOOK_RECORD_SCHEMAS/);
  });
});

describe("adoptClaudeSnapshot (Test 4, ADR-0007)", () => {
  function snapshot(state: Partial<SnapshotResponse["state"]> = {}): SnapshotResponse {
    return { lastEventId: 1, state: { serviceStartedAt: "2026-09-25T10:00:00.000Z", ...state } };
  }

  it("replaces the whole session map from state.sessions", () => {
    applySessionUpserted({ session: baseSession({ runId: runId(9) }) });
    adoptClaudeSnapshot(snapshot({ sessions: [baseSession({ runId: runId(2) })] as never }));
    expect(sessionsById.value.has(runId(9))).toBe(false);
    expect(sessionsById.value.has(runId(2))).toBe(true);
    expect(sessionsById.value.size).toBe(1);
  });

  it("leaves the session map exactly as it was when the snapshot has no sessions field (an older service)", () => {
    applySessionUpserted({ session: baseSession() });
    const before = sessionsById.value;
    expect(() => adoptClaudeSnapshot(snapshot())).not.toThrow();
    expect(sessionsById.value).toBe(before);
  });

  it("adopts claudeIntegration from the snapshot when present", () => {
    adoptClaudeSnapshot(
      snapshot({
        claudeIntegration: {
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
        },
      }),
    );
    expect(claudeIntegration.value?.hooks).toBe("installed");
  });
});

describe("applyClaudeServiceEvent: the one dispatch point (PATTERNS fact 4)", () => {
  it("dispatches session.upserted to applySessionUpserted and advances lastSessionEventAt on success", () => {
    const event: ServiceEvent = {
      id: 1,
      type: "session.upserted",
      occurredAt: "2026-09-25T11:06:00.000Z",
      payload: { session: baseSession() },
    };
    applyClaudeServiceEvent(event);
    expect(sessionsById.value.has(runId(1))).toBe(true);
    expect(lastSessionEventAt.value).toBe("2026-09-25T11:06:00.000Z");
  });

  it("does not advance lastSessionEventAt when the event does not apply", () => {
    const event: ServiceEvent = {
      id: 1,
      type: "session.upserted",
      occurredAt: "2026-09-25T11:06:00.000Z",
      payload: { session: baseSession({ state: "bogus" }) },
    };
    applyClaudeServiceEvent(event);
    expect(lastSessionEventAt.value).toBeNull();
  });

  it("ignores every other event type without throwing", () => {
    const event: ServiceEvent = {
      id: 1,
      type: "service.heartbeat",
      occurredAt: "2026-09-25T11:06:00.000Z",
      payload: {},
    };
    expect(() => applyClaudeServiceEvent(event)).not.toThrow();
    expect(sessionsById.value.size).toBe(0);
  });
});

/**
 * Task 2: row ordering and the 60-minute terminal window (Test 1, UI-SPEC
 * "Row list", R-07/R-25).
 */

/** `baseSession()`'s object as a typed {@link SessionView} (schema-valid shape). */
function typedSession(overrides: Record<string, unknown> = {}): SessionView {
  return baseSession(overrides) as SessionView;
}

describe("orderSessionRows: fixed state order and the 60-minute terminal window (Test 1)", () => {
  const NOW = Date.parse("2026-09-25T12:00:00.000Z");

  it("orders waiting-for-approval -> running -> starting -> queued -> stale -> failed -> completed -> cancelled", () => {
    const fiveMinAgo = "2026-09-25T11:55:00.000Z";
    const sessions: readonly SessionView[] = [
      typedSession({ runId: runId(8), state: "cancelled", endedAt: fiveMinAgo }),
      typedSession({ runId: runId(7), state: "completed", endedAt: fiveMinAgo }),
      typedSession({ runId: runId(6), state: "failed", endedAt: fiveMinAgo }),
      typedSession({ runId: runId(5), state: "stale" }),
      typedSession({ runId: runId(4), state: "queued" }),
      typedSession({ runId: runId(3), state: "starting" }),
      typedSession({ runId: runId(2), state: "running" }),
      typedSession({ runId: runId(1), state: "waiting-for-approval" }),
    ];

    const rows = orderSessionRows(sessions, NOW);

    expect(rows.map((row) => row.state)).toEqual([
      "waiting-for-approval",
      "running",
      "starting",
      "queued",
      "stale",
      "failed",
      "completed",
      "cancelled",
    ]);
  });

  it("excludes a completed Run that ended 61 minutes ago, and includes a failed Run that ended 10 minutes ago", () => {
    const sessions: readonly SessionView[] = [
      typedSession({
        runId: runId(10),
        state: "completed",
        endedAt: new Date(NOW - 61 * 60_000).toISOString(),
      }),
      typedSession({
        runId: runId(11),
        state: "failed",
        endedAt: new Date(NOW - 10 * 60_000).toISOString(),
      }),
    ];

    const rows = orderSessionRows(sessions, NOW);

    expect(rows.map((row) => row.runId)).toEqual([runId(11)]);
  });

  it("orders most-recent-activity first within a state", () => {
    const sessions: readonly SessionView[] = [
      typedSession({
        runId: runId(1),
        state: "running",
        lastActivityAt: "2026-09-25T11:00:00.000Z",
      }),
      typedSession({
        runId: runId(2),
        state: "running",
        lastActivityAt: "2026-09-25T11:30:00.000Z",
      }),
    ];

    const rows = orderSessionRows(sessions, NOW);

    expect(rows.map((row) => row.runId)).toEqual([runId(2), runId(1)]);
  });

  it("excludes a terminal Run with no endedAt: no invented end time (R-22)", () => {
    const sessions: readonly SessionView[] = [
      typedSession({ runId: runId(1), state: "failed", endedAt: null }),
    ];

    expect(orderSessionRows(sessions, NOW)).toEqual([]);
  });
});
