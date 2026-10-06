import type { KnownHookEvent, RunId, SessionRun } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  at,
  DEFAULT_EVIDENCE_SEED,
  fixedRunId,
  hook,
  InMemoryRunIndex,
  inactivityTimeout,
  launchFailed,
  launchRegistered,
  launchStarted,
  mulberry32,
  PID_1,
  PID_2,
  pidAlive,
  pidGone,
  SESSION_A,
  SESSION_B,
  SESSION_C,
  seededPick,
  seededRunId,
  seedRun,
  sessionStart,
  startFacts,
  startTimeout,
  terminateRequested,
  testRunIdMinter,
} from "../test-support/evidence.js";
import { type Evidence, normalizeSessionEndReason, type ReduceResult, reduce } from "./reducer.js";

/** Far enough ahead that no fixture timestamp is clamped unless a row means it to be. */
const NOW = at(100_000);

const R1 = fixedRunId("runone");
const R2 = fixedRunId("runtwo");

interface Outcome {
  readonly index: InMemoryRunIndex;
  readonly results: readonly ReduceResult[];
  readonly last: ReduceResult;
  run(runId: RunId): SessionRun;
  only(): SessionRun;
}

/** Folds evidence through `reduce`, applying each result's upserts to an in-memory index. */
function play(initial: readonly SessionRun[], evidence: readonly Evidence[], now = NOW): Outcome {
  const index = new InMemoryRunIndex(initial);
  const mint = testRunIdMinter("new");
  const results: ReduceResult[] = [];
  for (const item of evidence) {
    const result = reduce(index, item, now, mint);
    index.apply(result.upserts);
    results.push(result);
  }
  const last = results.at(-1) ?? { upserts: [], rejected: [] };
  return {
    index,
    results,
    last,
    run(runId) {
      const found = index.byRunId(runId);
      if (found === null) throw new Error(`no Run ${runId}`);
      return found;
    },
    only() {
      const all = index.all();
      expect(all).toHaveLength(1);
      return all[0] as SessionRun;
    },
  };
}

/** The Run a reduce created (a RunId that was not in the initial index). */
function created(outcome: Outcome, initial: readonly SessionRun[]): SessionRun {
  const known = new Set(initial.map((run) => run.runId));
  const fresh = outcome.index.all().filter((run) => !known.has(run.runId));
  expect(fresh).toHaveLength(1);
  return fresh[0] as SessionRun;
}

interface Row {
  readonly name: string;
  readonly initial: readonly SessionRun[];
  readonly evidence: readonly Evidence[];
  readonly check: (outcome: Outcome, initial: readonly SessionRun[]) => void;
}

