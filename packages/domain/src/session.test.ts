import { describe, expect, it } from "vitest";
import type { RunId } from "./ids.js";
import { RUN_STATES } from "./run.js";
import {
  isSessionListed,
  isTerminalRunState,
  LAUNCH_SOURCES,
  NOT_REPORTED,
  presentRunState,
  QUIET_RUN_GLYPH,
  RUN_STATE_DISPLAY,
  SESSION_QUIET_AFTER_MS,
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
    promptSeenAt: null,
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
      expect(["●", "◐", "◷", "○"]).not.toContain(entry.glyph);
    }
  });

  it("declares the fixed unknown-state explanation and the not-reported string", () => {
    expect(STALE_RUN_EXPLANATION).toBe(
      "No end event arrived, and the process is gone or couldn't be checked. It may have crashed, been killed, or lost its last event, so it's shown as unknown rather than guessed.",
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
  it.each(["starting", "stale"] as const)(
    "labels an unclaimed %s resume distinctly from its parent",
    (state) => {
      const parent = run({ state: "completed" });
      const pending = run({ state, pid: null, linkKind: "resume", linkedFromRunId: parent.runId });
      expect(sessionDisplayName(toSessionView(pending, null))).toBe("Resume of Session 0f3c2a8e");
      expect(sessionDisplayName(toSessionView(parent, null))).toBe("Session 0f3c2a8e");
    },
  );

  it("never calls a pending branch's own id its parent's (Codex 05-codex-3)", () => {
    const parent = run({ state: "completed", name: "Fix the parser" });
    const child = run({
      state: "starting",
      pid: null,
      name: null,
      claudeSessionId: "b1b2b3b4-0000-4000-8000-000000000000",
      linkKind: "fork",
      linkedFromRunId: parent.runId,
    });
    const label = sessionDisplayName(toSessionView(child, null));
    expect(label).not.toContain("Branch of Session");
    expect(label).toBe("Branch b1b2b3b4");
  });

  it("uses the reported name after a resume attaches to a process", () => {
    expect(
      sessionDisplayName(
        toSessionView(
          run({
            linkKind: "resume",
            linkedFromRunId: "0mfk1a2b3000000000000aaaa" as RunId,
            name: "Fix the parser",
            pid: 4242,
          }),
          null,
        ),
      ),
    ).toBe("Fix the parser");
  });

  it("prefers the reported name", () => {
    expect(sessionDisplayName(toSessionView(run({ name: "Fix the parser" }), null))).toBe(
      "Fix the parser",
    );
  });

  it("falls back to 'Session ' plus the first 8 characters of the Claude session id", () => {
    expect(sessionDisplayName(toSessionView(run(), null))).toBe("Session 0f3c2a8e");
  });

  it("falls back to the runId's random suffix when no Claude session id is known yet", () => {
    expect(sessionDisplayName(toSessionView(run({ claudeSessionId: null }), null))).toBe(
      "Session a8b9c0d1",
    );
  });

  it("gives near-simultaneous dashboard launches distinct fallback names", () => {
    // Same millisecond prefix, different random suffix: the timestamp
    // prefix would name both "Session 0mfk1a2b".
    const first = toSessionView(
      run({ claudeSessionId: null, runId: "0mfk1a2b3000000000000aaaa" as RunId }),
      null,
    );
    const second = toSessionView(
      run({ claudeSessionId: null, runId: "0mfk1a2b3000000000000bbbb" as RunId }),
      null,
    );
    expect(sessionDisplayName(first)).not.toBe(sessionDisplayName(second));
  });
});

describe("SessionViewSchema timestamps and text caps", () => {
  const view = (): SessionView =>
    toSessionView(run({ endedAt: "2026-09-26T13:09:00.000Z" }), "Alpha");

  it("rejects a timestamp that is not an ISO date-time", () => {
    for (const field of ["startedAt", "endedAt", "lastActivityAt"] as const) {
      for (const bad of ["yesterday", "", "2026-09-26", "Sat Sep 26 13:00:00 2026"]) {
        const result = SessionViewSchema.safeParse({ ...view(), [field]: bad });
        expect(result.success, `${field}=${bad}`).toBe(false);
      }
    }
  });

  it("caps every free-text field", () => {
    const tooLong = "x".repeat(4097);
    for (const field of [
      "projectId",
      "projectName",
      "name",
      "model",
      "effort",
      "permissionMode",
      "claudeVersion",
    ] as const) {
      expect(SessionViewSchema.safeParse({ ...view(), [field]: tooLong }).success, field).toBe(
        false,
      );
    }
    expect(
      SessionViewSchema.safeParse({ ...view(), subagents: { active: 0, lastType: tooLong } })
        .success,
    ).toBe(false);
  });

  it("accepts a session title at the hook's 256-character cap", () => {
    expect(SessionViewSchema.safeParse({ ...view(), name: "n".repeat(256) }).success).toBe(true);
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

describe("isSessionListed", () => {
  it.each([
    ["running", false, true],
    ["queued", false, true],
    ["waiting-for-approval", false, true],
    ["completed", false, false],
    ["stale", false, false],
    ["failed", false, true],
    ["completed", true, true],
    ["stale", true, true],
  ] as const)(
    "%s without/with a conversation (%s) is listed: %s",
    (state, hasConversation, listed) => {
      expect(isSessionListed({ state, hasConversation })).toBe(listed);
    },
  );
});

describe("SESSION_QUIET_AFTER_MS (Phase 9, D-07, R-04)", () => {
  it("Test 3: is 30 minutes, the PID-less inactivity default", () => {
    expect(SESSION_QUIET_AFTER_MS).toBe(30 * 60 * 1000);
  });
});

describe("presentRunState (Phase 9, D-05, R-04, SESS-19)", () => {
  const MIN = 60_000;
  const NOW = Date.parse("2026-09-25T12:00:00.000Z");
  const ago = (ms: number): string => new Date(NOW - ms).toISOString();
  const view = (
    overrides: Partial<
      Pick<SessionView, "state" | "activity" | "lastActivityAt" | "startedAt">
    > = {},
  ): Pick<SessionView, "state" | "activity" | "lastActivityAt" | "startedAt"> => ({
    state: "running",
    activity: "idle",
    lastActivityAt: ago(41 * MIN),
    startedAt: ago(300 * MIN),
    ...overrides,
  });

  it("Test 1 (tracer): the sitting's 41-minute idle session reads Idle with its age and the quiet glyph", () => {
    const p = presentRunState(view(), NOW);
    expect(p.quiet).toBe("idle");
    expect(p.glyph).toBe("⋯");
    expect(p.label).toBe("Idle — last event 41 min ago");
    expect(p.group).toBe("active");
  });

  it("FIX15: a future-dated last event (clock skew) is not trusted as fresh; the age runs from the start", () => {
    const p = presentRunState(
      view({ lastActivityAt: new Date(NOW + 10 * MIN).toISOString(), startedAt: ago(300 * MIN) }),
      NOW,
    );
    expect(p.quiet).toBe("idle");
    expect(p.label).toBe("Idle — no events since start, 5 h");
    // A small skew inside the tolerance is just now.
    const near = presentRunState(
      view({ lastActivityAt: new Date(NOW + 5_000).toISOString() }),
      NOW,
    );
    expect(near.quiet).toBeNull();
  });

  it("Test 2: exactly at the threshold flips from Running to quiet", () => {
    const q = 10 * MIN;
    const before = presentRunState(view({ lastActivityAt: ago(q - 1) }), NOW, q);
    expect(before).toEqual({ ...RUN_STATE_DISPLAY.running, quiet: null });
    expect(presentRunState(view({ lastActivityAt: ago(q) }), NOW, q).quiet).toBe("idle");
    expect(presentRunState(view({ lastActivityAt: ago(q + 1) }), NOW, q).quiet).toBe("idle");
  });

  it("Test 3: minutes floor, under a minute and hours are worded whole", () => {
    expect(presentRunState(view({ lastActivityAt: ago(41 * MIN + 59_000) }), NOW).label).toBe(
      "Idle — last event 41 min ago",
    );
    expect(presentRunState(view({ lastActivityAt: ago(59_000) }), NOW, 1000).label).toBe(
      "Idle — last event less than a minute ago",
    );
    expect(presentRunState(view({ lastActivityAt: ago(60 * MIN) }), NOW).label).toBe(
      "Idle — last event 1 h ago",
    );
    expect(presentRunState(view({ lastActivityAt: ago(125 * MIN) }), NOW).label).toBe(
      "Idle — last event 2 h ago",
    );
  });

  it("Test 4: wording follows the last activity signal; startedAt backs up a missing lastActivityAt; bad instants fall back", () => {
    const working = presentRunState(view({ activity: "working" }), NOW);
    expect(working.label).toBe("No events for 41 min");
    expect(working.quiet).toBe("silent");
    expect(presentRunState(view({ activity: null }), NOW).quiet).toBe("idle");
    const fromStart = presentRunState(
      view({ lastActivityAt: null, startedAt: ago(45 * MIN) }),
      NOW,
    );
    // No event was ever seen, so the age is the time since start and the label must not claim one.
    expect(fromStart.label).toBe("Idle — no events since start, 45 min");
    expect(fromStart.label).not.toContain("last event");
    const silentFromStart = presentRunState(
      view({ activity: "working", lastActivityAt: null, startedAt: ago(45 * MIN) }),
      NOW,
    );
    expect(silentFromStart.label).toBe("No events for 45 min");
    const bad = presentRunState(view({ lastActivityAt: "not-a-date" }), NOW);
    expect(bad).toEqual({ ...RUN_STATE_DISPLAY.running, quiet: null });
    expect(bad.label).not.toContain("NaN");
  });

  it("Test 5: only a running session can be quiet", () => {
    for (const state of [
      "waiting-for-approval",
      "stale",
      "queued",
      "starting",
      "completed",
      "failed",
      "cancelled",
    ] as const) {
      expect(presentRunState(view({ state, lastActivityAt: ago(500 * MIN) }), NOW)).toEqual({
        ...RUN_STATE_DISPLAY[state],
        quiet: null,
      });
    }
  });

  it("Test 6: a fresh event revives the running presentation", () => {
    const p = presentRunState(view({ lastActivityAt: ago(1000) }), NOW);
    expect(p.quiet).toBeNull();
    expect(`${p.glyph} ${p.label}`).toBe("▸ Running");
  });

  it("Test 7: the quiet glyph is distinct from every run-state and freshness glyph", () => {
    expect(QUIET_RUN_GLYPH).toBe("⋯");
    for (const entry of Object.values(RUN_STATE_DISPLAY))
      expect(entry.glyph).not.toBe(QUIET_RUN_GLYPH);
    expect(["●", "◐", "◷", "○"]).not.toContain(QUIET_RUN_GLYPH);
  });
});
