import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexSessionViewSchema } from "@ccc/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attribution, AttributionInput } from "../claude/attribution.js";
import {
  createRunWorld,
  DECOY_REPORT_TEXT,
  DECOY_WORKTREE,
  type RunWorld,
  recordingRunFs,
  rolloutLimitLine,
  runIdAt,
  SESSION_A,
  SESSION_B,
  startHeldReview,
  type WorldProject,
  WRAPPER_FAKE_SESSION_ID,
  writeLiveLog,
  writePendingResume,
  writeRunRecord,
} from "../test-support/codex-run-fixtures.js";
import {
  createFakeCodexHome,
  type FakeCodexHome,
  type FakeThread,
  rolloutContent,
  rolloutLifecycleLine,
  rolloutMetaLine,
} from "../test-support/fake-codex-home.js";
import { createCodexHomePort } from "./codex-home.js";
import { defaultHeadroomTimers } from "./headroom-service.js";
import { createRunOverlay, decideRunState, type RunStateInput } from "./run-overlay.js";
import { createRunRecordReader, nodeRunRecordFs, type RunRecordReader } from "./run-records.js";
import {
  type CodexSessionMirror,
  type CodexSessionMirrorDeps,
  createCodexSessionMirror,
} from "./session-mirror.js";
import { createCodexStoreReader } from "./store-reader.js";

const MINUTE = 60_000;
const INACTIVITY = 30 * MINUTE;
const VIEW_KEYS = Object.keys(CodexSessionViewSchema.shape).sort();

const cleanups: Array<() => void> = [];
/** Every overlay log line of every test in this file (Test 8: reason codes only). */
const logged: string[] = [];
const logger = {
  warn(fields: { readonly reason: string }, message: string) {
    logged.push(JSON.stringify([fields, message]));
  },
};
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface ThreadSpec {
  readonly id: string;
  /** Milliseconds before `clock.now` of the thread's last update. */
  readonly agoMs: number;
  /** Lifecycle lines as `[event, agoMs]`. */
  readonly lifecycle?: ReadonlyArray<readonly [string, number]>;
  readonly extraLines?: readonly string[];
  readonly cwd?: string;
}

interface MirrorWorld {
  readonly mirror: CodexSessionMirror;
  readonly clock: { now: number };
  readonly attributeCalls: AttributionInput[];
  readonly home: FakeCodexHome;
}

/** A real session mirror over a fake Codex home; attribution finds no project. */
function buildMirror(
  specs: readonly ThreadSpec[],
  clock = { now: Date.now() },
  extra: {
    readonly subscribers?: () => number;
    readonly timers?: CodexSessionMirrorDeps["timers"];
  } = {},
): MirrorWorld {
  const at = (agoMs: number): number => clock.now - agoMs;
  const threads: FakeThread[] = specs.map((spec) => ({
    id: spec.id,
    updatedAtMs: at(spec.agoMs),
    cwd: spec.cwd ?? "/Users/USERNAME/repo",
  }));
  const home = createFakeCodexHome({
    rollouts: specs.map((spec) => ({
      day: "2026-10-06",
      name: `rollout-${spec.id}.jsonl`,
      content: rolloutContent(
        rolloutMetaLine({ id: spec.id, atMs: at(spec.agoMs + MINUTE) }),
        ...(spec.lifecycle ?? []).map(([event, ago]) =>
          rolloutLifecycleLine(event as "task_started", at(ago)),
        ),
        ...(spec.extraLines ?? []),
      ),
      mtimeMs: at(spec.agoMs),
    })),
    database: { ddl: "current", threads },
  });
  cleanups.push(() => home.cleanup());
  const port = createCodexHomePort({ root: home.root });
  const reader = createCodexStoreReader({ port, now: () => clock.now });
  const attributeCalls: AttributionInput[] = [];
  const mirror = createCodexSessionMirror({
    port,
    reader,
    attribute: async (input): Promise<Attribution> => {
      attributeCalls.push(input);
      return { projectId: null, worktreeRoot: null, reason: "no-match" };
    },
    projectName: () => null,
    analysisOn: () => false,
    subscribers: extra.subscribers ?? (() => 1),
    publish: vi.fn(),
    now: () => clock.now,
    timers: extra.timers ?? defaultHeadroomTimers,
  });
  return { mirror, clock, attributeCalls, home };
}

function sessionsOf(mirror: CodexSessionMirror) {
  const snapshot = mirror.snapshot();
  if (snapshot === null || snapshot.kind !== "available") throw new Error("expected available");
  return snapshot.sessions;
}

function sessionFor(mirror: CodexSessionMirror, threadId: string) {
  const found = sessionsOf(mirror).find((session) => session.threadId === threadId);
  if (found === undefined) throw new Error(`no session ${threadId}`);
  return found;
}