describe("session reducer — identity and linking (D-21)", () => {
  const rows: Row[] = [
    {
      name: "a first SessionStart opens a running Run keyed by session and PID, at revision 1",
      initial: [],
      evidence: [sessionStart("startup", { observedAt: at(1) })],
      check: (o) => {
        expect(o.only()).toMatchObject({
          state: "running",
          claudeSessionId: SESSION_A,
          pid: PID_1,
          revision: 1,
          startedAt: at(1),
          launchSource: "terminal",
          projectId: "project-synthetic-1",
          pidStartedAt: "Mon Sep 28 12:00:00 2026",
          linkKind: null,
          linkedFromRunId: null,
          endedAt: null,
        });
      },
    },
    {
      name: "a SessionStart after compaction updates the same Run and never opens another",
      initial: [seedRun({ runId: R1, revision: 3 })],
      evidence: [sessionStart("compact", { fields: { model: "claude-synthetic-2" } })],
      check: (o) => {
        expect(o.only()).toMatchObject({ runId: R1, revision: 4, model: "claude-synthetic-2" });
      },
    },
    {
      name: "a compaction SessionStart for a session with no Run opens nothing",
      initial: [],
      evidence: [sessionStart("compact")],
      check: (o) => {
        expect(o.index.all()).toHaveLength(0);
        expect(o.last.rejected).toEqual([
          { runId: null, from: null, evidence: "hook:SessionStart", reason: "no-run" },
        ]);
      },
    },
    {
      name: "a resume in a new process opens a new Run linked to the session's latest Run",
      initial: [seedRun({ runId: R1, state: "completed", endedAt: at(5) })],
      evidence: [sessionStart("resume", { pid: PID_2, observedAt: at(10) })],
      check: (o, initial) => {
        expect(created(o, initial)).toMatchObject({
          claudeSessionId: SESSION_A,
          pid: PID_2,
          state: "running",
          linkKind: "resume",
          linkedFromRunId: R1,
          revision: 1,
        });
        expect(o.run(R1)).toEqual(initial[0]);
      },
    },
    {
      name: "a fork carrying CCC_RUN_ID adopts the pre-registered Run with the new session ID (D-33 fallback)",
      initial: [
        seedRun({ runId: R1, state: "completed", endedAt: at(5) }),
        seedRun({
          runId: R2,
          state: "starting",
          pid: null,
          claudeSessionId: SESSION_A,
          linkedFromRunId: R1,
          revision: 2,
        }),
      ],
      evidence: [sessionStart("fork", { sessionId: SESSION_B, pid: PID_2, cccRunId: R2 })],
      check: (o) => {
        expect(o.index.all()).toHaveLength(2);
        expect(o.run(R2)).toMatchObject({
          state: "running",
          claudeSessionId: SESSION_B,
          pid: PID_2,
          linkKind: "fork",
          linkedFromRunId: R1,
          revision: 3,
        });
      },
    },
    {
      name: "/clear on a PID whose Run holds another session completes the old Run and opens a linked one",
      initial: [seedRun({ runId: R1, state: "running", pidStartedAt: "Mon Sep 28 12:00:00 2026" })],
      evidence: [sessionStart("clear", { sessionId: SESSION_B, observedAt: at(20) })],
      check: (o, initial) => {
        expect(o.run(R1)).toMatchObject({ state: "completed", endedAt: at(20), revision: 2 });
        expect(created(o, initial)).toMatchObject({
          claudeSessionId: SESSION_B,
          pid: PID_1,
          state: "running",
          linkKind: "clear",
          linkedFromRunId: R1,
        });
      },
    },
    {
      name: "/clear when the old Run's process start is unknown only links it, never completes it (wave 2 review)",
      initial: [seedRun({ runId: R1, state: "running", pidStartedAt: null })],
      evidence: [sessionStart("clear", { sessionId: SESSION_B, observedAt: at(20) })],
      check: (o, initial) => {
        expect(o.run(R1)).toEqual(initial[0]);
        expect(created(o, initial)).toMatchObject({ linkKind: "clear", linkedFromRunId: R1 });
      },
    },
    {
      name: "/clear when the new record's process start is unknown only links the old Run",
      initial: [seedRun({ runId: R1, state: "running", pidStartedAt: "Mon Sep 28 12:00:00 2026" })],
      evidence: [
        sessionStart(
          "clear",
          { sessionId: SESSION_B, observedAt: at(20) },
          startFacts({ pidStartedAt: null }),
        ),
      ],
      check: (o, initial) => {
        expect(o.run(R1)).toEqual(initial[0]);
        expect(created(o, initial)).toMatchObject({ linkKind: "clear", linkedFromRunId: R1 });
      },
    },
    {
      name: "/clear after the old session's own SessionEnd(clear) still links the new Run to it",
      initial: [seedRun({ runId: R1, state: "running" })],
      evidence: [
        hook("SessionEnd", { observedAt: at(19), fields: { reason: "clear" } }),
        sessionStart("clear", { sessionId: SESSION_B, observedAt: at(20) }),
      ],
      check: (o, initial) => {
        expect(o.run(R1)).toMatchObject({ state: "completed", endedAt: at(19), revision: 2 });
        expect(created(o, initial)).toMatchObject({ linkKind: "clear", linkedFromRunId: R1 });
      },
    },
    {
      name: "a fork on a reused PID (a different process start) is not linked to the old Run",
      initial: [
        seedRun({ runId: R1, state: "completed", pidStartedAt: "Sun Sep 27 09:00:00 2026" }),
      ],
      evidence: [sessionStart("fork", { sessionId: SESSION_B })],
      check: (o, initial) => {
        expect(created(o, initial)).toMatchObject({ linkKind: "fork", linkedFromRunId: null });
      },
    },
    {
      name: "an activity event for a session with no Run (hook installed mid-session) opens a running Run",
      initial: [],
      evidence: [hook("PostToolUse", { sessionId: SESSION_C, observedAt: at(3) })],
      check: (o) => {
        expect(o.only()).toMatchObject({
          claudeSessionId: SESSION_C,
          pid: PID_1,
          state: "running",
          activity: "working",
          lastActivityAt: at(3),
          revision: 1,
        });
      },
    },
  ];

  it.each(rows.map((row) => [row.name, row] as const))(
    "%s",
    (_name, { initial, evidence, check }) => {
      check(play(initial, evidence), initial);
    },
  );
});

