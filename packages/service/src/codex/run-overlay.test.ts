import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
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
  runIdAt,
  SESSION_A,
  SESSION_B,
  startHeldReview,
  type WorldProject,
  WRAPPER_FAKE_SESSION_ID,
  writeLiveLog,
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
import { createRunOverlay } from "./run-overlay.js";
import { createRunRecordReader, nodeRunRecordFs, type RunRecordReader } from "./run-records.js";
import { type CodexSessionMirror, createCodexSessionMirror } from "./session-mirror.js";
import { createCodexStoreReader } from "./store-reader.js";

const MINUTE = 60_000;
const INACTIVITY = 30 * MINUTE;
const VIEW_KEYS = Object.keys(CodexSessionViewSchema.shape).sort();

const cleanups: Array<() => void> = [];
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
function buildMirror(specs: readonly ThreadSpec[], clock = { now: Date.now() }): MirrorWorld {
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
    subscribers: () => 1,
    publish: vi.fn(),
    now: () => clock.now,
    timers: defaultHeadroomTimers,
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

  it("keeps the base project when attribution found one, and never lets decoys through", async () => {
    const r = rig([RUNNING_THREAD]);
    writeRunRecord(r.project.localState, { decoys: true, status: "ok" });
    const text = JSON.stringify(sessionsOf(r.mirrorWorld.mirror) ?? []);
    expect(text).not.toContain(DECOY_WORKTREE);
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
