import { describe, expect, it } from "vitest";
import {
  CODEX_SESSION_STATES,
  CODEX_STATE_DISPLAY,
  CODEX_STATE_DISPLAY_ORDER,
  CodexHookRecordSchema,
  CodexSessionsSnapshotSchema,
  CodexSessionViewSchema,
  CodexTokenActivitySchema,
  CodexTokenCountersSchema,
  CodexTokenSummarySchema,
} from "./codex-sessions.js";
import { RUN_STATE_DISPLAY } from "./session.js";

const NOW = "2026-10-10T12:00:00.000Z";
const EARLIER = "2026-10-10T09:30:00.000Z";

function session(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "thread-aaaa1111",
    projectId: "proj-1",
    projectName: "Alpha",
    origin: "interactive",
    state: "running",
    model: "gpt-5.4",
    effort: "high",
    startedAt: EARLIER,
    lastActivityAt: NOW,
    resumesAfter: null,
    title: null,
    hasTranscript: true,
    liveLogRunId: null,
    ...overrides,
  };
}

function minimalSession(overrides: Record<string, unknown> = {}) {
  return session({
    projectId: null,
    projectName: null,
    model: null,
    effort: null,
    title: null,
    ...overrides,
  });
}

function sessionsSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    kind: "available",
    sessions: [session()],
    hiddenCount: 0,
    analysisOn: false,
    observedAt: NOW,
    freshness: "live",
    partiality: { partial: false },
    ...overrides,
  };
}