describe("session reducer — dashboard launches", () => {
  const rows: Row[] = [
    {
      name: "a registered launch is queued, with no PID and no invented session",
      initial: [],
      evidence: [launchRegistered(R1, at(1))],
      check: (o) => {
        expect(o.only()).toMatchObject({
          runId: R1,
          state: "queued",
          pid: null,
          claudeSessionId: null,
          cwd: "/Users/USERNAME/code/synthetic-project",
          startedAt: at(1),
          revision: 1,
        });
      },
    },
    {
      name: "a started launch is starting",
      initial: [],
      evidence: [launchRegistered(R1, at(1)), launchStarted(R1, at(2))],
      check: (o) => {
        expect(o.only()).toMatchObject({ state: "starting", revision: 2 });
      },
    },
    {
      name: "a launch that fails to start is failed, with an end time",
      initial: [],
      evidence: [launchRegistered(R1, at(1)), launchStarted(R1, at(2)), launchFailed(R1, at(3))],
      check: (o) => {
        expect(o.only()).toMatchObject({ state: "failed", endedAt: at(3) });
      },
    },
    {
      name: "a SessionStart carrying the launch's CCC_RUN_ID makes that Run running",
      initial: [],
      evidence: [
        launchRegistered(R1, at(1)),
        launchStarted(R1, at(2)),
        sessionStart("startup", { cccRunId: R1, observedAt: at(4) }),
      ],
      check: (o) => {
        expect(o.only()).toMatchObject({
          runId: R1,
          state: "running",
          claudeSessionId: SESSION_A,
          pid: PID_1,
          launchSource: "terminal",
        });
      },
    },
    {
      name: "a starting Run with no SessionStart before the start timeout becomes stale",
      initial: [],
      evidence: [launchRegistered(R1, at(1)), launchStarted(R1, at(2)), startTimeout(R1, at(62))],
      check: (o) => {
        expect(o.only()).toMatchObject({ state: "stale", endedAt: null });
      },
    },
  ];

  it.each(rows.map((row) => [row.name, row] as const))(
    "%s",
    (_name, { initial, evidence, check }) => {
      check(play(initial, evidence), initial);
    },
  );
});

