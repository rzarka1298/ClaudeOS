import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createRunIdMinter, projectDirName } from "@ccc/launchers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BridgeFixture,
  createBridgeFixture,
  type WindowSimulator,
} from "../test-support/bridge-fixtures.js";
import {
  bridgeCore,
  DECOY_LOG_CONTENT,
  recordingRunFs,
  SESSION_A,
  writeLiveLog,
  writeRunRecord,
} from "../test-support/codex-run-fixtures.js";
import { withdrawRequest } from "./bridge-queue.js";
import { coveringWindow, readBridgeStatus } from "./bridge-state.js";
import {
  createFollowLogService,
  type FollowBridgeRequest,
  type FollowLogDeps,
  type FollowLogService,
  writeFollowRequest,
} from "./follow-log.js";
import { createRunRecordReader, nodeRunRecordFs } from "./run-records.js";

const MINUTE = 60_000;
const INACTIVITY = 30 * MINUTE;
const DEADLINE = 3500;
const POLL = 100;

let fx: BridgeFixture;
let state: string;
const logged: string[] = [];
/** One minter for the whole file: ids stay strictly increasing across every call. */
const minted = createRunIdMinter(() => Date.now());

beforeEach(() => {
  fx = createBridgeFixture();
  fx.installLauncher();
  fx.installMarker();
  state = join(fx.projectDir, ".planning", "codex");
  logged.length = 0;
});

afterEach(() => {
  fx.cleanup();
});

interface Rig {
  readonly service: FollowLogService;
  readonly clock: { now: number };
  readonly calls: ReturnType<typeof recordingRunFs>["calls"];
  readonly sleeps: number[];
  readonly deps: FollowLogDeps;
}

function rig(
  options: {
    readonly sim?: WindowSimulator | undefined;
    readonly over?: Partial<FollowLogDeps>;
  } = {},
): Rig {
  const clock = { now: Date.now() };
  const recorded = recordingRunFs(nodeRunRecordFs);
  const reader = createRunRecordReader({
    listProjects: () => [{ projectId: "proj-follow", name: "Follow", root: fx.projectDir }],
    bridgeStateDir: fx.stateDir,
    home: fx.home,
    fs: recorded.fs,
  });
  const sleeps: number[] = [];
  const deps: FollowLogDeps = {
    runs: reader,
    fs: recorded.fs,
    readBridgeStatus: () => readBridgeStatus({ env: {}, home: fx.home, now: () => clock.now }),
    coveringWindow: (status, root) => coveringWindow(status, root),
    mintRunId: minted,
    now: () => clock.now,
    inactivityMs: INACTIVITY,
    pollMs: POLL,
    deadlineMs: DEADLINE,
    sleep: (ms) => {
      sleeps.push(ms);
      clock.now += ms;
      options.sim?.tick();
      return Promise.resolve();
    },
    logger: {
      warn(fields, message) {
        logged.push(JSON.stringify([fields, message]));
      },
    },
    ...options.over,
  };
  return {
    service: createFollowLogService(deps),
    clock,
    calls: recorded.calls,
    sleeps,
    deps,
  };
}

/** A running headless review record with a fresh live log; returns the wrapper run id. */
function runningRun(
  over: {
    readonly dir?: string;
    readonly mode?: string;
    readonly status?: string;
    readonly kind?: string;
    readonly sessionId?: string | null;
    readonly worktree?: string;
    readonly logAgeMs?: number;
    readonly log?: boolean;
  } = {},
): { readonly runId: string; readonly log: string } {
  const dir = over.dir ?? state;
  const kind = over.kind ?? "review";
  const record = writeRunRecord(dir, {
    kind,
    mode: over.mode ?? "headless",
    status: over.status ?? "running",
    ...(over.sessionId === undefined ? {} : { sessionId: over.sessionId }),
    ...(over.worktree === undefined ? {} : { extra: { worktree: over.worktree } }),
  });
  const log =
    over.log === false
      ? ""
      : writeLiveLog(dir, record.runId, kind, { mtimeMs: Date.now() - (over.logAgeMs ?? 2_000) });
  return { runId: record.runId, log };
}

