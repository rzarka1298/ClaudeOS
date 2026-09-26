import { describe, expect, it } from "vitest";
import type { RunId } from "./ids.js";
import { RUN_STATES } from "./run.js";
import {
  isTerminalRunState,
  LAUNCH_SOURCES,
  NOT_REPORTED,
  RUN_STATE_DISPLAY,
  type SessionRun,
  type SessionView,
  SessionViewSchema,
  STALE_RUN_EXPLANATION,
  sessionDisplayName,
  TERMINAL_RUN_STATES,
  toSessionView,
} from "./session.js";

const RUN_ID = "0mfk1a2b3c4d5e6f7a8b9c0d1" as RunId;

function run(overrides: Partial<SessionRun> = {}): SessionRun {
  return {
    runId: RUN_ID,
    revision: 3,
    claudeSessionId: "0f3c2a8e-5b1d-4c7e-9a2f-1e6d8b4c3a90",
    pid: 4242,
    pidStartedAt: "Sat Sep 26 13:00:00 2026",
    state: "running",
    activity: "working",
    projectId: "proj-1",
    name: null,
    model: "claude-opus-4-5",
    effort: "high",
    launchSource: "terminal",
    cwd: "/Users/USERNAME/code/alpha",
    worktreeRoot: "/Users/USERNAME/code/alpha/.claude/worktrees/fix-parser",
    permissionMode: "default",
    lastError: null,
    claudeVersion: "2.1.283",
    transcriptPath: "/Users/USERNAME/.claude/projects/alpha/0f3c2a8e.jsonl",
    linkKind: null,
    linkedFromRunId: null,
    subagentActiveIds: ["agent-a", "agent-b"],
    subagentLastType: "Explore",
    startedAt: "2026-09-26T13:00:00.000Z",
    lastActivityAt: "2026-09-26T13:05:00.000Z",
    endedAt: null,
    terminateRequestedAt: null,
    endObservedAt: null,
    ...overrides,
  };
}

describe("RUN_STATE_DISPLAY (Test 5, D-16, UI-SPEC Run-state vocabulary)", () => {
  it("has exactly the eight RunState keys", () => {
    expect(Object.keys(RUN_STATE_DISPLAY).sort()).toEqual([...RUN_STATES].sort());
    expect(RUN_STATES).toHaveLength(8);
  });

  it("maps every state to the locked label, glyph and group", () => {
    expect(RUN_STATE_DISPLAY).toEqual({
      queued: { label: "Queued", glyph: "◦", group: "active" },
      starting: { label: "Starting", glyph: "▹", group: "active" },
      running: { label: "Running", glyph: "▸", group: "active" },
      "waiting-for-approval": { label: "Waiting for approval", glyph: "◆", group: "active" },
      stale: { label: "Unknown — ended without reporting", glyph: "?", group: "active" },
      completed: { label: "Completed", glyph: "✓", group: "ended" },
      failed: { label: "Failed", glyph: "✕", group: "ended" },
      cancelled: { label: "Cancelled", glyph: "⊘", group: "ended" },
    });
  });

  it("never labels a run state 'Stale' and never reuses a freshness glyph", () => {
    for (const entry of Object.values(RUN_STATE_DISPLAY)) {
      expect(entry.label).not.toBe("Stale");
      expect(["●", "◐", "◔", "○"]).not.toContain(entry.glyph);
    }
  });

  it("declares the fixed unknown-state explanation and the not-reported string", () => {
    expect(STALE_RUN_EXPLANATION).toBe(
      "No end event arrived and the process is gone. It may have crashed, been killed, or lost its last event, so it's shown as unknown rather than guessed.",
    );
    expect(NOT_REPORTED).toBe("Not reported");
  });

  it("treats exactly completed, failed and cancelled as terminal", () => {
    expect([...TERMINAL_RUN_STATES]).toEqual(["completed", "failed", "cancelled"]);
    expect(RUN_STATES.filter(isTerminalRunState)).toEqual(["completed", "failed", "cancelled"]);
    expect(isTerminalRunState("stale")).toBe(false);
  });

  it("reserves skill and automation launch sources beside the three Phase 5 ones", () => {
    expect([...LAUNCH_SOURCES]).toEqual([
      "terminal",
      "dashboard",
      "external",
      "skill",
      "automation",
    ]);
  });
});

describe("sessionDisplayName (Test 6)", () => {
  it("prefers the reported name", () => {
    expect(sessionDisplayName(toSessionView(run({ name: "Fix the parser" }), null))).toBe(
      "Fix the parser",
    );
  });

  it("falls back to 'Session ' plus the first 8 characters of the Claude session id", () => {
    expect(sessionDisplayName(toSessionView(run(), null))).toBe("Session 0f3c2a8e");
  });

  it("falls back to the runId when no Claude session id is known yet", () => {
    expect(sessionDisplayName(toSessionView(run({ claudeSessionId: null }), null))).toBe(
      "Session 0mfk1a2b",
    );
  });
});

describe("toSessionView (Test 8, D-26, PR-28)", () => {
  it("keeps basenames only and never lets a full path reach the view", () => {
    const view = toSessionView(run(), "Alpha");
    expect(view.cwdBasename).toBe("alpha");
    expect(view.worktreeBasename).toBe("fix-parser");
    expect(view.hasTranscript).toBe(true);
    expect(JSON.stringify(view)).not.toContain("/Users/");
    expect(SessionViewSchema.parse(view)).toEqual(view);
  });

  it("derives subagent count, terminate flag and project name", () => {
    const view: SessionView = toSessionView(
      run({ terminateRequestedAt: "2026-09-26T13:06:00.000Z" }),
      "Alpha",
    );
    expect(view.subagents).toEqual({ active: 2, lastType: "Explore" });
    expect(view.terminateRequested).toBe(true);
    expect(view.projectName).toBe("Alpha");
    expect(view.projectId).toBe("proj-1");
  });

  it("reports no transcript and null basenames when paths are unknown", () => {
    const view = toSessionView(run({ cwd: null, worktreeRoot: null, transcriptPath: null }), null);
    expect(view.cwdBasename).toBeNull();
    expect(view.worktreeBasename).toBeNull();
    expect(view.hasTranscript).toBe(false);
    expect(view.terminateRequested).toBe(false);
  });
});

describe("SessionViewSchema", () => {
  it("rejects a cwdBasename that is a path", () => {
    const view = toSessionView(run(), null);
    expect(SessionViewSchema.safeParse({ ...view, cwdBasename: "code/alpha" }).success).toBe(false);
  });

  it("is strict: an unexpected key such as a full cwd fails", () => {
    const view = toSessionView(run(), null);
    expect(SessionViewSchema.safeParse({ ...view, cwd: "/Users/USERNAME/code" }).success).toBe(
      false,
    );
  });
});
