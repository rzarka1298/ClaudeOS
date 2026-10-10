import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_TRANSCRIPT_ANALYSIS_PATH,
  CLAUDE_USAGE_DELETE_PATH,
  CODEX_HEADROOM_PATH,
  CODEX_INTEGRATION_PATH,
  CODEX_SESSIONS_PATH,
  CODEX_TOKEN_ACTIVITY_PATH,
  CodexIntegrationStatusSchema,
  CodexSessionsSnapshotSchema,
  CodexSessionViewSchema,
  CodexSnapshotStateSchema,
  CodexTokenSummarySchema,
  HeadroomSignalSchema,
  LAUNCH_PAIR_PATH,
  LAUNCHERS_SAVE_PATH,
  type LaunchGuard,
  type LaunchGuardInput,
  LaunchPairResponseSchema,
  type ProjectId,
  SNAPSHOT_PATH,
  SnapshotResponseSchema,
} from "@ccc/domain";
import {
  CODEX_ANALYTICS_TABLES,
  insertProject,
  markCodexDayCovered,
  markDayCovered,
  saveLauncherConfig,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANTIGRAVITY_IDE_BUNDLE_ID } from "../projects/antigravity-terminal.js";
import { type BridgeFixture, createBridgeFixture } from "../test-support/bridge-fixtures.js";
import {
  type CodexComposition,
  type CodexCompositionOptions,
  codexHomeWithThreads,
  startCodexComposition,
  waitFor,
} from "../test-support/codex-composition.js";
import { launchContext } from "../test-support/codex-launch-context.js";
import {
  jsonl,
  metaLine,
  raw,
  turn,
  turnRecordLine,
} from "../test-support/codex-token-fixtures.js";
import {
  fakeCodexScriptSource,
  fakeCodexStarts,
  readFakeCodexLog,
  writeFakeCodex,
} from "../test-support/fake-codex.js";
import { FAKE_ACCOUNT_ID, weeklyReply } from "../test-support/fake-codex-app-server.js";
import { doctorReport } from "../test-support/fake-codex-doctor.js";
import { createFakeCodexHome, recordingFs } from "../test-support/fake-codex-home.js";
import { createCodexHomePort } from "./codex-home.js";
import { HEADROOM_REFRESH_INTERVAL_MS, type HeadroomTimers } from "./headroom-service.js";
import { DEFAULT_POLL_INTERVAL_MS } from "./session-mirror.js";