function requestsNow(): string[] {
  return fx.requestFiles();
}

function claimedRequest(): Record<string, unknown> {
  const files = fx.claimedFiles();
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(fx.claimedDir, files[0] as string), "utf8"));
}

describe("Test 1 (tracer): a running headless run is followed through a simulated window", () => {
  for (const mode of ["current", "outdated"] as const) {
    it(`queues one follow request the ${mode} extension claims and the real bridge validation accepts`, async () => {
      const sim = fx.simulator(mode);
      sim.heartbeat();
      const { runId, log } = runningRun({ sessionId: SESSION_A });
      const r = rig({ sim });

      const result = await r.service.follow({ runId });
      expect(result).toEqual({ ok: true });
      expect(requestsNow()).toEqual([]);

      const raw = claimedRequest();
      expect(Object.keys(raw).sort()).toEqual(
        [
          "codexHome",
          "createdAt",
          "cwd",
          "kind",
          "liveLog",
          "mode",
          "pid",
          "projectRoot",
          "runId",
          "sessionId",
        ].sort(),
      );
      expect(raw.runId).toMatch(/^\d{8}T\d{9}Z$/);
      expect(raw.runId).not.toBe(runId);
      expect(raw).toMatchObject({
        kind: "review",
        mode: "follow",
        projectRoot: fx.projectDir,
        cwd: fx.projectDir,
        sessionId: SESSION_A,
        liveLog: log,
        pid: null,
        codexHome: null,
      });
      const verdict = bridgeCore.validateRequest(raw, { stateDir: fx.stateDir, checkAge: false });
      expect(verdict.ok, verdict.reason).toBe(true);
      expect(verdict.request).toMatchObject({ mode: "follow", kind: "review", liveLog: log });
    });
  }

  it("follows a record kept in the bridge state's per-project directory", async () => {
    const sim = fx.simulator("current");
    sim.heartbeat();
    const userState = join(fx.stateDir, "projects", projectDirName(fx.projectDir));
    const { runId, log } = runningRun({ dir: userState, kind: "task" });
    const r = rig({ sim });
    expect(await r.service.follow({ runId })).toEqual({ ok: true });
    const raw = claimedRequest();
    expect(raw).toMatchObject({ kind: "task", liveLog: log });
    const verdict = bridgeCore.validateRequest(raw, { stateDir: fx.stateDir, checkAge: false });
    expect(verdict.ok, verdict.reason).toBe(true);
  });

  it("uses a contained worktree directory as the working directory and falls back to the project root", async () => {
    const sim = fx.simulator("current");
    sim.heartbeat();
    mkdirSync(join(fx.projectDir, "wt-a"));
    const outside = join(fx.base, "outside-dir");
    mkdirSync(outside);
    symlinkSync(outside, join(fx.projectDir, "wt-link"));
    const cases: Array<[string, string]> = [
      ["wt-a", join(fx.projectDir, "wt-a")],
      ["wt-link", fx.projectDir],
      ["no-such-dir", fx.projectDir],
      ["../escape", fx.projectDir],
      ["/tmp", fx.projectDir],
      [".", fx.projectDir],
    ];
    for (const [worktree, expected] of cases) {
      const { runId } = runningRun({ worktree });
      const r = rig({ sim });
      expect(await r.service.follow({ runId }), worktree).toEqual({ ok: true });
      const files = fx.claimedFiles();
      const newest = files[files.length - 1] as string;
      const raw = JSON.parse(readFileSync(join(fx.claimedDir, newest), "utf8"));
      expect(raw.cwd, worktree).toBe(expected);
    }
  });

  it("sends a null session id when the record has none", async () => {
    const sim = fx.simulator("current");
    sim.heartbeat();
    const { runId } = runningRun({ sessionId: null });
    const r = rig({ sim });
    expect(await r.service.follow({ runId })).toEqual({ ok: true });
    expect(claimedRequest().sessionId).toBeNull();
  });
});

