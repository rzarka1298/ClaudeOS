import type { RunId, ServiceEvent, SessionView } from "@ccc/domain";
import { cleanup, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectionState } from "../connection-state.js";
import { Overview } from "../view/overview.js";
import { type ActiveSessionsData, activeSessionsMetric } from "./active-sessions.js";
import { applyClaudeServiceEvent } from "./claude-events.js";
import {
  activeSessionsState,
  claudeIntegration,
  lastSessionEventAt,
  sessionsById,
} from "./session-signals.js";

/** A 25-char `[0-9a-z]` RunId, varied by `n` (RUN_ID_PATTERN). */
function runId(n: number): RunId {
  return `0mfk1a2b3c4d5e6f7a8b9c0d${(n % 36).toString(36)}` as RunId;
}

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    runId: runId(1),
    revision: 1,
    claudeSessionId: "claude-session-1",
    state: "running",
    activity: "working",
    projectId: "proj-alpha",
    projectName: "alpha",
    name: "Refactor parser",
    model: null,
    effort: null,
    launchSource: "terminal",
    permissionMode: null,
    claudeVersion: null,
    startedAt: "2026-09-25T11:42:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-09-25T11:59:30.000Z",
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
  connectionState.value = { kind: "connecting" };
}

beforeEach(resetSignals);
afterEach(() => {
  cleanup();
  resetSignals();
});

describe("Task 1 (tracer): a session.upserted event becomes a hero row in the same tick (Test 1, D-17, PERF-04)", () => {
  it("updates activeSessionsState synchronously and the rendered card shows the row text and glyph", () => {
    connectionState.value = { kind: "live" };
    const event: ServiceEvent = {
      id: 1,
      type: "session.upserted",
      occurredAt: "2026-09-25T11:59:40.000Z",
      payload: { session: session() },
    };

    // No await, no timer advance above this line: the whole chain is signals.
    applyClaudeServiceEvent(event);

    expect(activeSessionsState.value.kind).toBe("ready");

    const { container } = render(
      <Overview
        layout={{ entries: [{ widgetId: "active-sessions", size: "tall" }], skipped: [] }}
        stateFor={() => activeSessionsState}
        connection={{ kind: "live" }}
        now={Date.parse("2026-09-25T12:00:00.000Z")}
      />,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("alpha · Refactor parser");
    expect(text).toContain("▸ Running");
  });
});

describe("activeSessionsMetric (Test 5, UI-SPEC 'Metric derivation')", () => {
  it("counts running+waiting for the numeral and derives caption, share and srLabel", () => {
    const data: ActiveSessionsData = {
      sessions: [
        session({ runId: runId(1), state: "running" }),
        session({ runId: runId(2), state: "running" }),
        session({ runId: runId(3), state: "waiting-for-approval" }),
        session({ runId: runId(4), state: "stale" }),
        session({
          runId: runId(5),
          state: "completed",
          endedAt: "2026-09-25T11:50:00.000Z",
        }),
      ],
      nowMs: Date.parse("2026-09-25T12:00:00.000Z"),
    };

    const metric = activeSessionsMetric(data);

    expect(metric.value).toBe(3);
    expect(metric.caption).toBe("1 waiting for approval · 1 unknown");
    expect(metric.share).toEqual({ value: 1, max: 3 });
    expect(metric.srLabel).toBe("3 active sessions, running or waiting for approval");
  });

  it("returns a null share and a zero caption when nothing is running or waiting (the empty hero, E1)", () => {
    const metric = activeSessionsMetric({ sessions: [], nowMs: 0 });

    expect(metric.value).toBe(0);
    expect(metric.caption).toBe("0 waiting for approval · 0 unknown");
    expect(metric.share).toBeNull();
    expect(metric.srLabel).toBe("0 active sessions, running or waiting for approval");
  });
});