/**
 * Plan 05.1-29 Task 1 (tracer): the whole composed Codex service, end to end against fakes only.
 * One composition per test (the shared helper of plan 05.1-28), served by the REAL request
 * listener over a REAL Unix socket. The Codex client lives in @ccc/service-api-client, which the
 * service package may not import (import-boundary map), so requests are raw and every answer is
 * parsed with the strict domain schema the client itself uses; the client against the same
 * routes is checked by the contract audit in @ccc/test-fixtures.
 *
 * Every path is a temporary directory; the only executable ever run is a generated fake named
 * codex; the bridge is the plan 05.1-04 window simulator over a temporary state directory.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const INSTALL = join(REPO_ROOT, "scripts", "codex-hooks", "install.mjs");

const HOUR = 3_600_000;
const open: CodexComposition[] = [];
const fixtures: BridgeFixture[] = [];
const tickers: Array<ReturnType<typeof setInterval>> = [];

beforeEach(() => {
  vi.stubEnv("XDG_STATE_HOME", "");
});

afterEach(async () => {
  for (const ticker of tickers.splice(0)) clearInterval(ticker);
  for (const composition of open.splice(0)) await composition.close();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  vi.unstubAllEnvs();
});

async function compose(options: CodexCompositionOptions): Promise<CodexComposition> {
  const composition = await startCodexComposition(options);
  open.push(composition);
  return composition;
}

function fakeCodexIn(c: CodexComposition, usedPercent = 41) {
  return writeFakeCodex(join(c.dir, "fake"), {
    appServer: { read: { kind: "result", result: weeklyReply(usedPercent) } },
    doctor: { behavior: { kind: "print", stdout: doctorReport() } },
  });
}

describe("Task 1 (tracer), Test 1: a saved fake launcher, then a headroom read through its app-server", () => {
  it("saves the Codex launcher by typed path, reads 41 percent as allow, and the fake saw exactly the documented process", async () => {
    const clock = { ms: Date.now() };
    const c = await compose({
      saveRow: false,
      home: codexHomeWithThreads([], clock.ms),
      routeContext: launchContext(),
      now: () => clock.ms,
    });
    const fake = fakeCodexIn(c);

    const before = await c.get(CODEX_HEADROOM_PATH);
    expect(HeadroomSignalSchema.parse(before.body).codex.verdict).toBe("refuse");
    expect(fakeCodexStarts(fake.logPath)).toEqual([]);

    const saved = await c.post(LAUNCHERS_SAVE_PATH, {
      launcherId: "codex",
      executable: { kind: "path", path: fake.path },
      args: [],
    });
    expect(saved.status).toBe(200);

    // The refusal above was cached; the injected clock moves past the cache's freshness.
    clock.ms += 30_000;
    const reply = await c.get(CODEX_HEADROOM_PATH);
    expect(reply.status).toBe(200);
    const signal = HeadroomSignalSchema.parse(reply.body);
    expect(signal.codex.verdict).toBe("allow");
    expect(signal.codex.source).toBe("app-server");
    expect(signal.codex.worstWindow?.usedPercent).toBe(41);

    const entries = readFakeCodexLog(fake.logPath);
    const starts = fakeCodexStarts(fake.logPath);
    expect(starts).toHaveLength(1);
    const start = starts[0];
    expect(start?.argv).toEqual(["app-server"]);
    expect(start?.envKeys).toEqual(["HOME", "LC_ALL", "PATH"]);
    expect(start?.envKeys.some((key) => /TOKEN|KEY|SECRET|AUTH|PASS|CRED/i.test(key))).toBe(false);
    expect(start?.cwd).not.toBe(c.home.root);
    // Exactly the three-message RPC sequence: initialize, initialized, the one rate-limit read.
    const lines = entries.flatMap((entry) => (entry.t === "line" ? [JSON.parse(entry.line)] : []));
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => (line as { method?: string }).method)).toEqual([
      "initialize",
      "initialized",
      "account/rateLimits/read",
    ]);
    expect(JSON.stringify(reply.body)).not.toContain(FAKE_ACCOUNT_ID);
  });
});

describe("Test 2: sessions from a fake Codex home, honest states, no path or account", () => {
  it("lists a completed and a stale thread with exact key sets, mirrored into the snapshot", async () => {
    const now = Date.now();
    const c = await compose({
      home: codexHomeWithThreads(
        [
          {
            id: "thread-int-completed",
            agoMs: 2 * HOUR,
            lifecycle: [
              ["task_started", 2 * HOUR + 5000],
              ["task_complete", 2 * HOUR],
            ],
          },
          { id: "thread-int-stale", agoMs: 3 * HOUR, lifecycle: [["task_started", 3 * HOUR]] },
        ],
        now,
      ),
    });

    const reply = await c.get(CODEX_SESSIONS_PATH);
    expect(reply.status).toBe(200);
    const sessions = CodexSessionsSnapshotSchema.parse(reply.body);
    if (sessions.kind !== "available") throw new Error("expected an available list");
    const states = Object.fromEntries(sessions.sessions.map((s) => [s.threadId, s.state]));
    expect(states).toEqual({ "thread-int-completed": "completed", "thread-int-stale": "stale" });
    expect(Object.keys(reply.body as object).sort()).toEqual(
      [
        "analysisOn",
        "freshness",
        "hiddenCount",
        "kind",
        "observedAt",
        "partiality",
        "sessions",
      ].sort(),
    );
    const expectedKeys = Object.keys(CodexSessionViewSchema.shape).sort();
    for (const session of (reply.body as { sessions: object[] }).sessions) {
      expect(Object.keys(session).sort()).toEqual(expectedKeys);
    }
    const text = JSON.stringify(reply.body);
    expect(text).not.toContain(c.home.root);
    expect(text).not.toContain("rollout-");
    expect(text).not.toContain(FAKE_ACCOUNT_ID);

    const snapshot = SnapshotResponseSchema.parse((await c.get(SNAPSHOT_PATH)).body);
    const member = CodexSnapshotStateSchema.parse(snapshot.state.codex);
    if (member.sessions?.kind !== "available") throw new Error("expected sessions in the snapshot");
    expect(member.sessions.sessions).toEqual(sessions.sessions);
  });
});

describe("Test 3: the installed hook delivers a Stop to the real route", () => {
  it("moves a running thread to completed and flips the hook status, leaving the decoys untouched", async () => {
    const now = Date.now();
    const thread = "thread-int-hook";
    const c = await compose({
      socketInRuntimeDir: true,
      home: {
        ...codexHomeWithThreads(
          [{ id: thread, agoMs: 60_000, lifecycle: [["task_started", 60_000]] }],
          now,
        ),
        withDecoys: true,
      },
    });
    const hash = (path: string): string =>
      createHash("sha256").update(readFileSync(path)).digest("hex");
    const decoyHashes = [c.home.decoys.configPath, c.home.decoys.credentialPath].map(hash);

    const status = async () =>
      CodexIntegrationStatusSchema.parse((await c.get(CODEX_INTEGRATION_PATH)).body);
    const stateOf = async (): Promise<string | undefined> => {
      const body = CodexSessionsSnapshotSchema.parse((await c.get(CODEX_SESSIONS_PATH)).body);
      return body.kind === "available"
        ? body.sessions.find((s) => s.threadId === thread)?.state
        : undefined;
    };
    expect((await status()).hooks.state).toBe("not-installed");
    expect(await stateOf()).toBe("running");

    // The owner-run installer, into the temporary Codex home and runtime directory.
    const installed = spawnSync(
      process.execPath,
      [INSTALL, "--codex-home", c.home.root, "--runtime-dir", c.runtimeDir],
      {
        cwd: REPO_ROOT,
        env: {
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: c.homeDir,
          CODEX_HOME: c.home.root,
          CCC_RUNTIME_DIR: c.runtimeDir,
        },
        encoding: "utf8",
      },
    );
    expect(installed.status).toBe(0);
    expect((await status()).hooks.state).toBe("installed-no-events");

    // The installed entry, run as Codex runs it: a Stop payload on stdin, the runtime directory as an argument.
    const entry = join(c.runtimeDir, "codex-hooks", "codex-hook", "entry.js");
    const child = spawn(process.execPath, [entry, "--runtime-dir", c.runtimeDir], {
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: c.homeDir },
      stdio: ["pipe", "ignore", "ignore"],
    });
    const exited = new Promise<void>((done) => child.once("close", () => done()));
    child.stdin.end(
      JSON.stringify({ hook_event_name: "Stop", session_id: thread, turn_id: "turn-1" }),
    );
    await exited;

    let completed = false;
    expect(
      await waitFor(() => {
        void stateOf().then((value) => {
          completed = value === "completed";
        });
        return completed;
      }, 4000),
    ).toBe(true);
    const after = await status();
    expect(after.hooks.state).toBe("installed");
    expect(after.hooks.lastEventAt).not.toBeNull();

    expect([c.home.decoys.configPath, c.home.decoys.credentialPath].map(hash)).toEqual(decoyHashes);
  });
});

describe("Test 4: tokens counted once, and the combined delete clears both agents", () => {
  it("counts three cumulative records of one turn once, then empties both analytics on delete", async () => {
    const now = Date.now();
    const thread = "thread-int-tokens";
    const day = new Date(now).toISOString().slice(0, 10);
    const stamp = (offsetS: number): string =>
      new Date(now - 3_600_000 + offsetS * 1000).toISOString();
    const name = `rollout-${stamp(0).slice(0, 19).replaceAll(":", "-")}-${thread}.jsonl`;
    const base = codexHomeWithThreads(
      [{ id: thread, agoMs: HOUR, lifecycle: [["task_complete", HOUR]] }],
      now,
    );
    const c = await compose({
      usage: "real",
      home: {
        ...base,
        rollouts: [
          ...(base.rollouts ?? []),
          {
            day,
            name,
            content: jsonl([
              metaLine({ id: thread, timestamp: stamp(0) }),
              turnRecordLine({
                turnId: turn(1),
                timestamp: stamp(21),
                usage: raw(100, 20),
                threadId: thread,
              }),
              turnRecordLine({
                turnId: turn(1),
                timestamp: stamp(40),
                usage: raw(250, 60),
                threadId: thread,
              }),
              turnRecordLine({
                turnId: turn(1),
                timestamp: stamp(65),
                usage: raw(400, 90),
                threadId: thread,
              }),
            ]),
          },
        ],
      },
    });

    const range = async () => {
      const summary = CodexTokenSummarySchema.parse((await c.get(CODEX_TOKEN_ACTIVITY_PATH)).body);
      return summary.ranges["last-7-days"];
    };
    const off = await range();
    expect(off).toMatchObject({ kind: "unavailable", reason: "analysis-off" });

    expect((await c.post(CLAUDE_TRANSCRIPT_ANALYSIS_PATH, { enabled: true })).status).toBe(200);
    let counted = false;
    expect(
      await waitFor(() => {
        void range().then((value) => {
          counted = value.kind === "available" && value.totals.total > 0;
        });
        return counted;
      }, 8000),
    ).toBe(true);
    const on = await range();
    if (on.kind !== "available") throw new Error("expected counted tokens");
    expect(on.totals).toMatchObject({ input: 400, output: 90, total: 490 });

    const rows = (table: string): number =>
      (c.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(rows("codex_token_deltas")).toBeGreaterThan(0);

    // The combined delete: switch analysis off first, so nothing is recounted behind it.
    expect((await c.post(CLAUDE_TRANSCRIPT_ANALYSIS_PATH, { enabled: false })).status).toBe(200);
    const marked = new Date(now).toISOString();
    markDayCovered(c.store.db, "2020-01-01", marked);
    markCodexDayCovered(c.store.db, "2020-01-01", marked);
    expect(rows("coverage_days")).toBeGreaterThan(0);
    expect((await c.post(CLAUDE_USAGE_DELETE_PATH, {})).status).toBeLessThan(300);
    expect(rows("coverage_days")).toBe(0);
    for (const table of CODEX_ANALYTICS_TABLES) expect(rows(table)).toBe(0);
    expect(await range()).toMatchObject({ kind: "unavailable", reason: "analysis-off" });
  });
});

describe("Test 5: the pair launch through the composed listener and the window simulator", () => {
  interface PairWorld {
    readonly c: CodexComposition;
    readonly fx: BridgeFixture;
    readonly projectId: ProjectId;
    readonly guardInputs: LaunchGuardInput[];
  }

  async function pairWorld(capMs?: number): Promise<PairWorld> {
    const fx = createBridgeFixture();
    fixtures.push(fx);
    fx.installLauncher();
    fx.installMarker();
    vi.stubEnv("HOME", fx.home);
    const guardInputs: LaunchGuardInput[] = [];
    const guard: LaunchGuard = {
      check(input) {
        guardInputs.push(input);
        return Promise.resolve({ ok: true });
      },
      settle: () => Promise.resolve(),
    };
    const c = await compose({
      homeDir: fx.home,
      home: codexHomeWithThreads([]),
      routeContext: launchContext({ guard, ...(capMs === undefined ? {} : { capMs }) }),
      prepare: ({ store }) => {
        saveLauncherConfig(store.db, "antigravity", { bundleId: ANTIGRAVITY_IDE_BUNDLE_ID });
        saveLauncherConfig(store.db, "claude-code", {
          executablePath: fx.claudePath,
          args: [],
          terminal: { kind: "antigravity-terminal" },
        });
        saveLauncherConfig(store.db, "codex", { executablePath: fx.codexPath, args: [] });
      },
    });
    const projectId = insertProject(c.store.db, {
      path: fx.projectDir,
      displayName: "Example",
    }).record.projectId;
    return { c, fx, projectId, guardInputs };
  }

  function claimedAgents(fx: BridgeFixture): string[] {
    return fx
      .claimedFiles()
      .sort()
      .map(
        (file) =>
          (JSON.parse(readFileSync(join(fx.claimedDir, file), "utf8")) as { agent: string }).agent,
      );
  }

  it("current window: both halves open, Claude claimed first, the guard consulted once", async () => {
    const { c, fx, projectId, guardInputs } = await pairWorld();
    const sim = fx.simulator("current");
    sim.heartbeat();
    tickers.push(
      setInterval(() => {
        try {
          sim.tick();
        } catch {
          // The fixture was cleaned up while a tick was due.
        }
      }, 15),
    );
    const reply = await c.post(LAUNCH_PAIR_PATH, { projectId });
    expect(reply.status).toBe(200);
    expect(LaunchPairResponseSchema.parse(reply.body)).toEqual({
      claude: { status: "opened" },
      codex: { status: "opened" },
    });
    expect(claimedAgents(fx)).toEqual(["claude", "codex"]);
    expect(guardInputs).toHaveLength(1);
  });

  it("outdated window: both halves answer bridge-outdated and nothing is queued", async () => {
    const { c, fx, projectId, guardInputs } = await pairWorld();
    fx.simulator("outdated").heartbeat();
    const reply = await c.post(LAUNCH_PAIR_PATH, { projectId });
    expect(LaunchPairResponseSchema.parse(reply.body)).toEqual({
      claude: { status: "error", error: "bridge-outdated" },
      codex: { status: "error", error: "bridge-outdated" },
    });
    expect(fx.requestFiles()).toEqual([]);
    expect(fx.claimedFiles()).toEqual([]);
    expect(guardInputs).toHaveLength(1);
  });

  it("closed (no window): both halves answer window-not-ready before the cap and nothing stays queued", async () => {
    const capMs = 900;
    const { c, fx, projectId, guardInputs } = await pairWorld(capMs);
    const started = performance.now();
    const reply = await c.post(LAUNCH_PAIR_PATH, { projectId });
    const elapsed = performance.now() - started;
    expect(LaunchPairResponseSchema.parse(reply.body)).toEqual({
      claude: { status: "error", error: "window-not-ready" },
      codex: { status: "error", error: "window-not-ready" },
    });
    // Generous slack: a loaded machine delays timers; the point is that the cap bounds the reply.
    expect(elapsed).toBeLessThan(capMs + 2500);
    expect(fx.requestFiles()).toEqual([]);
    expect(guardInputs).toHaveLength(1);
  });
});

describe("Test 6: writeFakeCodex is what it claims to be", () => {
  it("has an absolute shebang, bakes scenario and log path, answers the three subcommands and logs names only", async () => {
    const c = await compose({ home: codexHomeWithThreads([]) });
    const fake = fakeCodexIn(c);
    const scenario = {
      appServer: { read: { kind: "result", result: weeklyReply(41) } },
      doctor: { behavior: { kind: "print", stdout: doctorReport() } },
    } as const;
    const text = readFileSync(fake.path, "utf8");
    expect(text).toBe(fakeCodexScriptSource(scenario, fake.logPath));
    expect(isAbsolute(text.split("\n")[0]?.slice(2) ?? "")).toBe(true);
    expect(text).toContain(JSON.stringify(fake.logPath));
    expect(text).toContain(FAKE_ACCOUNT_ID);
    expect(fake.path.endsWith("/codex")).toBe(true);
    expect(statSync(fake.path).mode & 0o111).not.toBe(0);
    // It reads no file: only appends to its own log, and never reads a variable's value.
    expect(text).not.toMatch(/readFile|readdir|createReadStream|statSync|existsSync|openSync/);
    expect(text.match(/process\.env/g)?.length).toBe(
      text.match(/Object\.keys\(process\.env\)/g)?.length,
    );

    const run = (args: string[], input?: string) =>
      spawnSync(fake.path, args, {
        cwd: c.dir,
        env: { PATH: "/usr/bin:/bin", HOME: c.homeDir },
        input,
        encoding: "utf8",
        timeout: 15_000,
      });
    const version = run(["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout).toBe("codex-cli 0.159.2\n");
    const doctor = run(["doctor", "--json"]);
    expect(doctor.status).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ schemaVersion: 1 });
    const rpcMessages = [
      { id: 1, method: "initialize", params: {} },
      { method: "initialized" },
      { id: 2, method: "account/rateLimits/read" },
    ];
    const rpc = run(
      ["app-server"],
      `${rpcMessages.map((message) => JSON.stringify(message)).join("\n")}\n`,
    );
    expect(rpc.stdout).toContain('"usedPercent":41');

    const starts = fakeCodexStarts(fake.logPath);
    expect(starts.map((entry) => entry.argv)).toEqual([
      ["--version"],
      ["doctor", "--json"],
      ["app-server"],
    ]);
    for (const entry of starts) {
      expect(entry.envKeys).toEqual(["HOME", "PATH"]);
      expect(entry.cwd).toBe(c.dir);
    }
    expect(readdirSync(dirname(fake.path)).sort()).toEqual(["codex", "codex.log.ndjson"]);
  });
});

describe("Test 7: the usage cadence and the subscriber rule, on injected timers", () => {
  interface Armed {
    readonly fn: () => void;
    readonly ms: number;
    cleared: boolean;
  }

  function recordingTimers(): { armed: Armed[]; timers: HeadroomTimers } {
    const armed: Armed[] = [];
    return {
      armed,
      timers: {
        setInterval(fn, ms) {
          const entry: Armed = { fn, ms, cleared: false };
          armed.push(entry);
          return entry;
        },
        clearInterval(handle) {
          (handle as Armed).cleared = true;
        },
      },
    };
  }

  const settleMs = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

  it("reads once per 60 second interval while subscribed, reads through when the cache is stale, and stops when nobody watches", async () => {
    const clock = { ms: Date.now() };
    const rec = recordingTimers();
    const c = await compose({
      appServer: { read: { kind: "result", result: weeklyReply(41) } },
      home: codexHomeWithThreads([], clock.ms),
      now: () => clock.ms,
      deps: { timers: rec.timers },
    });
    c.control.subscribers = 1;
    c.codex?.start();
    const usageTimer = rec.armed.find((entry) => entry.ms === HEADROOM_REFRESH_INTERVAL_MS);
    expect(HEADROOM_REFRESH_INTERVAL_MS).toBe(60_000);
    expect(usageTimer).toBeDefined();
    // Arming reads nothing.
    expect(c.appServerStarts()).toBe(0);

    usageTimer?.fn();
    expect(await waitFor(() => c.appServerStarts() === 1)).toBe(true);
    // Between intervals nothing reads, whatever else ticks.
    clock.ms += 30_000;
    for (const other of rec.armed.filter((entry) => entry !== usageTimer)) other.fn();
    await settleMs(150);
    expect(c.appServerStarts()).toBe(1);

    clock.ms += 30_000;
    usageTimer?.fn();
    expect(await waitFor(() => c.appServerStarts() === 2)).toBe(true);
    await settleMs(100);
    expect(c.appServerStarts()).toBe(2);

    // A read-through at request time: the cache is older than the live window and no timer fired.
    clock.ms += 130_000;
    await c.get(CODEX_HEADROOM_PATH);
    expect(c.appServerStarts()).toBe(3);

    // Nobody watching: the interval fires and reads nothing.
    c.control.subscribers = 0;
    clock.ms += 60_000;
    usageTimer?.fn();
    await settleMs(200);
    expect(c.appServerStarts()).toBe(3);

    // Stopping clears every timer it armed.
    await c.codex?.stop();
    expect(rec.armed.every((entry) => entry.cleared)).toBe(true);
  });

  it("polls the Codex home only while someone is subscribed", async () => {
    const home = createFakeCodexHome(
      codexHomeWithThreads([{ id: "thread-cadence", agoMs: 2 * HOUR }], Date.now()),
    );
    const recorder = recordingFs();
    const rec = recordingTimers();
    const c = await compose({
      homeInstance: home,
      deps: { port: createCodexHomePort({ root: home.root, fs: recorder.fs }), timers: rec.timers },
    });
    c.codex?.start();
    expect(rec.armed.some((entry) => entry.ms === DEFAULT_POLL_INTERVAL_MS)).toBe(true);
    const baseline = recorder.calls.length;

    c.control.subscribers = 0;
    for (const entry of rec.armed) entry.fn();
    await settleMs(250);
    expect(recorder.calls.length).toBe(baseline);

    c.control.subscribers = 1;
    for (const entry of rec.armed) entry.fn();
    expect(await waitFor(() => recorder.calls.length > baseline)).toBe(true);
  });
});