describe("Test 2: the service function takes a wrapper run id string only", () => {
  it("answers not-found for anything that is not a wrapper run id, before any file is touched", async () => {
    const r = rig();
    for (const bad of [
      "",
      "../../etc/passwd",
      `${state}/live/x.log`,
      "20261010T120000000Z/../x",
      "20261010T12000000Z",
      "run",
    ]) {
      expect(await r.service.follow({ runId: bad }), bad).toEqual({
        ok: false,
        error: "not-found",
      });
    }
    expect(r.calls).toEqual([]);
    expect(requestsNow()).toEqual([]);
  });
});

describe("Test 3: every failure is one fixed code and nothing is written", () => {
  async function expectError(runId: string, error: string, over: Partial<FollowLogDeps> = {}) {
    const sim = fx.simulator("current");
    sim.heartbeat();
    const r = rig({ sim, over });
    expect(await r.service.follow({ runId })).toEqual({ ok: false, error });
    expect(requestsNow()).toEqual([]);
    expect(fx.claimedFiles()).toEqual([]);
    return r;
  }

  it("an unknown run id is not-found", async () => {
    await expectError("20261010T120000000Z", "not-found");
  });

  it("an ended run, a tui-mode run, a missing log and a stale log are run-ended", async () => {
    await expectError(runningRun({ status: "ok" }).runId, "run-ended");
    await expectError(runningRun({ status: "limit" }).runId, "run-ended");
    await expectError(runningRun({ mode: "tui" }).runId, "run-ended");
    await expectError(runningRun({ log: false }).runId, "run-ended");
    await expectError(runningRun({ logAgeMs: INACTIVITY + MINUTE }).runId, "run-ended");
  });

  it("a symlinked log, a log directory leaving the state directory and a non-regular log are not-found", async () => {
    const outside = join(fx.base, "outside");
    mkdirSync(outside, { recursive: true });
    // A symlinked log.
    const linked = runningRun({ log: false });
    writeFileSync(join(outside, "real.log"), DECOY_LOG_CONTENT);
    mkdirSync(join(state, "live"), { recursive: true });
    symlinkSync(join(outside, "real.log"), join(state, "live", `${linked.runId}-review.log`));
    await expectError(linked.runId, "not-found");
    // A directory where the log should be.
    const dirRun = runningRun({ log: false });
    mkdirSync(join(state, "live", `${dirRun.runId}-review.log`));
    await expectError(dirRun.runId, "not-found");
  });

  it("a live directory that resolves outside the state directory is not-found", async () => {
    const run = runningRun({ log: false });
    const outside = join(fx.base, "outside-live");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, `${run.runId}-review.log`), DECOY_LOG_CONTENT);
    symlinkSync(outside, join(state, "live"));
    await expectError(run.runId, "not-found");
  });

  it("no launcher file is bridge-not-installed", async () => {
    const { runId } = runningRun({});
    const r = rig({
      over: {
        readBridgeStatus: () =>
          readBridgeStatus({ env: {}, home: join(fx.base, "empty-home"), now: () => Date.now() }),
      },
    });
    expect(await r.service.follow({ runId })).toEqual({ ok: false, error: "bridge-not-installed" });
    expect(requestsNow()).toEqual([]);
  });

  it("a bridge directory the service must not use is bridge-not-installed and nothing is written", async () => {
    const { runId } = runningRun({});
    const base = readBridgeStatus({ env: {}, home: fx.home, now: () => Date.now() });
    const r = rig({
      over: { readBridgeStatus: () => ({ ...base, launchable: false }) },
    });
    expect(await r.service.follow({ runId })).toEqual({ ok: false, error: "bridge-not-installed" });
    expect(requestsNow()).toEqual([]);
  });

  it("no covering window is window-not-ready at once: nothing written, nothing slept, no cold start", async () => {
    const { runId } = runningRun({});
    const elsewhere = join(fx.base, "elsewhere");
    mkdirSync(elsewhere);
    const sim = fx.simulator("current", { folders: [elsewhere] });
    sim.heartbeat();
    const r = rig({ sim });
    expect(await r.service.follow({ runId })).toEqual({ ok: false, error: "window-not-ready" });
    expect(requestsNow()).toEqual([]);
    expect(r.sleeps).toEqual([]);
    // No window at all.
    const none = rig({});
    expect(await none.service.follow({ runId })).toEqual({ ok: false, error: "window-not-ready" });
    expect(none.sleeps).toEqual([]);
  });

  it("an unexpected fault is the constant failed", async () => {
    const { runId } = runningRun({});
    const r = rig({
      over: {
        readBridgeStatus: () => {
          throw new Error(`boom ${fx.projectDir}`);
        },
      },
    });
    expect(await r.service.follow({ runId })).toEqual({ ok: false, error: "failed" });
    expect(logged.join("\n")).not.toContain(fx.projectDir);
  });
});