describe("Codex session state display (UI-SPEC state vocabulary, D-18)", () => {
  it("Test 1: lists the six states in display order, each with an entry", () => {
    expect([...CODEX_SESSION_STATES]).toEqual([
      "running",
      "limit-paused",
      "stale",
      "failed",
      "completed",
      "cancelled",
    ]);
    expect([...CODEX_STATE_DISPLAY_ORDER]).toEqual([...CODEX_SESSION_STATES]);
    expect(Object.keys(CODEX_STATE_DISPLAY).sort()).toEqual([...CODEX_SESSION_STATES].sort());
  });

  it("reuses the Phase 5 labels and glyphs for the five shared states", () => {
    for (const state of ["running", "completed", "failed", "cancelled", "stale"] as const) {
      expect(CODEX_STATE_DISPLAY[state]).toEqual(RUN_STATE_DISPLAY[state]);
    }
    expect(CODEX_STATE_DISPLAY.stale.label).toBe("Unknown — ended without reporting");
    expect(CODEX_STATE_DISPLAY.stale.glyph).toBe("?");
  });

  it("adds exactly limit-paused, labelled 'Paused by usage limit' with the glyph ‖", () => {
    expect(CODEX_STATE_DISPLAY["limit-paused"]).toEqual({
      label: "Paused by usage limit",
      glyph: "‖",
      group: "active",
    });
    const shared = Object.keys(CODEX_STATE_DISPLAY).filter((key) => key in RUN_STATE_DISPLAY);
    expect(Object.keys(CODEX_STATE_DISPLAY).filter((key) => !shared.includes(key))).toEqual([
      "limit-paused",
    ]);
  });

  it("never reuses a glyph across two Codex states", () => {
    const glyphs = Object.values(CODEX_STATE_DISPLAY).map((entry) => entry.glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});

describe("CodexSessionViewSchema (D-15, D-17)", () => {
  it("Test 2: parses a full row and a minimal row", () => {
    expect(CodexSessionViewSchema.safeParse(session()).success).toBe(true);
    expect(CodexSessionViewSchema.safeParse(minimalSession()).success).toBe(true);
    expect(
      CodexSessionViewSchema.safeParse(
        session({
          state: "limit-paused",
          resumesAfter: "2026-10-10T16:40:00.000Z",
          liveLogRunId: "run-1",
        }),
      ).success,
    ).toBe(true);
  });

  it("refuses a model failing the allowlist, a long effort and a long title", () => {
    expect(CodexSessionViewSchema.safeParse(session({ model: "gpt/5" })).success).toBe(false);
    expect(CodexSessionViewSchema.safeParse(session({ model: "m\nx" })).success).toBe(false);
    expect(CodexSessionViewSchema.safeParse(session({ effort: "x".repeat(25) })).success).toBe(
      false,
    );
    expect(CodexSessionViewSchema.safeParse(session({ effort: "x".repeat(24) })).success).toBe(
      true,
    );
    expect(CodexSessionViewSchema.safeParse(session({ title: "t".repeat(201) })).success).toBe(
      false,
    );
    expect(CodexSessionViewSchema.safeParse(session({ title: "t".repeat(200) })).success).toBe(
      true,
    );
  });

  it("refuses an unknown origin or state and a malformed thread id", () => {
    expect(CodexSessionViewSchema.safeParse(session({ origin: "subagent" })).success).toBe(false);
    expect(CodexSessionViewSchema.safeParse(session({ state: "queued" })).success).toBe(false);
    expect(CodexSessionViewSchema.safeParse(session({ threadId: "a/b" })).success).toBe(false);
    expect(CodexSessionViewSchema.safeParse(session({ threadId: "" })).success).toBe(false);
  });

  it("refuses cwd, rollout path, git origin, account and prompt members", () => {
    for (const extra of [
      { cwd: "/Users/someone/project" },
      { rolloutPath: "/Users/someone/.codex/sessions/rollout.jsonl" },
      { gitOrigin: "git@example.com:o/r.git" },
      { accountId: "acct-1" },
      { prompt: "hello" },
    ]) {
      expect(CodexSessionViewSchema.safeParse(session(extra)).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
  });
});

describe("CodexSessionsSnapshotSchema", () => {
  it("Test 3: parses available, caps at 200 sessions and parses every unavailable reason", () => {
    expect(CodexSessionsSnapshotSchema.safeParse(sessionsSnapshot()).success).toBe(true);
    const many = (count: number) => Array.from({ length: count }, () => session());
    expect(
      CodexSessionsSnapshotSchema.safeParse(sessionsSnapshot({ sessions: many(200) })).success,
    ).toBe(true);
    expect(
      CodexSessionsSnapshotSchema.safeParse(sessionsSnapshot({ sessions: many(201) })).success,
    ).toBe(false);
    for (const reason of ["format-changed", "not-installed", "no-data"]) {
      expect(
        CodexSessionsSnapshotSchema.safeParse({ kind: "unavailable", reason, version: null })
          .success,
      ).toBe(true);
      expect(
        CodexSessionsSnapshotSchema.safeParse({ kind: "unavailable", reason, version: "0.159.2" })
          .success,
      ).toBe(true);
    }
    expect(
      CodexSessionsSnapshotSchema.safeParse({
        kind: "unavailable",
        reason: "no-data",
        version: null,
        sessions: [],
      }).success,
    ).toBe(false);
  });

  it("refuses an available snapshot claiming unavailable freshness", () => {
    expect(
      CodexSessionsSnapshotSchema.safeParse(sessionsSnapshot({ freshness: "unavailable" })).success,
    ).toBe(false);
  });

  it("refuses a prompt-derived title while transcript analysis is off, and accepts it when on (D-17)", () => {
    const titled = [session({ title: "Fix the flaky test" })];
    expect(
      CodexSessionsSnapshotSchema.safeParse(sessionsSnapshot({ sessions: titled })).success,
    ).toBe(false);
    expect(
      CodexSessionsSnapshotSchema.safeParse(
        sessionsSnapshot({ sessions: titled, analysisOn: true }),
      ).success,
    ).toBe(true);
  });
});

const counters = (n: number) => ({
  input: n,
  cachedInput: n,
  cacheWrite: n,
  output: n,
  reasoningOutput: n,
  total: n,
});

function tokenActivity(range = "today", overrides: Record<string, unknown> = {}) {
  return {
    kind: "available",
    range,
    bounds: { start: "2026-10-10T00:00:00.000Z", end: NOW },
    totals: counters(10),
    observedAt: NOW,
    source: "codex-session-logs",
    freshness: "live",
    partiality: { partial: false },
    coverage: { horizonDate: "2026-09-01", uncoveredDays: 0, analysisOffDays: 0 },
    ...overrides,
  };
}

describe("Codex token activity (D-24, CODEX-10)", () => {
  it("Test 4: requires six non-negative integer counters and refuses a seventh key", () => {
    expect(CodexTokenCountersSchema.safeParse(counters(0)).success).toBe(true);
    expect(CodexTokenCountersSchema.safeParse({ ...counters(1), cost: 0 }).success).toBe(false);
    expect(CodexTokenCountersSchema.safeParse({ ...counters(1), total: -1 }).success).toBe(false);
    expect(CodexTokenCountersSchema.safeParse({ ...counters(1), output: 1.5 }).success).toBe(false);
    const { reasoningOutput: _omitted, ...five } = counters(1);
    expect(CodexTokenCountersSchema.safeParse(five).success).toBe(false);
  });

  it("parses available activity and refuses billing members", () => {
    expect(CodexTokenActivitySchema.safeParse(tokenActivity()).success).toBe(true);
    expect(CodexTokenActivitySchema.safeParse(tokenActivity("session")).success).toBe(true);
    for (const extra of [{ cost: 1 }, { usd: 1 }, { price: 1 }, { billing: "x" }]) {
      expect(CodexTokenActivitySchema.safeParse(tokenActivity("today", extra)).success).toBe(false);
    }
    expect(
      CodexTokenActivitySchema.safeParse(
        tokenActivity("today", { bounds: { start: NOW, end: EARLIER } }),
      ).success,
    ).toBe(false);
  });

  it("parses each unavailable reason", () => {
    for (const reason of ["analysis-off", "format-changed", "no-coverage", "first-scan-pending"]) {
      expect(
        CodexTokenActivitySchema.safeParse({ kind: "unavailable", reason, version: null }).success,
      ).toBe(true);
    }
    expect(
      CodexTokenActivitySchema.safeParse({ kind: "unavailable", reason: "other", version: null })
        .success,
    ).toBe(false);
    expect(
      CodexTokenActivitySchema.safeParse({
        kind: "unavailable",
        reason: "analysis-off",
        version: null,
        totals: counters(0),
      }).success,
    ).toBe(false);
  });

  function summary(overrides: Record<string, unknown> = {}) {
    return {
      ranges: {
        today: tokenActivity("today"),
        "last-7-days": tokenActivity("last-7-days"),
        "this-month": tokenActivity("this-month"),
      },
      firstScanPending: false,
      observedAt: NOW,
      ...overrides,
    };
  }

  it("holds the three precomputed ranges, each under its own key", () => {
    expect(CodexTokenSummarySchema.safeParse(summary()).success).toBe(true);
    const mismatched = summary({
      ranges: {
        today: tokenActivity("last-7-days"),
        "last-7-days": tokenActivity("last-7-days"),
        "this-month": tokenActivity("this-month"),
      },
    });
    expect(CodexTokenSummarySchema.safeParse(mismatched).success).toBe(false);
    const unavailable = { kind: "unavailable", reason: "first-scan-pending", version: null };
    expect(
      CodexTokenSummarySchema.safeParse(
        summary({
          firstScanPending: true,
          ranges: { today: unavailable, "last-7-days": unavailable, "this-month": unavailable },
        }),
      ).success,
    ).toBe(true);
  });

  it("refuses a missing range, an extra range and the session scope as a range key", () => {
    const { today: _today, ...two } = summary().ranges;
    expect(CodexTokenSummarySchema.safeParse(summary({ ranges: two })).success).toBe(false);
    expect(
      CodexTokenSummarySchema.safeParse(
        summary({ ranges: { ...summary().ranges, session: tokenActivity("session") } }),
      ).success,
    ).toBe(false);
  });
});

function hookRecord(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    observedAt: NOW,
    hook_event_name: "UserPromptSubmit",
    session_id: "thread-aaaa1111",
    turn_id: "turn-bbbb2222",
    model: "gpt-5.4",
    cwd: "/Users/example/project",
    ...overrides,
  };
}

function omit(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

describe("CodexHookRecordSchema (CODEX-06, D-19)", () => {
  it("Test 5: accepts each of the five registered events", () => {
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "Interrupt", "SessionEnd"]) {
      expect(
        CodexHookRecordSchema.safeParse(hookRecord({ hook_event_name: event })).success,
        event,
      ).toBe(true);
    }
    expect(
      CodexHookRecordSchema.safeParse(
        omit(hookRecord({ hook_event_name: "SessionStart", source: "startup" }), ["turn_id"]),
      ).success,
    ).toBe(true);
    expect(
      CodexHookRecordSchema.safeParse(
        omit(hookRecord({ hook_event_name: "SessionEnd", reason: "other" }), ["turn_id", "model"]),
      ).success,
    ).toBe(true);
  });

  it("refuses a sixth event name", () => {
    for (const event of ["PreToolUse", "PostToolUse", "PermissionRequest", "SubagentStop", ""]) {
      expect(
        CodexHookRecordSchema.safeParse(hookRecord({ hook_event_name: event })).success,
        event,
      ).toBe(false);
    }
  });

  it("refuses prompt, assistant message and transcript path members", () => {
    for (const extra of [
      { prompt: "secret request" },
      { last_assistant_message: "secret reply" },
      { transcript_path: "/Users/example/.codex/sessions/rollout.jsonl" },
      { permission_mode: "default" },
    ]) {
      expect(
        CodexHookRecordSchema.safeParse(hookRecord(extra)).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it("guards the identifiers, model, cwd, source and reason", () => {
    expect(CodexHookRecordSchema.safeParse(hookRecord({ session_id: "a b" })).success).toBe(false);
    expect(CodexHookRecordSchema.safeParse(hookRecord({ turn_id: "x".repeat(129) })).success).toBe(
      false,
    );
    expect(CodexHookRecordSchema.safeParse(hookRecord({ model: "a/b" })).success).toBe(false);
    expect(CodexHookRecordSchema.safeParse(hookRecord({ cwd: "relative/path" })).success).toBe(
      false,
    );
    expect(CodexHookRecordSchema.safeParse(hookRecord({ cwd: "/a\0b" })).success).toBe(false);
    expect(CodexHookRecordSchema.safeParse(hookRecord({ source: "has space" })).success).toBe(
      false,
    );
    expect(CodexHookRecordSchema.safeParse(hookRecord({ reason: "x".repeat(33) })).success).toBe(
      false,
    );
    expect(CodexHookRecordSchema.safeParse(hookRecord({ eventId: "not-a-uuid" })).success).toBe(
      false,
    );
  });
});