describe("session reducer — activity (D-18)", () => {
  const ACTIVITY_EVENTS: readonly KnownHookEvent[] = [
    "UserPromptSubmit",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionDenied",
    "SubagentStart",
    "TaskCreated",
    "TaskCompleted",
  ];
  /** The events that clear waiting-for-approval (SESS-09 must-have; RESEARCH Q7, Pitfall 5). */
  const WAITING_CLEARERS: readonly KnownHookEvent[] = [
    "UserPromptSubmit",
    "PostToolUse",
    "PostToolUseFailure",
  ];

  it.each(ACTIVITY_EVENTS)(
    "%s marks a running session working and records the activity time",
    (event) => {
      const o = play([seedRun({ runId: R1 })], [hook(event, { observedAt: at(7) })]);
      expect(o.only()).toMatchObject({
        state: "running",
        activity: "working",
        lastActivityAt: at(7),
      });
    },
  );

  it.each(ACTIVITY_EVENTS)("%s on a stale Run revives it to running", (event) => {
    const o = play([seedRun({ runId: R1, state: "stale" })], [hook(event)]);
    expect(o.only()).toMatchObject({ state: "running", activity: "working" });
  });

  it.each(WAITING_CLEARERS)("%s moves a waiting Run back to running", (event) => {
    const o = play([seedRun({ runId: R1, state: "waiting-for-approval" })], [hook(event)]);
    expect(o.only()).toMatchObject({ state: "running", activity: "working" });
  });

  it.each(ACTIVITY_EVENTS.filter((event) => !WAITING_CLEARERS.includes(event)))(
    "%s records activity but does not clear waiting-for-approval (it never follows a dialog)",
    (event) => {
      const o = play([seedRun({ runId: R1, state: "waiting-for-approval" })], [hook(event)]);
      expect(o.only()).toMatchObject({ state: "waiting-for-approval", activity: "working" });
    },
  );

  const rows: Row[] = [
    {
      name: "Stop marks the session idle without changing its state",
      initial: [seedRun({ runId: R1, activity: "working" })],
      evidence: [hook("Stop")],
      check: (o) => {
        expect(o.only()).toMatchObject({ state: "running", activity: "idle" });
      },
    },
    {
      name: "Stop after a permission prompt moves the Run back to running, idle",
      initial: [seedRun({ runId: R1, state: "waiting-for-approval" })],
      evidence: [hook("Stop")],
      check: (o) => {
        expect(o.only()).toMatchObject({ state: "running", activity: "idle" });
      },
    },
    {
      name: "Notification idle_prompt marks the session idle",
      initial: [seedRun({ runId: R1, activity: "working" })],
      evidence: [hook("Notification", { fields: { notification_type: "idle_prompt" } })],
      check: (o) => {
        expect(o.only()).toMatchObject({ state: "running", activity: "idle" });
      },
    },
    {
      name: "StopFailure rate_limit records the error and does not fail the Run",
      initial: [seedRun({ runId: R1, activity: "working" })],
      evidence: [hook("StopFailure", { fields: { stop_error: "rate_limit" } })],
      check: (o) => {
        expect(o.only()).toMatchObject({
          state: "running",
          lastError: "rate_limit",
          endedAt: null,
        });
      },
    },
    {
      name: "PermissionRequest moves the Run to waiting for approval, and the next PostToolUse moves it back",
      initial: [seedRun({ runId: R1 })],
      evidence: [hook("PermissionRequest"), hook("PostToolUse")],
      check: (o) => {
        expect(o.results[0]?.upserts[0]?.state).toBe("waiting-for-approval");
        expect(o.only().state).toBe("running");
      },
    },
    {
      name: "Notification permission_prompt moves the Run to waiting for approval",
      initial: [seedRun({ runId: R1 })],
      evidence: [hook("Notification", { fields: { notification_type: "permission_prompt" } })],
      check: (o) => {
        expect(o.only().state).toBe("waiting-for-approval");
      },
    },
    {
      name: "PostModelSwitch sets the model to to_model",
      initial: [seedRun({ runId: R1, model: "claude-synthetic-1" })],
      evidence: [
        hook("PostModelSwitch", {
          fields: { from_model: "claude-synthetic-1", to_model: "claude-synthetic-3" },
        }),
      ],
      check: (o) => {
        expect(o.only().model).toBe("claude-synthetic-3");
      },
    },
    {
      name: "SubagentStart then SubagentStop with the same agent_id brings the active count back to 0 and keeps lastType",
      initial: [seedRun({ runId: R1 })],
      evidence: [
        hook("SubagentStart", { fields: { agent_id: "agent-1", agent_type: "Explore" } }),
        hook("SubagentStop", { fields: { agent_id: "agent-1", agent_type: "Explore" } }),
      ],
      check: (o) => {
        expect(o.results[0]?.upserts[0]?.subagentActiveIds).toEqual(["agent-1"]);
        expect(o.only()).toMatchObject({ subagentActiveIds: [], subagentLastType: "Explore" });
      },
    },
    {
      name: "SubagentStop without an agent_type still removes its agent id",
      initial: [seedRun({ runId: R1, subagentActiveIds: ["agent-2"], subagentLastType: "Plan" })],
      evidence: [hook("SubagentStop", { fields: { agent_id: "agent-2" } })],
      check: (o) => {
        expect(o.only()).toMatchObject({ subagentActiveIds: [], subagentLastType: "Plan" });
      },
    },
    {
      name: "a SessionStart without a model leaves the previous model unchanged and writes no placeholder",
      initial: [
        seedRun({ runId: R1, model: "claude-synthetic-1", transcriptPath: "/t/one.jsonl" }),
      ],
      evidence: [
        sessionStart("compact", {}, startFacts({ transcriptPath: null, projectId: null })),
      ],
      check: (o) => {
        expect(o.only()).toMatchObject({
          model: "claude-synthetic-1",
          transcriptPath: "/t/one.jsonl",
        });
      },
    },
    {
      name: "a new Run from a SessionStart without a model has a null model, never a placeholder",
      initial: [],
      evidence: [sessionStart("startup")],
      check: (o) => {
        expect(o.only()).toMatchObject({ model: null, name: null, effort: null });
      },
    },
    {
      name: "Notification and PostModelSwitch advance lastActivityAt like other live evidence",
      initial: [seedRun({ runId: R1, lastActivityAt: at(1) })],
      evidence: [
        hook("Notification", {
          observedAt: at(50),
          fields: { notification_type: "permission_prompt" },
        }),
        hook("PostModelSwitch", {
          observedAt: at(60),
          fields: { from_model: "claude-synthetic-1", to_model: "claude-synthetic-3" },
        }),
      ],
      check: (o) => {
        expect(o.results[0]?.upserts[0]?.lastActivityAt).toBe(at(50));
        expect(o.only().lastActivityAt).toBe(at(60));
      },
    },
    {
      name: "a record stamped after now is recorded at now",
      initial: [seedRun({ runId: R1 })],
      evidence: [hook("PostToolUse", { observedAt: at(200_000) })],
      check: (o) => {
        expect(o.only().lastActivityAt).toBe(NOW);
      },
    },
  ];

  it.each(rows.map((row) => [row.name, row] as const))(
    "%s",
    (_name, { initial, evidence, check }) => {
      check(play(initial, evidence), initial);
    },
  );
});