describe("Test 4: the claim wait, the withdrawal and the claim race", () => {
  it("withdraws on timeout, answers window-not-ready and returns within the adapter deadline plus one poll", async () => {
    const sim = fx.simulator("current");
    sim.heartbeat();
    const { runId } = runningRun({});
    // The window is there but never claims (the simulator is not ticked).
    const r = rig({ sim: undefined });
    const started = r.clock.now;
    expect(await r.service.follow({ runId })).toEqual({ ok: false, error: "window-not-ready" });
    expect(r.clock.now - started).toBeLessThanOrEqual(DEADLINE + POLL);
    expect(r.clock.now - started).toBeGreaterThanOrEqual(DEADLINE);
    expect(requestsNow()).toEqual([]);
    expect(fx.claimedFiles()).toEqual([]);
  });

  it("a claim that lands while the request is being withdrawn is ok and the claimed file is left", async () => {
    const sim = fx.simulator("current");
    sim.heartbeat();
    const { runId } = runningRun({});
    const r = rig({
      over: {
        queue: {
          withdrawRequest: (dir, id) => {
            sim.tick();
            return withdrawRequest(dir, id);
          },
        },
      },
    });
    expect(await r.service.follow({ runId })).toEqual({ ok: true });
    expect(fx.claimedFiles()).toHaveLength(1);
    expect(requestsNow()).toEqual([]);
  });

  it("an aborted call withdraws the request and answers failed", async () => {
    const sim = fx.simulator("current");
    sim.heartbeat();
    const { runId } = runningRun({});
    const controller = new AbortController();
    const r = rig({
      over: {
        sleep: () => {
          controller.abort();
          return Promise.resolve();
        },
      },
    });
    expect(await r.service.follow({ runId, signal: controller.signal })).toEqual({
      ok: false,
      error: "failed",
    });
    expect(requestsNow()).toEqual([]);
  });
});

describe("Test 5: the log content is never read and nothing but constants leaves", () => {
  it("only lstat and realpath ever touch the log; results and log lines name no path or run id", async () => {
    const sim = fx.simulator("current");
    sim.heartbeat();
    const { runId, log } = runningRun({});
    const r = rig({ sim });
    const ok = await r.service.follow({ runId });
    const refused = await r.service.follow({ runId: "20261010T120000000Z" });
    expect(ok).toEqual({ ok: true });
    expect(refused).toEqual({ ok: false, error: "not-found" });
    const logCalls = r.calls.filter((call) => call.path === log || call.path.endsWith(".log"));
    expect(logCalls.length).toBeGreaterThan(0);
    expect(logCalls.every((call) => call.op === "lstat" || call.op === "realpath")).toBe(true);
    expect(r.calls.some((call) => call.path.includes("/reports"))).toBe(false);
    for (const line of logged) {
      expect(line).not.toContain("/");
      expect(line).not.toContain(runId);
    }
    expect(JSON.stringify([ok, refused])).not.toContain(runId);
  });

  it("logs reason codes for refusals", async () => {
    const { runId } = runningRun({ status: "ok" });
    const r = rig({});
    await r.service.follow({ runId });
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).toContain("run-ended");
    expect(logged.join("\n")).not.toContain(runId);
  });
});