interface Rig {
  readonly world: RunWorld;
  readonly project: WorldProject;
  readonly reader: RunRecordReader;
  readonly mirrorWorld: MirrorWorld;
}

function rig(specs: readonly ThreadSpec[]): Rig {
  const world = createRunWorld();
  cleanups.push(() => world.cleanup());
  const project = world.addProject();
  const reader = createRunRecordReader({
    listProjects: () => world.listProjects(),
    bridgeStateDir: world.bridgeState,
    home: world.home,
    fs: nodeRunRecordFs,
  });
  return { world, project, reader, mirrorWorld: buildMirror(specs) };
}

function overlayFor(r: Rig, over: { readonly inactivityMs?: number } = {}) {
  return createRunOverlay({
    reader: r.reader,
    mirror: r.mirrorWorld.mirror,
    now: () => r.mirrorWorld.clock.now,
    inactivityMs: over.inactivityMs ?? INACTIVITY,
    logger,
  });
}

const RUNNING_THREAD: ThreadSpec = {
  id: SESSION_A,
  agoMs: 2 * MINUTE,
  lifecycle: [["task_started", 3 * MINUTE]],
};

describe("Test 1 (tracer): a REAL wrapper review marks its Codex thread as a review run with a live log", () => {
  it("joins the producer's running record, then its ok record, through the overlay and never opens a report", async () => {
    const held = startHeldReview();
    cleanups.push(() => held.cleanup());
    const clock = { now: Date.now() };
    const mirrorWorld = buildMirror(
      [
        {
          id: WRAPPER_FAKE_SESSION_ID,
          agoMs: 2 * MINUTE,
          lifecycle: [["task_started", 3 * MINUTE]],
          cwd: held.repoRoot,
        },
      ],
      clock,
    );
    const recorded = recordingRunFs(nodeRunRecordFs);
    const reader = createRunRecordReader({
      listProjects: () => [{ projectId: "proj-held", name: "Held", root: held.repoRoot }],
      bridgeStateDir: join(held.home, ".local", "state", "codex-bridge"),
      home: held.home,
      fs: recorded.fs,
    });
    const overlay = createRunOverlay({
      reader,
      mirror: mirrorWorld.mirror,
      now: () => clock.now,
      inactivityMs: INACTIVITY,
    });

    const announced = await held.waitForSession();
    await overlay.refresh();
    await mirrorWorld.mirror.pollNow();

    const running = sessionFor(mirrorWorld.mirror, WRAPPER_FAKE_SESSION_ID);
    expect(Object.keys(running).sort()).toEqual(VIEW_KEYS);
    expect(running).toMatchObject({
      origin: "review",
      state: "running",
      projectId: "proj-held",
      projectName: "Held",
      liveLogRunId: announced.runId,
    });
    const first = reader.last().runs[0];
    expect(first).toMatchObject({
      runId: announced.runId,
      kind: "review",
      mode: "headless",
      sessionId: WRAPPER_FAKE_SESSION_ID,
      status: "running",
    });
    // No path, worktree or record text reached the view.
    expect(JSON.stringify(running)).not.toContain(held.repoRoot);
    expect(JSON.stringify(running)).not.toContain(held.home);

    expect(await held.release()).toBe(0);
    // The fake's rollout goes quiet and the unreported end ages to stale on its own.
    clock.now += 40 * MINUTE;
    await overlay.refresh();
    await mirrorWorld.mirror.pollNow();
    const finished = sessionFor(mirrorWorld.mirror, WRAPPER_FAKE_SESSION_ID);
    // The explicit end report: the ok record turns the aged, unfinished view into completed.
    expect(finished).toMatchObject({
      origin: "review",
      state: "completed",
      liveLogRunId: null,
      projectId: "proj-held",
    });
    expect(reader.last().runs[0]).toMatchObject({ runId: announced.runId, status: "ok" });

    // The wrote-a-report-at-the-end run never had its report opened.
    expect(recorded.calls.some((call) => call.path.includes("/reports"))).toBe(false);
    overlay.dispose();
  }, 90_000);
});