describe("session reducer — endings, stale and terminate (D-18, D-19, D-20, PR-02)", () => {
  const rows: Row[] = [
    {
      name: "SessionEnd without a pending terminate completes the Run with an end time",
      initial: [seedRun({ runId: R1, activity: "working" })],
      evidence: [
        hook("SessionEnd", { observedAt: at(30), fields: { reason: "prompt_input_exit" } }),
      ],
      check: (o) => {
        expect(o.only()).toMatchObject({ state: "completed", endedAt: at(30), activity: null });
      },
    },
    {
      name: "SessionEnd with a reason Claude Code no longer documents still completes the Run",
      initial: [seedRun({ runId: R1 })],
      evidence: [hook("SessionEnd", { fields: { reason: "bypass_permissions_disabled" } })],
      check: (o) => {
        expect(o.only().state).toBe("completed");
      },
    },
    {
      name: "SessionEnd while a terminate is pending only records that the end was observed",
      initial: [seedRun({ runId: R1, terminateRequestedAt: at(29) })],
      evidence: [hook("SessionEnd", { observedAt: at(30), fields: { reason: "other" } })],
      check: (o) => {
        expect(o.only()).toMatchObject({ state: "running", endObservedAt: at(30), endedAt: null });
      },
    },
    {
      name: "terminate requested, then SessionEnd, then PID gone ends cancelled",
      initial: [seedRun({ runId: R1 })],
      evidence: [
        terminateRequested(R1, at(29)),
        hook("SessionEnd", { observedAt: at(30), fields: { reason: "other" } }),
        pidGone(R1, at(31)),
      ],
      check: (o) => {
        expect(o.only()).toMatchObject({
          state: "cancelled",
          terminateRequestedAt: at(29),
          endObservedAt: at(30),
          promptSeenAt: null,
          endedAt: at(31),
        });
      },
    },
    {
      name: "the same sequence without the terminate ends completed, and a later PID gone changes nothing",
      initial: [seedRun({ runId: R1 })],
      evidence: [
        hook("SessionEnd", { observedAt: at(30), fields: { reason: "other" } }),
        pidGone(R1, at(31)),
      ],
      check: (o) => {
        expect(o.only()).toMatchObject({ state: "completed", endedAt: at(30), revision: 2 });
        expect(o.last.upserts).toEqual([]);
      },
    },
    {
      name: "PID gone without SessionEnd makes a running Run stale, never completed",
      initial: [seedRun({ runId: R1 })],
      evidence: [pidGone(R1, at(40))],
      check: (o) => {
        expect(o.only()).toMatchObject({ state: "stale", endedAt: null });
      },
    },
    {
      name: "PID gone makes a waiting-for-approval Run stale",
      initial: [seedRun({ runId: R1, state: "waiting-for-approval" })],
      evidence: [pidGone(R1, at(40))],
      check: (o) => {
        expect(o.only().state).toBe("stale");
      },
    },
    {
      name: "PID alive revives a stale Run to running",
      initial: [seedRun({ runId: R1, state: "stale" })],
      evidence: [pidAlive(R1, at(41))],
      check: (o) => {
        expect(o.only().state).toBe("running");
      },
    },
    {
      name: "SessionEnd on a stale Run completes it (later truth wins)",
      initial: [seedRun({ runId: R1, state: "stale" })],
      evidence: [hook("SessionEnd", { observedAt: at(42) })],
      check: (o) => {
        expect(o.only()).toMatchObject({ state: "completed", endedAt: at(42) });
      },
    },
    {
      name: "inactivity timeout on a PID-less running Run makes it stale",
      initial: [seedRun({ runId: R1, pid: null })],
      evidence: [inactivityTimeout(R1, at(900))],
      check: (o) => {
        expect(o.only().state).toBe("stale");
      },
    },
    {
      name: "inactivity timeout on a Run with a PID changes nothing (liveness decides)",
      initial: [seedRun({ runId: R1 })],
      evidence: [inactivityTimeout(R1, at(900))],
      check: (o) => {
        expect(o.only()).toMatchObject({ state: "running", revision: 1 });
        expect(o.last).toEqual({ upserts: [], rejected: [] });
      },
    },
    {
      name: "evidence naming a RunId the index does not know is rejected as unknown-run",
      initial: [],
      evidence: [pidGone(R2, at(1))],
      check: (o) => {
        expect(o.last.rejected).toEqual([
          { runId: R2, from: null, evidence: "pid-gone", reason: "unknown-run" },
        ]);
      },
    },
  ];

  it.each(rows.map((row) => [row.name, row] as const))(
    "%s",
    (_name, { initial, evidence, check }) => {
      check(play(initial, evidence), initial);
    },
  );

  it("normalizes a SessionEnd reason outside the documented list to other", () => {
    expect(normalizeSessionEndReason("bypass_permissions_disabled")).toBe("other");
    expect(normalizeSessionEndReason(undefined)).toBe("other");
    expect(normalizeSessionEndReason("logout")).toBe("logout");
  });

  it("raises a Run's revision by exactly one on every upsert", () => {
    const o = play(
      [seedRun({ runId: R1, revision: 7 })],
      [hook("PostToolUse"), hook("Stop"), hook("PermissionRequest"), hook("PostToolUse")],
    );
    const revisions = o.results.flatMap((result) => result.upserts.map((run) => run.revision));
    expect(revisions).toEqual([8, 9, 10, 11]);
  });
});