describe("Test 7: concurrent follows mint distinct, increasing bridge run ids", () => {
  it("both succeed independently with strictly increasing ids that match the bridge pattern", async () => {
    const sim = fx.simulator("current");
    sim.heartbeat();
    const { runId } = runningRun({});
    const r = rig({ sim });
    const [a, b] = await Promise.all([r.service.follow({ runId }), r.service.follow({ runId })]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    const ids = fx.claimedFiles().map((name) => name.replace(/\.json$/, ""));
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^\d{8}T\d{9}Z$/);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(2);
  });

  it("retries with the next id when a request with that id already exists", async () => {
    const sim = fx.simulator("current");
    sim.heartbeat();
    const { runId } = runningRun({});
    const ids = ["20261010T120000000Z", "20261010T120000001Z"];
    let index = 0;
    mkdirSync(fx.requestsDir, { recursive: true });
    writeFileSync(join(fx.requestsDir, `${ids[0]}.json`), "{}");
    const r = rig({ sim, over: { mintRunId: () => ids[Math.min(index++, 1)] as string } });
    // The pre-existing garbage request is not ours: the window discards it, ours is claimed.
    expect(await r.service.follow({ runId })).toEqual({ ok: true });
    expect(fx.claimedFiles()).toEqual([`${ids[1]}.json`]);
  });
});

describe("writeFollowRequest: the local atomic writer", () => {
  const request = (over: Record<string, unknown> = {}): FollowBridgeRequest =>
    ({
      runId: "20261010T120000000Z",
      kind: "review",
      projectRoot: fx.projectDir,
      cwd: fx.projectDir,
      sessionId: null,
      liveLog: join(state, "live", "x.log"),
      pid: null,
      createdAt: new Date().toISOString(),
      mode: "follow",
      codexHome: null,
      ...over,
    }) as FollowBridgeRequest;

  it("writes the request 0600 with no temp file and never replaces an existing request or claimed file", () => {
    const first = writeFollowRequest(fx.stateDir, request());
    expect(first).toBe(join(fx.requestsDir, "20261010T120000000Z.json"));
    expect(statSync(first as string).mode & 0o777).toBe(0o600);
    expect(readdirSync(fx.requestsDir)).toEqual(["20261010T120000000Z.json"]);
    expect(writeFollowRequest(fx.stateDir, request())).toBeNull();
    mkdirSync(fx.claimedDir, { recursive: true });
    writeFileSync(join(fx.claimedDir, "20261010T120000001Z.json"), "{}");
    expect(writeFollowRequest(fx.stateDir, request({ runId: "20261010T120000001Z" }))).toBeNull();
    expect(existsSync(join(fx.requestsDir, "20261010T120000001Z.json"))).toBe(false);
  });

  it("refuses anything that is not exactly the fixed follow shape", () => {
    for (const bad of [
      { extra: "x" },
      { mode: "tui" },
      { mode: "agent" },
      { kind: "agent" },
      { pid: 1234 },
      { codexHome: "/Users/USERNAME/x" },
      { runId: "not-a-run-id" },
      { projectRoot: "relative" },
      { cwd: "relative" },
      { liveLog: "relative.log" },
      { liveLog: "/abs/not-a-log.txt" },
      { sessionId: "not-a-uuid" },
      { createdAt: "yesterday" },
    ]) {
      expect(() => writeFollowRequest(fx.stateDir, request(bad)), JSON.stringify(bad)).toThrow();
    }
    expect(requestsNow()).toEqual([]);
    // A missing key is refused too.
    const { codexHome: _omit, ...partial } = request();
    expect(() => writeFollowRequest(fx.stateDir, partial as never)).toThrow();
  });
});

describe("the service", () => {
  it("does not import a process starter, a signal or a content reader", () => {
    const source = readFileSync(join(import.meta.dirname, "follow-log.ts"), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(source).not.toMatch(
      /child_process|\bspawn\b|execFile|process\.kill|SIGINT|readFileSync/,
    );
  });
});