describe("Test 5 and Test 6: origin and live log rules", () => {
  it("sets the origin, project and live log for a running headless review with a fresh log", async () => {
    const r = rig([RUNNING_THREAD]);
    const record = writeRunRecord(r.project.localState, { kind: "review", mode: "headless" });
    writeLiveLog(r.project.localState, record.runId, "review", { mtimeMs: Date.now() - 5_000 });
    const overlay = overlayFor(r);
    await overlay.refresh();
    await r.mirrorWorld.mirror.pollNow();
    const session = sessionFor(r.mirrorWorld.mirror, SESSION_A);
    expect(session).toMatchObject({
      origin: "review",
      projectId: r.project.projectId,
      projectName: r.project.name,
      liveLogRunId: record.runId,
      state: "running",
    });
    expect(Object.keys(session).sort()).toEqual(VIEW_KEYS);
    const text = JSON.stringify(session);
    expect(text).not.toContain(r.project.root);
    expect(text).not.toContain("sessions");
  });

  it("gives origin and project but no live log when the log is untouched longer than the inactivity window", async () => {
    const r = rig([RUNNING_THREAD]);
    const record = writeRunRecord(r.project.localState, { kind: "review", mode: "headless" });
    writeLiveLog(r.project.localState, record.runId, "review", {
      mtimeMs: Date.now() - INACTIVITY - 60_000,
    });
    const overlay = overlayFor(r);
    await overlay.refresh();
    await r.mirrorWorld.mirror.pollNow();
    expect(sessionFor(r.mirrorWorld.mirror, SESSION_A)).toMatchObject({
      origin: "review",
      projectId: r.project.projectId,
      liveLogRunId: null,
    });
  });

  it("offers no live log to a tui-mode run, a missing log, a symlinked log or a finished run", async () => {
    for (const variant of ["tui", "missing", "symlink", "ok"] as const) {
      const r = rig([RUNNING_THREAD]);
      const record = writeRunRecord(r.project.localState, {
        kind: "review",
        mode: variant === "tui" ? "tui" : "headless",
        status: variant === "ok" ? "ok" : "running",
      });
      if (variant === "tui" || variant === "ok") {
        writeLiveLog(r.project.localState, record.runId, "review", { mtimeMs: Date.now() });
      } else if (variant === "symlink") {
        const target = join(r.world.base, "real.log");
        writeFileSync(target, "x");
        mkdirSync(join(r.project.localState, "live"), { recursive: true });
        symlinkSync(target, join(r.project.localState, "live", `${record.runId}-review.log`));
      }
      const overlay = overlayFor(r);
      await overlay.refresh();
      await r.mirrorWorld.mirror.pollNow();
      const session = sessionFor(r.mirrorWorld.mirror, SESSION_A);
      expect(session.liveLogRunId, variant).toBeNull();
      expect(session.origin, variant).toBe("review");
    }
  });

  it("maps kinds to origins: review is review, task and resume are headless", async () => {
    for (const [kind, origin] of [
      ["review", "review"],
      ["task", "headless"],
      ["resume", "headless"],
    ] as const) {
      const r = rig([RUNNING_THREAD]);
      writeRunRecord(r.project.localState, { kind, mode: "headless", status: "ok" });
      const overlay = overlayFor(r);
      await overlay.refresh();
      await r.mirrorWorld.mirror.pollNow();
      expect(sessionFor(r.mirrorWorld.mirror, SESSION_A).origin, kind).toBe(origin);
    }
  });

  it("leaves a thread with no matching record untouched", async () => {
    const r = rig([
      RUNNING_THREAD,
      { id: SESSION_B, agoMs: 5 * MINUTE, lifecycle: [["task_started", 6 * MINUTE]] },
    ]);
    writeRunRecord(r.project.localState, { sessionId: SESSION_A, kind: "review", status: "ok" });
    await r.mirrorWorld.mirror.pollNow();
    const before = JSON.stringify(sessionFor(r.mirrorWorld.mirror, SESSION_B));
    const overlay = overlayFor(r);
    await overlay.refresh();
    await r.mirrorWorld.mirror.pollNow();
    expect(JSON.stringify(sessionFor(r.mirrorWorld.mirror, SESSION_B))).toBe(before);
    expect(sessionFor(r.mirrorWorld.mirror, SESSION_A).origin).toBe("review");
  });

  it("an unmatched or malformed record changes nothing", async () => {
    const r = rig([RUNNING_THREAD]);
    writeRunRecord(r.project.localState, { sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
    writeRunRecord(r.project.localState, { sessionId: null });
    writeRunRecord(r.project.localState, { extra: { status: 5 } });
    await r.mirrorWorld.mirror.pollNow();
    const before = JSON.stringify(sessionFor(r.mirrorWorld.mirror, SESSION_A));
    const overlay = overlayFor(r);
    await overlay.refresh();
    await r.mirrorWorld.mirror.pollNow();
    expect(JSON.stringify(sessionFor(r.mirrorWorld.mirror, SESSION_A))).toBe(before);
  });

  it("two records naming the same session resolve to the newest", async () => {
    const r = rig([RUNNING_THREAD]);
    writeRunRecord(r.project.localState, {
      runId: runIdAt(Date.UTC(2026, 9, 10, 9, 0, 0)),
      kind: "review",
      status: "ok",
    });
    const newest = writeRunRecord(r.project.localState, {
      runId: runIdAt(Date.UTC(2026, 9, 10, 10, 0, 0)),
      kind: "task",
      mode: "headless",
      status: "running",
    });
    writeLiveLog(r.project.localState, newest.runId, "task", { mtimeMs: Date.now() - 1_000 });
    const overlay = overlayFor(r);
    await overlay.refresh();
    await r.mirrorWorld.mirror.pollNow();
    expect(sessionFor(r.mirrorWorld.mirror, SESSION_A)).toMatchObject({
      origin: "headless",
      liveLogRunId: newest.runId,
    });
  });

  it("never lets the decoy worktree, fallback or report text through", async () => {
    const r = rig([RUNNING_THREAD]);
    writeRunRecord(r.project.localState, { decoys: true, status: "ok" });
    const overlay = overlayFor(r);
    await overlay.refresh();
    await r.mirrorWorld.mirror.pollNow();
    const all = JSON.stringify(sessionsOf(r.mirrorWorld.mirror));
    expect(all).not.toContain(DECOY_WORKTREE);
    expect(all).not.toContain(DECOY_REPORT_TEXT);
    expect(all).not.toContain("DECOY");
  });
});

describe("Test 7: invalidate-on-change", () => {
  function spyMirror() {
    const invalidate = vi.fn();
    const removeOverlay = vi.fn();
    const removeHook = vi.fn();
    const hooks: Array<() => unknown> = [];
    return {
      invalidate,
      removeOverlay,
      removeHook,
      hooks,
      mirror: {
        addOverlay: vi.fn(() => removeOverlay),
        addTickHook: vi.fn((hook: () => unknown) => {
          hooks.push(hook);
          return removeHook;
        }),
        invalidate,
      },
    };
  }

  it("invalidates once for a new or changed record and not for an unchanged scan", async () => {
    const world = createRunWorld();
    cleanups.push(() => world.cleanup());
    const project = world.addProject();
    const reader = createRunRecordReader({
      listProjects: () => world.listProjects(),
      bridgeStateDir: world.bridgeState,
      home: world.home,
      fs: nodeRunRecordFs,
    });
    const spy = spyMirror();
    const overlay = createRunOverlay({
      reader,
      mirror: spy.mirror,
      now: () => Date.now(),
      inactivityMs: INACTIVITY,
    });
    expect(spy.mirror.addOverlay).toHaveBeenCalledTimes(1);
    expect(spy.mirror.addTickHook).toHaveBeenCalledTimes(1);

    await overlay.refresh();
    expect(spy.invalidate).not.toHaveBeenCalled();

    const first = writeRunRecord(project.localState, {});
    await overlay.refresh();
    expect(spy.invalidate).toHaveBeenCalledTimes(1);
    await overlay.refresh();
    expect(spy.invalidate).toHaveBeenCalledTimes(1);

    writeRunRecord(project.localState, { runId: first.runId, status: "ok" });
    await overlay.refresh();
    expect(spy.invalidate).toHaveBeenCalledTimes(2);

    overlay.dispose();
    expect(spy.removeOverlay).toHaveBeenCalledTimes(1);
    expect(spy.removeHook).toHaveBeenCalledTimes(1);
  });

  it("invalidates when a live log goes stale, even though no record file changed", async () => {
    const world = createRunWorld();
    cleanups.push(() => world.cleanup());
    const project = world.addProject();
    const record = writeRunRecord(project.localState, { mode: "headless" });
    writeLiveLog(project.localState, record.runId, "review", { mtimeMs: 1_000_000 });
    const reader = createRunRecordReader({
      listProjects: () => world.listProjects(),
      bridgeStateDir: world.bridgeState,
      home: world.home,
      fs: nodeRunRecordFs,
    });
    const clock = { now: 1_000_000 + MINUTE };
    const spy = spyMirror();
    const overlay = createRunOverlay({
      reader,
      mirror: spy.mirror,
      now: () => clock.now,
      inactivityMs: INACTIVITY,
    });
    await overlay.refresh();
    expect(spy.invalidate).toHaveBeenCalledTimes(1);
    await overlay.refresh();
    expect(spy.invalidate).toHaveBeenCalledTimes(1);
    clock.now = 1_000_000 + INACTIVITY + MINUTE;
    await overlay.refresh();
    expect(spy.invalidate).toHaveBeenCalledTimes(2);
  });

  it("is driven by the mirror's own tick hook and never throws", async () => {
    const world = createRunWorld();
    cleanups.push(() => world.cleanup());
    world.addProject();
    const failing: RunRecordReader = {
      scan: () => Promise.reject(new Error("boom /Users/USERNAME/secret")),
      last: () => ({ runs: [], pending: [], skipped: {} as never, signature: "" }),
      inspectLiveLog: () => Promise.resolve({ kind: "missing" }),
    };
    const spy = spyMirror();
    const warn = vi.fn();
    const overlay = createRunOverlay({
      reader: failing,
      mirror: spy.mirror,
      now: () => Date.now(),
      inactivityMs: INACTIVITY,
      logger: { warn },
    });
    await spy.hooks[0]?.();
    await overlay.refresh();
    expect(spy.invalidate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("/Users/");
  });
});

// ---------------------------------------------------------------------------
// Task 2: end reports, limit-paused with two signals, resume handling.

const iso = (ms: number): string => new Date(ms).toISOString();

describe("decideRunState: the one reviewable rule table", () => {
  const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
  const RECORDED = iso(T0);
  const base: RunStateInput = {
    state: "running",
    lastActivityAt: iso(T0 - 5 * MINUTE),
    resumesAfter: null,
    limitHitAfter: false,
    lastLifecycleAt: iso(T0 - 6 * MINUTE),
    record: null,
    pending: null,
    pendingRun: null,
  };
  const pendingOf = (over: Partial<NonNullable<RunStateInput["pending"]>> = {}) => ({
    sessionId: SESSION_A,
    runId: "20261010T115000000Z",
    kind: "task" as const,
    role: "task",
    resetsAt: "2026-10-14T00:00:00.000Z",
    recordedAt: RECORDED,
    ...over,
  });
  const recordOf = (status: string, over: Record<string, unknown> = {}) =>
    ({
      runId: "20261010T115000000Z",
      status,
      startedAt: iso(T0 - 10 * MINUTE),
      resetsAt: null,
      ...over,
    }) as NonNullable<RunStateInput["record"]>;

  it("end reports: ok completes only a stale view; failed and timeout fail a running or stale view", () => {
    const rows: Array<[RunStateInput["state"], string, RunStateInput["state"]]> = [
      ["stale", "ok", "completed"],
      ["running", "ok", "running"],
      ["completed", "ok", "completed"],
      ["failed", "ok", "failed"],
      ["cancelled", "ok", "cancelled"],
      ["stale", "failed", "failed"],
      ["running", "failed", "failed"],
      ["completed", "failed", "completed"],
      ["cancelled", "failed", "cancelled"],
      ["stale", "timeout", "failed"],
      ["running", "timeout", "failed"],
      ["completed", "timeout", "completed"],
      ["cancelled", "timeout", "cancelled"],
      ["completed", "running", "completed"],
      ["failed", "running", "failed"],
      ["cancelled", "running", "cancelled"],
      ["stale", "running", "stale"],
      ["stale", "refused", "stale"],
      ["running", "refused", "running"],
      ["stale", "limit", "stale"],
    ];
    for (const [state, status, expected] of rows) {
      const out = decideRunState({ ...base, state, record: recordOf(status) });
      expect(out.state, `${state} + ${status}`).toBe(expected);
      expect(out.resumesAfter).toBeNull();
    }
  });

  it("no combination reaches completed without an explicit ok report (T-05.1-27)", () => {
    const states = ["running", "limit-paused", "stale", "failed", "cancelled"] as const;
    const statuses = [null, "running", "limit", "timeout", "failed", "refused"] as const;
    for (const state of states) {
      for (const status of statuses) {
        for (const limitHitAfter of [false, true]) {
          for (const pending of [null, pendingOf()]) {
            const out = decideRunState({
              ...base,
              state,
              limitHitAfter,
              pending,
              record: status === null ? null : recordOf(status),
              pendingRun: pending === null ? null : { status: "limit", resetsAt: null },
            });
            expect(out.state, `${state}/${status}/${limitHitAfter}/${pending !== null}`).not.toBe(
              "completed",
            );
          }
        }
      }
    }
  });

  it("a pending record plus a second signal pauses; the resume time is the record's or null", () => {
    const both = decideRunState({
      ...base,
      limitHitAfter: true,
      pending: pendingOf(),
      record: recordOf("limit"),
      pendingRun: { status: "limit", resetsAt: null },
    });
    expect(both).toEqual({ state: "limit-paused", resumesAfter: "2026-10-14T00:00:00.000Z" });

    const recordOnly = decideRunState({
      ...base,
      pending: pendingOf({ resetsAt: null }),
      record: recordOf("limit"),
      pendingRun: { status: "limit", resetsAt: null },
    });
    expect(recordOnly).toEqual({ state: "limit-paused", resumesAfter: null });

    const rolloutOnly = decideRunState({
      ...base,
      limitHitAfter: true,
      pending: pendingOf({ resetsAt: null }),
      record: recordOf("running"),
      pendingRun: { status: "running", resetsAt: null },
    });
    expect(rolloutOnly.state).toBe("limit-paused");

    const fromRun = decideRunState({
      ...base,
      limitHitAfter: true,
      pending: pendingOf({ resetsAt: null }),
      pendingRun: { status: "limit", resetsAt: "2026-10-15T00:00:00.000Z" },
    });
    expect(fromRun).toEqual({ state: "limit-paused", resumesAfter: "2026-10-15T00:00:00.000Z" });
  });

  it("one signal never pauses", () => {
    const pendingAlone = decideRunState({
      ...base,
      pending: pendingOf(),
      record: recordOf("running"),
      pendingRun: { status: "running", resetsAt: null },
    });
    expect(pendingAlone.state).toBe("running");
    const hitAlone = decideRunState({ ...base, limitHitAfter: true, record: recordOf("limit") });
    expect(hitAlone.state).toBe("running");
    const noPendingNoRecord = decideRunState({ ...base, limitHitAfter: true });
    expect(noPendingNoRecord.state).toBe("running");
  });

  it("a thread that is running again, or already completed, or superseded by a later run, is not paused", () => {
    const common = {
      limitHitAfter: true,
      pending: pendingOf(),
      record: recordOf("limit"),
      pendingRun: { status: "limit", resetsAt: null },
    } as const;
    const resumedRunning = decideRunState({
      ...base,
      ...common,
      state: "running",
      lastActivityAt: iso(T0 + 2 * MINUTE),
    });
    expect(resumedRunning.state).toBe("running");
    const resumedThenStale = decideRunState({
      ...base,
      ...common,
      state: "stale",
      lastLifecycleAt: iso(T0 + MINUTE),
    });
    expect(resumedThenStale.state).toBe("stale");
    const done = decideRunState({ ...base, ...common, state: "completed" });
    expect(done.state).toBe("completed");
    const superseded = decideRunState({
      ...base,
      ...common,
      record: recordOf("running", { runId: "20261010T125900000Z", startedAt: iso(T0 + MINUTE) }),
    });
    expect(superseded.state).toBe("running");
  });

  it("a paused run is never also reported failed (the pause rule is applied last)", () => {
    const out = decideRunState({
      ...base,
      state: "stale",
      limitHitAfter: true,
      pending: pendingOf(),
      record: recordOf("timeout"),
      pendingRun: { status: "limit", resetsAt: null },
    });
    expect(out.state).toBe("limit-paused");
  });
});

/** Dates the world relative to its mirror clock. */
function ago(r: Rig, ms: number): string {
  return iso(r.mirrorWorld.clock.now - ms);
}

const PAUSED_THREAD = (clockNow: number): ThreadSpec => ({
  id: SESSION_A,
  agoMs: 9 * MINUTE,
  lifecycle: [["task_started", 10 * MINUTE]],
  extraLines: [rolloutLimitLine(clockNow - 9 * MINUTE)],
});

describe("Test 1, 2, 3, 5 (task 2): limit-paused through the overlay", () => {
  it("shows limit-paused with the record's reset time, keeping origin, project and last activity", async () => {
    const clockNow = Date.now();
    const r = rig([PAUSED_THREAD(clockNow)]);
    r.mirrorWorld.clock.now = clockNow;
    const record = writeRunRecord(r.project.localState, {
      kind: "task",
      status: "limit",
      mode: "headless",
      startedAt: ago(r, 20 * MINUTE),
      resetsAt: "2026-10-14T00:00:00.000Z",
    });
    writePendingResume(r.project.localState, {
      sessionId: SESSION_A,
      runId: record.runId,
      resetsAt: "2026-10-14T00:00:00.000Z",
      recordedAt: ago(r, 8 * MINUTE),
    });
    await r.mirrorWorld.mirror.pollNow();
    const before = sessionFor(r.mirrorWorld.mirror, SESSION_A);
    const overlay = overlayFor(r);
    await overlay.refresh();
    await r.mirrorWorld.mirror.pollNow();
    const paused = sessionFor(r.mirrorWorld.mirror, SESSION_A);
    expect(paused).toMatchObject({
      state: "limit-paused",
      resumesAfter: "2026-10-14T00:00:00.000Z",
      origin: "headless",
      projectId: r.project.projectId,
      lastActivityAt: before.lastActivityAt,
    });
    expect(Object.keys(paused).sort()).toEqual(VIEW_KEYS);
    expect(CodexSessionViewSchema.safeParse(paused).success).toBe(true);
  });

  it("is still paused with no reset time reported, and the pause clears once the wrapper removes the pending file", async () => {
    const clockNow = Date.now();
    const r = rig([PAUSED_THREAD(clockNow)]);
    r.mirrorWorld.clock.now = clockNow;
    const record = writeRunRecord(r.project.localState, {
      kind: "task",
      status: "limit",
      mode: "headless",
      startedAt: ago(r, 20 * MINUTE),
      resetsAt: null,
    });
    const pendingPath = writePendingResume(r.project.localState, {
      sessionId: SESSION_A,
      runId: record.runId,
      resetsAt: null,
      recordedAt: ago(r, 8 * MINUTE),
    });
    const overlay = overlayFor(r);
    await overlay.refresh();
    await r.mirrorWorld.mirror.pollNow();
    expect(sessionFor(r.mirrorWorld.mirror, SESSION_A)).toMatchObject({
      state: "limit-paused",
      resumesAfter: null,
    });
    rmSync(pendingPath);
    await overlay.refresh();
    expect(sessionFor(r.mirrorWorld.mirror, SESSION_A).state).toBe("running");
  });

  it("does not pause on the pending record alone, a limit-hit fact alone, or another session's pending record", async () => {
    const clockNow = Date.now();
    // Pending record alone: the rollout shows no limit-hit and the wrapper record says running.
    const quiet = rig([
      { id: SESSION_A, agoMs: 2 * MINUTE, lifecycle: [["task_started", 3 * MINUTE]] },
    ]);
    quiet.mirrorWorld.clock.now = clockNow;
    const running = writeRunRecord(quiet.project.localState, {
      kind: "task",
      status: "running",
      startedAt: ago(quiet, 20 * MINUTE),
    });
    writePendingResume(quiet.project.localState, {
      sessionId: SESSION_A,
      runId: running.runId,
      recordedAt: ago(quiet, 8 * MINUTE),
    });
    const quietOverlay = overlayFor(quiet);
    await quietOverlay.refresh();
    await quiet.mirrorWorld.mirror.pollNow();
    expect(sessionFor(quiet.mirrorWorld.mirror, SESSION_A).state).toBe("running");

    // A limit-hit fact alone: no pending-resume record.
    const hitOnly = rig([PAUSED_THREAD(clockNow)]);
    hitOnly.mirrorWorld.clock.now = clockNow;
    writeRunRecord(hitOnly.project.localState, {
      kind: "task",
      status: "limit",
      startedAt: ago(hitOnly, 20 * MINUTE),
    });
    const hitOverlay = overlayFor(hitOnly);
    await hitOverlay.refresh();
    await hitOnly.mirrorWorld.mirror.pollNow();
    expect(sessionFor(hitOnly.mirrorWorld.mirror, SESSION_A).state).not.toBe("limit-paused");

    // A pending record naming another session.
    const other = rig([PAUSED_THREAD(clockNow)]);
    other.mirrorWorld.clock.now = clockNow;
    const otherRecord = writeRunRecord(other.project.localState, {
      kind: "task",
      status: "limit",
      sessionId: SESSION_B,
      startedAt: ago(other, 20 * MINUTE),
    });
    writePendingResume(other.project.localState, {
      sessionId: SESSION_B,
      runId: otherRecord.runId,
      recordedAt: ago(other, 8 * MINUTE),
    });
    const otherOverlay = overlayFor(other);
    await otherOverlay.refresh();
    await other.mirrorWorld.mirror.pollNow();
    expect(sessionFor(other.mirrorWorld.mirror, SESSION_A).state).not.toBe("limit-paused");
  });

  it("a thread that is running again after the pending record was written is not paused", async () => {
    const clockNow = Date.now();
    const r = rig([
      {
        id: SESSION_A,
        agoMs: 2 * MINUTE,
        lifecycle: [
          ["task_started", 30 * MINUTE],
          ["task_started", 3 * MINUTE],
        ],
      },
    ]);
    r.mirrorWorld.clock.now = clockNow;
    const record = writeRunRecord(r.project.localState, {
      kind: "task",
      status: "limit",
      startedAt: ago(r, 40 * MINUTE),
    });
    writePendingResume(r.project.localState, {
      sessionId: SESSION_A,
      runId: record.runId,
      recordedAt: ago(r, 25 * MINUTE),
    });
    const overlay = overlayFor(r);
    await overlay.refresh();
    await r.mirrorWorld.mirror.pollNow();
    expect(sessionFor(r.mirrorWorld.mirror, SESSION_A).state).toBe("running");
  });
});

describe("Test 4 (task 2): explicit end reports through the overlay", () => {
  it("an ok record turns a stale view into completed and a failed record turns it into failed", async () => {
    for (const [status, expected] of [
      ["ok", "completed"],
      ["failed", "failed"],
      ["timeout", "failed"],
      ["running", "stale"],
    ] as const) {
      const r = rig([
        { id: SESSION_A, agoMs: 60 * MINUTE, lifecycle: [["task_started", 61 * MINUTE]] },
      ]);
      writeRunRecord(r.project.localState, { kind: "task", status });
      const overlay = overlayFor(r);
      await overlay.refresh();
      await r.mirrorWorld.mirror.pollNow();
      expect(sessionFor(r.mirrorWorld.mirror, SESSION_A).state, status).toBe(expected);
    }
  });

  it("a running record never turns a terminal rollout state back into running", async () => {
    const r = rig([
      {
        id: SESSION_A,
        agoMs: 5 * MINUTE,
        lifecycle: [
          ["task_started", 8 * MINUTE],
          ["task_complete", 5 * MINUTE],
        ],
      },
    ]);
    writeRunRecord(r.project.localState, { kind: "task", status: "running" });
    const overlay = overlayFor(r);
    await overlay.refresh();
    await r.mirrorWorld.mirror.pollNow();
    expect(sessionFor(r.mirrorWorld.mirror, SESSION_A).state).toBe("completed");
  });
});

describe("Test 7 (task 2): bounds and gating", () => {
  it("reads only the newest 100 records of each of ten projects and rebuilds nothing for an unchanged scan", async () => {
    const world = createRunWorld();
    cleanups.push(() => world.cleanup());
    const base = Date.UTC(2026, 9, 11, 0, 0, 0);
    for (let p = 0; p < 10; p += 1) {
      const project = world.addProject();
      for (let i = 0; i < 50; i += 1) {
        writeRunRecord(project.localState, { runId: runIdAt(base + p * 1000 + i), status: "ok" });
      }
    }
    // One directory over the cap.
    const heavy = world.addProject();
    for (let i = 0; i < 130; i += 1) {
      writeRunRecord(heavy.userState, { runId: runIdAt(base + 20_000 + i), status: "ok" });
    }
    const reader = createRunRecordReader({
      listProjects: () => world.listProjects(),
      bridgeStateDir: world.bridgeState,
      home: world.home,
      fs: nodeRunRecordFs,
    });
    const invalidate = vi.fn();
    const overlay = createRunOverlay({
      reader,
      mirror: { addOverlay: () => () => undefined, addTickHook: () => () => undefined, invalidate },
      now: () => Date.now(),
      inactivityMs: INACTIVITY,
      logger,
    });
    await overlay.refresh();
    expect(reader.last().runs).toHaveLength(10 * 50 + 100);
    expect(reader.last().skipped.capped).toBe(30);
    expect(invalidate).toHaveBeenCalledTimes(1);
    await overlay.refresh();
    await overlay.refresh();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("scans nothing without subscribers: the overlay refresh runs only on the mirror's own gated tick", async () => {
    const handlers: Array<() => void> = [];
    const timers = {
      setInterval(fn: () => void) {
        handlers.push(fn);
        return handlers.length;
      },
      clearInterval() {
        handlers.length = 0;
      },
    };
    const subs = { n: 0 };
    const mirrorWorld = buildMirror(
      [RUNNING_THREAD],
      { now: Date.now() },
      {
        subscribers: () => subs.n,
        timers,
      },
    );
    const scan = vi.fn(() =>
      Promise.resolve({
        runs: [],
        pending: [],
        skipped: {} as never,
        signature: "",
      }),
    );
    const overlay = createRunOverlay({
      reader: { scan },
      mirror: mirrorWorld.mirror,
      now: () => mirrorWorld.clock.now,
      inactivityMs: INACTIVITY,
      logger,
    });
    mirrorWorld.mirror.start();
    for (const fn of handlers) fn();
    await Promise.resolve();
    expect(scan).not.toHaveBeenCalled();
    subs.n = 1;
    for (const fn of handlers) fn();
    await mirrorWorld.mirror.pollNow();
    expect(scan).toHaveBeenCalledTimes(1);
    mirrorWorld.mirror.stop();
    overlay.dispose();
    for (const fn of handlers) fn();
    expect(scan).toHaveBeenCalledTimes(1);
  });
});

describe("Test 8 (task 2): logs carry reason codes only", () => {
  it("counts hostile files and a failing scan without naming a path, run id, session id or value", async () => {
    logged.length = 0;
    const world = createRunWorld();
    cleanups.push(() => world.cleanup());
    const project = world.addProject();
    writeRunRecord(project.localState, { extra: { status: 5 } });
    writeRunRecord(project.localState, { decoys: true });
    const outside = join(world.base, "outside");
    mkdirSync(outside, { recursive: true });
    const reader = createRunRecordReader({
      listProjects: () => world.listProjects(),
      bridgeStateDir: world.bridgeState,
      home: world.home,
      fs: nodeRunRecordFs,
    });
    const spy = {
      addOverlay: () => () => undefined,
      addTickHook: () => () => undefined,
      invalidate: vi.fn(),
    };
    const overlay = createRunOverlay({
      reader,
      mirror: spy,
      now: () => Date.now(),
      inactivityMs: INACTIVITY,
      logger,
    });
    await overlay.refresh();
    const failing = createRunOverlay({
      reader: { scan: () => Promise.reject(new Error(`boom ${project.root} ${SESSION_A}`)) },
      mirror: spy,
      now: () => Date.now(),
      inactivityMs: INACTIVITY,
      logger,
    });
    await failing.refresh();
    expect(logged.length).toBeGreaterThanOrEqual(2);
    for (const line of logged) {
      expect(line).not.toContain("/");
      expect(line).not.toMatch(/\d{8}T\d{9}Z/);
      expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(line).not.toContain("DECOY");
      expect(line).not.toContain(SESSION_A);
    }
  });
});

afterEach(() => {
  // Test 8 across the whole file: no overlay log line ever names a path or an id.
  for (const line of logged) {
    expect(line).not.toContain("/");
    expect(line).not.toMatch(/\d{8}T\d{9}Z/);
    expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  }
});