describe("session reducer — terminal states are final (D-20)", () => {
  const TERMINAL = ["completed", "failed", "cancelled"] as const;
  const PROBES: readonly { readonly label: string; readonly evidence: () => Evidence }[] = [
    { label: "hook:PostToolUse", evidence: () => hook("PostToolUse") },
    { label: "hook:SessionEnd", evidence: () => hook("SessionEnd") },
    { label: "hook:SessionStart", evidence: () => sessionStart("compact") },
    { label: "pid-alive", evidence: () => pidAlive(R1, at(50)) },
    { label: "pid-gone", evidence: () => pidGone(R1, at(50)) },
    { label: "terminate-requested", evidence: () => terminateRequested(R1, at(50)) },
    { label: "launch-started", evidence: () => launchStarted(R1, at(50)) },
    { label: "launch-failed", evidence: () => launchFailed(R1, at(50)) },
  ];
  const cases = TERMINAL.flatMap((state) => PROBES.map((probe) => ({ state, ...probe })));

  it.each(cases)(
    "$label on a $state Run is rejected, naming the from-state and the evidence, and nothing is written",
    ({ state, label, evidence }) => {
      const initial = [seedRun({ runId: R1, state, endedAt: at(5) })];
      const o = play(initial, [evidence()]);
      expect(o.last.upserts).toEqual([]);
      expect(o.last.rejected).toEqual([
        { runId: R1, from: state, evidence: label, reason: "terminal" },
      ]);
      expect(o.run(R1)).toEqual(initial[0]);
    },
  );
});

describe("session reducer — never completed by inference (property, SESS-06)", () => {
  /**
   * Every evidence shape except the explicit endings: SessionEnd, launch-failed
   * and SessionStart source "clear" (which D-21 defines as ending the old Run,
   * the explicit fallback when its SessionEnd was lost).
   */
  const NON_ENDING_HOOKS: readonly Exclude<KnownHookEvent, "SessionEnd" | "SessionStart">[] = [
    "Stop",
    "StopFailure",
    "Notification",
    "SubagentStart",
    "SubagentStop",
    "TaskCreated",
    "TaskCompleted",
    "UserPromptSubmit",
    "PermissionRequest",
    "PermissionDenied",
    "PostModelSwitch",
    "PostToolUse",
    "PostToolUseFailure",
  ];
  const START_SOURCES = ["startup", "resume", "compact", "fork"] as const;
  const SESSIONS = [SESSION_A, SESSION_B, SESSION_C];
  const PIDS: readonly (number | null)[] = [PID_1, PID_2, null];
  const KINDS = [
    "hook",
    "session-start",
    "pid-gone",
    "pid-alive",
    "start-timeout",
    "inactivity-timeout",
    "launch-registered",
    "launch-started",
    "terminate-requested",
  ] as const;

  function draw(next: () => number, index: InMemoryRunIndex, step: number): Evidence {
    const known = index.all().map((run) => run.runId);
    const runId = (): RunId =>
      known.length > 0 && next() < 0.85 ? seededPick(next, known) : seededRunId(next);
    const when = at(step);
    const recordOptions = () => {
      const cccRunId = known.length > 0 && next() < 0.2 ? seededPick(next, known) : undefined;
      return {
        sessionId: seededPick(next, SESSIONS),
        pid: seededPick(next, PIDS),
        observedAt: when,
        ...(cccRunId === undefined ? {} : { cccRunId }),
      };
    };
    const kind = seededPick(next, KINDS);
    switch (kind) {
      case "hook": {
        const event = seededPick(next, NON_ENDING_HOOKS);
        const fields: Record<string, unknown> = {};
        if (event === "StopFailure") fields.stop_error = "overloaded";
        if (event === "Notification") {
          fields.notification_type = seededPick(next, ["permission_prompt", "idle_prompt", "x"]);
        }
        if (event === "SubagentStart" || event === "SubagentStop") {
          fields.agent_id = seededPick(next, ["a1", "a2"]);
        }
        if (event === "PostModelSwitch") fields.to_model = "claude-synthetic-9";
        return hook(event, { ...recordOptions(), fields });
      }
      case "session-start":
        return sessionStart(seededPick(next, START_SOURCES), recordOptions());
      case "pid-gone":
        return pidGone(runId(), when);
      case "pid-alive":
        return pidAlive(runId(), when);
      case "start-timeout":
        return startTimeout(runId(), when);
      case "inactivity-timeout":
        return inactivityTimeout(runId(), when);
      case "launch-registered":
        return launchRegistered(seededRunId(next), when, {
          claudeSessionId: next() < 0.5 ? null : seededPick(next, SESSIONS),
        });
      case "launch-started":
        return launchStarted(runId(), when);
      case "terminate-requested":
        return terminateRequested(runId(), when);
    }
  }

  it("500 seeded evidence sequences without an explicit ending never produce completed or failed", () => {
    const next = mulberry32(DEFAULT_EVIDENCE_SEED);
    let upsertCount = 0;
    for (let sequence = 0; sequence < 500; sequence += 1) {
      const index = new InMemoryRunIndex();
      const mint = testRunIdMinter(`p${sequence.toString(36)}`);
      const length = 5 + Math.floor(next() * 36);
      for (let step = 1; step <= length; step += 1) {
        const item = draw(next, index, step);
        const before = new Map(index.all().map((run) => [run.runId, run.revision]));
        const result = reduce(index, item, NOW, mint);
        for (const run of result.upserts) {
          expect(["completed", "failed"]).not.toContain(run.state);
          expect(run.revision).toBe((before.get(run.runId) ?? 0) + 1);
        }
        upsertCount += result.upserts.length;
        index.apply(result.upserts);
      }
    }
    // A generator that never reached the reducer's write paths would prove nothing.
    expect(upsertCount).toBeGreaterThan(2000);
  });
});

describe("session reducer — conversation proof (05-UAT)", () => {
  it("UserPromptSubmit records the first proof of a turn and keeps it", () => {
    const o = play(
      [seedRun({ runId: R1 })],
      [
        hook("UserPromptSubmit", { observedAt: at(7) }),
        hook("UserPromptSubmit", { observedAt: at(9) }),
      ],
    );
    expect(o.only().promptSeenAt).toBe(at(7));
  });

  it("a session that ends without a prompt never records one", () => {
    const o = play(
      [seedRun({ runId: R1 })],
      [hook("Notification", { observedAt: at(5) }), hook("SessionEnd", { observedAt: at(8) })],
    );
    expect(o.only()).toMatchObject({ state: "completed", promptSeenAt: null });
  });
});
