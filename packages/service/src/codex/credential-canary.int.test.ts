import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fsNamespace from "node:fs";
import fsDefault, {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTH_HEADER,
  CLAUDE_TRANSCRIPT_ANALYSIS_PATH,
  CLAUDE_USAGE_DELETE_PATH,
  CODEX_DOCTOR_PATH,
  CODEX_FOLLOW_LOG_PATH,
  CODEX_HOOK_EVENTS_PATH,
  CODEX_OPEN_TRANSCRIPT_PATH,
  EVENTS_PATH,
  HEALTH_PATH,
  LAUNCH_PAIR_PATH,
  LAUNCH_PATH,
  LAUNCHERS_DETECT_PATH,
  LAUNCHERS_GET_PATH,
  LAUNCHERS_MARK_TESTED_PATH,
  LAUNCHERS_SAVE_PATH,
  LAUNCHERS_TEST_PATH,
  SNAPSHOT_PATH,
  SYSTEM_SETTINGS_OPEN_PATH,
} from "@ccc/domain";
import { projectDirName } from "@ccc/launchers";
import { insertProject, saveLauncherConfig } from "@ccc/operational-store";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttributeFn } from "../claude/attribution.js";
import { launchRoutes } from "../projects/launch-routes.js";
import { launcherRoutes } from "../projects/launcher-routes.js";
import { type BridgeFixture, createBridgeFixture } from "../test-support/bridge-fixtures.js";
import {
  type CodexComposition,
  codexHomeWithThreads,
  startCodexComposition,
  waitFor,
} from "../test-support/codex-composition.js";
import { launchContext } from "../test-support/codex-launch-context.js";
import {
  nextRunId,
  RUN_DECOYS,
  writeLiveLog,
  writeReportDecoy,
  writeRunRecord,
} from "../test-support/codex-run-fixtures.js";
import {
  ALL_DECOYS,
  contentLines,
  jsonl,
  metaLine,
  raw,
  turn,
  turnRecordLine,
} from "../test-support/codex-token-fixtures.js";
import { fakeCodexStarts, readFakeCodexLog, writeFakeCodex } from "../test-support/fake-codex.js";
import { FAKE_ACCOUNT_ID, weeklyReply } from "../test-support/fake-codex-app-server.js";
import {
  DOCTOR_DECOY_ACCOUNT,
  DOCTOR_DECOY_PATH,
  doctorReport,
} from "../test-support/fake-codex-doctor.js";
import {
  assertNoForbiddenAccess,
  createFakeCodexHome,
  DECOY_CREATOR_ID,
  DECOY_MARKER,
  exerciseCodexHomePort,
  exerciseCodexStoreReader,
  type FakeCodexHome,
  isAllowedCodexAccess,
  NEVER_SELECT_DECOYS,
  type RecordedCall,
  recordingFs,
  recordingOpener,
} from "../test-support/fake-codex-home.js";
import {
  FS_EXEMPT,
  FS_PROMISES_EXEMPT,
  type FsAccess,
  filterAccessesTo,
  filterAccessesWhere,
  sharedFsRecorder,
  WRAPPED_FS_FUNCTIONS,
} from "../test-support/fs-recorder.js";
import { CodexHomeAccessError, createCodexHomePort } from "./codex-home.js";
import { codexRouteTable } from "./routes.js";
import { createCodexStoreReader } from "./store-reader.js";

/**
 * The service-wide CODEX-09 credential canary (plan 05.1-29, T-05.1-05, T-05.1-06, T-05.1-29).
 *
 * The REAL composed Codex services run a full cycle against a fake Codex home that holds a decoy
 * credential file, a decoy configuration file and lookalikes (invented sentinel contents, names
 * assembled at runtime): hook delivery, the sessions mirror poll, the token sweep, a headroom read
 * through the fake app-server, a doctor run, a follow request, a transcript open, the launcher
 * routes, the snapshot and the event stream. Afterwards:
 *
 * 1. no recorded file-system access touched a decoy, by path or by real path, and every access
 *    inside the Codex home is on the port's allowlist;
 * 2. no sentinel appears in any response (body and headers), published event, event-stream frame,
 *    log line, operational-store row, process-launch record or child log;
 * 3. the decoys' access times, modification times and content hashes did not change.
 *
 * LAYERS AND THEIR LIMIT. The recorded file-system layer (test-support/fs-recorder.ts, installed
 * below with the runner's module mocking) sees every `node:fs` and `node:fs/promises` call in the
 * composed module graph. A native binding (the SQLite driver) and a child process open files
 * without going through it, so they are covered by the OTHER layers asserted here: the CODEX_HOME
 * port's own access record, the recording database opener, the fake codex's log of argv,
 * environment key names and working directory, and (outside this file) plan 05.1-14's allowlist
 * test and the source backstop.
 *
 * THE CANARY CAN FAIL. The negative controls at the end run the same cycle against a deliberately
 * violating service and assert that BOTH detectors fire; the recorder is itself checked per
 * function family, so a gap in the wrapper is a test failure and not a silent pass.
 *
 * Every path is temporary; the owner's Codex home, bridge state and runtime directory are never
 * named. HOME and XDG_STATE_HOME are stubbed to temporary directories.
 */

vi.mock("node:fs", async () => {
  const { sharedFsRecorder: shared } = await import("../test-support/fs-recorder.js");
  return shared().mockFs(await vi.importActual<typeof import("node:fs")>("node:fs"));
});
vi.mock("node:fs/promises", async () => {
  const { sharedFsRecorder: shared } = await import("../test-support/fs-recorder.js");
  return shared().mockFsPromises(
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"),
    await vi.importActual<typeof import("node:fs")>("node:fs"),
  );
});

const recorder = sharedFsRecorder();
/** Test infrastructure that must touch the decoys or read results back runs unrecorded. */
const quiet = <T>(fn: () => T): T => recorder.whilePaused(fn);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const HOUR = 3_600_000;
/** The repository-wide privacy scan walks every tracked file; under load it takes tens of seconds. */
const PRIVACY_SCAN_TIMEOUT_MS = 180_000;
const LONG_AGO_S = 1_000_000;

// --- sentinels: invented, assembled at runtime so no tracked line is secret-shaped --------------

const part = (...pieces: string[]): string => pieces.join("");
const CREDENTIAL_SENTINEL = part("SENTINEL-CRED-", "q7f3", "-w9k2", "-not-real");
const CONFIG_SENTINEL = part("SENTINEL-CONF-", "m4d8", "-z1p6", "-not-real");
const CREDENTIAL_NAME = part("auth", ".", "json");
const CONFIG_NAME = part("config", ".", "toml");

/** Everything that must never reach an output channel. */
const SENTINELS: readonly string[] = [
  CREDENTIAL_SENTINEL,
  CONFIG_SENTINEL,
  DECOY_MARKER,
  FAKE_ACCOUNT_ID,
  DECOY_CREATOR_ID,
  DOCTOR_DECOY_ACCOUNT,
  DOCTOR_DECOY_PATH,
  ...NEVER_SELECT_DECOYS,
  ...ALL_DECOYS,
  ...RUN_DECOYS,
];

// --- the two detectors (both throw, so the negative control can prove they can fire) ------------

/** A pattern naming any directory called like the owner's Codex home (built from fragments). */
const REAL_CODEX_DIR = new RegExp(`[/]${part("\\.", "cod", "ex")}([/]|$)`);

function assertNoDecoyAccess(
  accesses: readonly FsAccess[],
  portCalls: readonly RecordedCall[],
  home: FakeCodexHome,
  extraForbiddenPaths: readonly string[],
): void {
  const forbidden = [
    home.decoys.credentialPath,
    home.decoys.configPath,
    ...home.decoys.lookalikeNames.map((name) => join(home.root, name)),
    ...extraForbiddenPaths,
  ];
  for (const path of forbidden) {
    const hit = filterAccessesTo(accesses, path)[0];
    if (hit !== undefined) throw new Error(`canary: ${hit.fn} reached a decoy file`);
  }
  const named = filterAccessesWhere(
    accesses,
    (path) => path.includes(CREDENTIAL_NAME) || path.includes(CONFIG_NAME),
  )[0];
  if (named !== undefined) throw new Error(`canary: ${named.fn} named a credential or config file`);
  const outside = filterAccessesWhere(
    accesses,
    (path) =>
      (path === home.root || path.startsWith(`${home.root}/`)) &&
      !isAllowedCodexAccess(path, home.root),
  )[0];
  if (outside !== undefined) throw new Error(`canary: ${outside.fn} left the Codex allowlist`);
  const realHome = filterAccessesWhere(accesses, (path) => REAL_CODEX_DIR.test(path))[0];
  if (realHome !== undefined) throw new Error(`canary: ${realHome.fn} reached a Codex home`);
  assertNoForbiddenAccess(portCalls, home);
}

function assertNoSentinelLeak(sinks: Sinks): void {
  for (const [sink, text] of Object.entries(sinks) as Array<[string, string]>) {
    for (const sentinel of SENTINELS) {
      if (text.includes(sentinel)) throw new Error(`canary: a sentinel leaked into ${sink}`);
    }
  }
}

// --- the world: bridge fixture, fake home with decoys, composition, recorders --------------------

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: unknown;
}

interface World {
  readonly c: CodexComposition;
  readonly fx: BridgeFixture;
  readonly home: FakeCodexHome;
  readonly fake: ReturnType<typeof writeFakeCodex>;
  readonly portRecord: ReturnType<typeof recordingFs>;
  readonly responses: string[];
  readonly exerciseOutputs: string[];
  readonly decoyFiles: ReadonlyMap<string, { content: string }>;
  readonly reportDecoy: string;
  readonly threadIds: { completed: string; running: string };
  readonly runId: string;
  stream: { text(): string; close(): void };
  fsAccesses: FsAccess[];
  call(method: string, path: string, body?: unknown): Promise<Reply>;
  dispose(): Promise<void>;
}

function rawCall(
  socketPath: string,
  token: string,
  method: string,
  path: string,
  body: unknown,
): Promise<{ reply: Reply; headers: string }> {
  return new Promise((resolveCall, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        path,
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload === null
            ? {}
            : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = null;
          try {
            parsed = text.length > 0 ? (JSON.parse(text) as unknown) : null;
          } catch {
            parsed = text;
          }
          resolveCall({
            reply: { status: res.statusCode ?? 0, text, body: parsed },
            headers: JSON.stringify(res.headers),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

function openStream(socketPath: string, token: string): World["stream"] {
  let frames = "";
  const req = http.request(
    { socketPath, path: EVENTS_PATH, method: "GET", headers: { [AUTH_HEADER]: `Bearer ${token}` } },
    (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        frames += chunk;
      });
    },
  );
  req.on("error", () => undefined);
  req.end();
  return { text: () => frames, close: () => req.destroy() };
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** The fake Codex home: two threads, a token rollout, decoy files with fixed times. */
function buildHome(
  now: number,
  ids: World["threadIds"],
): { home: FakeCodexHome; files: World["decoyFiles"] } {
  return quiet(() => {
    const base = codexHomeWithThreads(
      [
        {
          id: ids.completed,
          agoMs: 2 * HOUR,
          title: "Refactor the parser",
          lifecycle: [
            ["task_started", 2 * HOUR + 5000],
            ["task_complete", 2 * HOUR],
          ],
        },
        { id: ids.running, agoMs: 60_000, lifecycle: [["task_started", 60_000]] },
      ],
      now,
    );
    const day = new Date(now).toISOString().slice(0, 10);
    const stamp = (offsetS: number): string => new Date(now - HOUR + offsetS * 1000).toISOString();
    const tokenThread = "thread-canary-tokens";
    const home = createFakeCodexHome({
      ...base,
      rollouts: [
        ...(base.rollouts ?? []),
        {
          day,
          name: `rollout-${stamp(0).slice(0, 19).replaceAll(":", "-")}-${tokenThread}.jsonl`,
          content: jsonl([
            metaLine({ id: tokenThread, timestamp: stamp(0) }),
            ...contentLines(stamp(1)),
            turnRecordLine({
              turnId: turn(1),
              timestamp: stamp(21),
              usage: raw(100, 20),
              threadId: tokenThread,
            }),
            turnRecordLine({
              turnId: turn(1),
              timestamp: stamp(65),
              usage: raw(400, 90),
              threadId: tokenThread,
            }),
          ]),
        },
      ],
      withDecoys: true,
    });
    const files = new Map<string, { content: string }>();
    const credential = `${CREDENTIAL_SENTINEL}\n`;
    const config = `notify = ["${CONFIG_SENTINEL}"]\n`;
    writeFileSync(home.decoys.credentialPath, credential);
    writeFileSync(home.decoys.configPath, config);
    files.set(home.decoys.credentialPath, { content: credential });
    files.set(home.decoys.configPath, { content: config });
    for (const name of home.decoys.lookalikeNames) {
      files.set(join(home.root, name), { content: `${DECOY_MARKER}\n` });
    }
    // Fixed times far in the past: any read or write would move the access or modification time.
    for (const path of files.keys()) utimesSync(path, LONG_AGO_S, LONG_AGO_S);
    return { home, files };
  });
}

async function buildWorld(violating: boolean): Promise<World> {
  const fx = createBridgeFixture();
  fx.installLauncher();
  fx.installMarker();
  vi.stubEnv("HOME", fx.home);
  vi.stubEnv("XDG_STATE_HOME", "");
  const now = Date.now();
  const threadIds = { completed: "thread-canary-completed", running: "thread-canary-running" };
  const { home, files } = buildHome(now, threadIds);
  const reportDecoy = { path: "" };

  const portRecord = recordingFs();
  const recPort = createCodexHomePort({ root: home.root, fs: portRecord.fs });
  const violatingAttribute: AttributeFn = async () => ({
    projectId: readFileSync(home.decoys.credentialPath, "utf8").trim(),
    worktreeRoot: null,
    reason: "project-root",
  });

  const userState = join(fx.stateDir, "projects", projectDirName(fx.projectDir));
  let fakeHolder: ReturnType<typeof writeFakeCodex> | undefined;
  let runId = "";
  const c = await startCodexComposition({
    homeDir: fx.home,
    homeInstance: home,
    usage: "real",
    saveRow: false,
    env: { CCC_CODEX_HOME: home.root },
    routeContext: launchContext(),
    deps: {
      port: recPort,
      openDatabase: recordingOpener(portRecord.calls),
      ...(violating ? { attribute: violatingAttribute } : {}),
    },
    prepare: ({ store, dir }) => {
      fakeHolder = writeFakeCodex(join(dir, "fake"), {
        appServer: { read: { kind: "result", result: weeklyReply(41) }, stderrNoise: true },
        doctor: {
          behavior: { kind: "print", stdout: doctorReport() },
          stderrNoise: true,
        },
      });
      saveLauncherConfig(store.db, "codex", { executablePath: fakeHolder.path, args: [] });
      insertProject(store.db, { path: fx.projectDir, displayName: "canary-project" });
      const record = writeRunRecord(userState, {
        kind: "task",
        mode: "headless",
        status: "running",
        decoys: true,
      });
      runId = record.runId;
      writeLiveLog(userState, record.runId, "task", { mtimeMs: Date.now() - 2000 });
      reportDecoy.path = writeReportDecoy(userState, nextRunId());
    },
  });
  if (fakeHolder === undefined) throw new Error("the fake codex was not written");
  const token = c.token;
  const responses: string[] = [];
  const world: World = {
    c,
    fx,
    home,
    fake: fakeHolder,
    portRecord,
    responses,
    exerciseOutputs: [],
    decoyFiles: files,
    reportDecoy: reportDecoy.path,
    threadIds,
    runId,
    stream: openStream(c.socketPath, token),
    fsAccesses: [],
    async call(method, path, body) {
      const { reply, headers } = await rawCall(c.socketPath, token, method, path, body);
      responses.push(`${method} ${path} ${reply.status} ${headers} ${reply.text}`);
      return reply;
    },
    async dispose() {
      world.stream.close();
      await c.close();
      fx.cleanup();
    },
  };
  return world;
}

/** The body each walked route is sent. A POST route with no entry here fails the walk loudly. */
function bodyFor(world: World, method: string, path: string): unknown {
  if (method === "GET") return undefined;
  const bodies: Readonly<Record<string, unknown>> = {
    [CODEX_DOCTOR_PATH]: {},
    [CODEX_OPEN_TRANSCRIPT_PATH]: { threadId: world.threadIds.completed, via: "reveal" },
    [CODEX_FOLLOW_LOG_PATH]: { runId: world.runId },
    [CODEX_HOOK_EVENTS_PATH]: {
      eventId: randomUUID(),
      observedAt: new Date().toISOString(),
      hook_event_name: "Stop",
      session_id: world.threadIds.running,
      turn_id: "turn-1",
    },
    [LAUNCH_PATH]: { projectId: firstProjectId(world), action: "finder" },
    [LAUNCH_PAIR_PATH]: { projectId: firstProjectId(world) },
    [LAUNCHERS_DETECT_PATH]: {},
    [LAUNCHERS_GET_PATH]: {},
    [LAUNCHERS_SAVE_PATH]: {
      launcherId: "codex",
      executable: { kind: "path", path: world.fake.path },
      args: [],
    },
    [LAUNCHERS_TEST_PATH]: { launcherId: "codex" },
    [LAUNCHERS_MARK_TESTED_PATH]: { launcherId: "codex" },
    [SYSTEM_SETTINGS_OPEN_PATH]: { pane: "automation" },
  };
  if (!(path in bodies)) {
    throw new Error(
      `canary: no request body defined for ${method} ${path}; add one so it is exercised`,
    );
  }
  return bodies[path];
}

function firstProjectId(world: World): string {
  const row = world.c.store.db.prepare("SELECT project_id AS id FROM projects LIMIT 1").get() as
    | { id: string }
    | undefined;
  return row?.id ?? "missing-project";
}

/** Walks the LIVE route tables: a route added later is exercised automatically or the walk throws. */
async function walkRoutes(world: World): Promise<Map<string, number>> {
  const statuses = new Map<string, number>();
  const tables = [codexRouteTable, launchRoutes, launcherRoutes];
  for (const table of tables) {
    for (const [path, verbs] of Object.entries(table)) {
      for (const method of Object.keys(verbs)) {
        const reply = await world.call(method, path, bodyFor(world, method, path));
        statuses.set(`${method} ${path}`, reply.status);
        expect(reply.status, `${method} ${path}`).toBeLessThan(500);
      }
    }
  }
  return statuses;
}

async function settle(world: World, rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    world.c.timers.tick();
    await delay(120);
  }
}

/** The full cycle of the clean run. */
async function runFullCycle(world: World): Promise<{ statuses: Map<string, number> }> {
  const { c, call } = world;
  c.control.subscribers = 1;
  c.codex?.start();
  await settle(world, 3);
  await call("POST", CLAUDE_TRANSCRIPT_ANALYSIS_PATH, { enabled: true });
  await waitFor(() => c.events("codex.tokens.updated").length >= 1, 8000);
  await settle(world, 2);

  const statuses = await walkRoutes(world);
  await call("GET", SNAPSHOT_PATH);
  await call("GET", HEALTH_PATH);

  // Hostile arguments straight at the port and the reader, while the services are running.
  const reader = createCodexStoreReader({
    port: createCodexHomePort({ root: world.home.root, fs: world.portRecord.fs }),
    openDatabase: recordingOpener(world.portRecord.calls),
    now: () => Date.now(),
  });
  world.exerciseOutputs.push(
    ...exerciseCodexHomePort(
      createCodexHomePort({ root: world.home.root, fs: world.portRecord.fs }),
      world.home,
    ).outputs,
    ...exerciseCodexStoreReader(reader, Date.now()).outputs,
  );

  await settle(world, 2);
  await call("POST", CLAUDE_TRANSCRIPT_ANALYSIS_PATH, { enabled: false });
  await call("POST", CLAUDE_USAGE_DELETE_PATH, {});
  await settle(world, 1);
  return { statuses };
}

/** The bridge simulator answers follow requests while the cycle runs. */
function startSimulator(world: World): ReturnType<typeof setInterval> {
  const sim = world.fx.simulator("current");
  sim.heartbeat();
  return setInterval(() => {
    try {
      sim.tick();
    } catch {
      // The fixture was cleaned up while a tick was due.
    }
  }, 30);
}

function dumpStore(db: Database.Database): string {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return tables
    .map(({ name }) => `${name} ${JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())}`)
    .join("\n");
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Every output channel, as text. */
interface Sinks {
  readonly responses: string;
  readonly events: string;
  readonly streamFrames: string;
  readonly serviceLog: string;
  readonly routeLog: string;
  readonly store: string;
  readonly processLaunches: string;
  readonly fakeCodexLog: string;
  readonly portAndReaderOutputs: string;
}

function collectSinks(world: World): Sinks {
  return quiet(() => ({
    responses: world.responses.join("\n"),
    events: JSON.stringify(world.c.bus.buffer.since(0)),
    streamFrames: world.stream.text(),
    serviceLog: readOrEmpty(join(world.c.dir, "logs", "service.log")),
    routeLog: readOrEmpty(join(process.env.CCC_RUNTIME_DIR ?? "", "logs", "service.log")),
    store: dumpStore(world.c.store.db),
    processLaunches: JSON.stringify([world.c.spawner.calls, world.c.spawner.detached]),
    fakeCodexLog: readOrEmpty(world.fake.logPath),
    portAndReaderOutputs: world.exerciseOutputs.join("\n"),
  }));
}

// --- the clean run, shared by tests 1 to 3 -------------------------------------------------------

describe("the service-wide credential canary", () => {
  let world: World;
  let statuses: Map<string, number>;
  let ticker: ReturnType<typeof setInterval>;

  beforeAll(async () => {
    recorder.clear();
    world = await buildWorld(false);
    ticker = startSimulator(world);
    recorder.clear();
    ({ statuses } = await runFullCycle(world));
    world.fsAccesses = [...recorder.all()];
  }, 120_000);

  afterAll(async () => {
    clearInterval(ticker);
    await world.dispose();
    vi.unstubAllEnvs();
  });

  it("Test 1 (tracer): every route of the live tables ran, and no decoy was reached by path, real path or the port", () => {
    // Not vacuous: the cycle really read the Codex home and opened its store.
    expect(world.fsAccesses.length).toBeGreaterThan(0);
    expect(world.portRecord.calls.some((call) => call.op === "openDatabase")).toBe(true);
    expect(world.portRecord.calls.some((call) => call.op === "readBytes")).toBe(true);
    expect(
      filterAccessesWhere(world.fsAccesses, (p) => p.startsWith(world.home.root)).length,
    ).toBeGreaterThan(0);
    // Every Codex route, with every verb the table defines, was walked and is a real route.
    for (const [path, verbs] of Object.entries(codexRouteTable)) {
      for (const method of Object.keys(verbs)) {
        const status = statuses.get(`${method} ${path}`);
        expect(status, `${method} ${path} was walked`).toBeDefined();
        expect([404, 503]).not.toContain(status);
      }
    }
    expect(() =>
      assertNoDecoyAccess(world.fsAccesses, world.portRecord.calls, world.home, [
        world.reportDecoy,
      ]),
    ).not.toThrow();
  });

  it("Test 1b: the decoys' access times, modification times and content hashes did not change", () => {
    quiet(() => {
      for (const [path, { content }] of world.decoyFiles) {
        const stat = statSync(path);
        expect(stat.atimeMs / 1000, path).toBeCloseTo(LONG_AGO_S, 0);
        expect(stat.mtimeMs / 1000, path).toBeCloseTo(LONG_AGO_S, 0);
        expect(readFileSync(path, "utf8")).toBe(content);
      }
    });
  });

  it("Test 2: no sentinel is in any response, event, stream frame, log line, store row or child log", () => {
    const sinks = collectSinks(world);
    // The sinks are real: each holds what the cycle produced.
    expect(sinks.responses).toContain('"kind":"available"');
    expect(sinks.events.length).toBeGreaterThan(200);
    expect(sinks.streamFrames).toContain("data:");
    expect(sinks.serviceLog.length + sinks.routeLog.length).toBeGreaterThan(0);
    expect(sinks.store).toContain("launcher_config");
    expect(sinks.fakeCodexLog).toContain('"argv":["app-server"]');
    expect(sinks.processLaunches.length).toBeGreaterThan(4);
    expect(() => assertNoSentinelLeak(sinks)).not.toThrow();
  });

  it("Test 3: the child processes ran with the documented argv, a key-name-only environment and no Codex-home cwd", () => {
    const starts = fakeCodexStarts(world.fake.logPath);
    const argvs = starts.map((start) => start.argv.join(" "));
    expect(argvs).toContain("app-server");
    expect(argvs).toContain("doctor --json");
    for (const start of starts) {
      expect(["app-server", "doctor --json"]).toContain(start.argv.join(" "));
      // Only the single CODEX_HOME key may name the home, and only because the dependency supplied one.
      expect([...start.envKeys]).toEqual(["CODEX_HOME", "HOME", "LC_ALL", "PATH"]);
      expect(start.envKeys.some((key) => /TOKEN|KEY|SECRET|AUTH|PASS|CRED|COOKIE/i.test(key))).toBe(
        false,
      );
      expect(start.cwd === world.home.root || start.cwd.startsWith(`${world.home.root}/`)).toBe(
        false,
      );
    }
    // The app-server saw exactly the three-message sequence per start.
    const lines = readFakeCodexLog(world.fake.logPath).filter((entry) => entry.t === "line");
    expect(lines.length).toBe(3 * starts.filter((s) => s.argv[0] === "app-server").length);
  });
});

// --- the negative controls ---------------------------------------------------------------------

describe("negative control: the canary can fail", () => {
  let current: World | undefined;

  async function fresh(violating: boolean): Promise<World> {
    const built = await buildWorld(violating);
    current = built;
    return built;
  }

  afterEach(async () => {
    await current?.dispose();
    current = undefined;
    vi.unstubAllEnvs();
  });

  it("Test 4: a deliberately violating service trips BOTH detectors", async () => {
    recorder.clear();
    const world = await fresh(true);
    world.c.control.subscribers = 1;
    world.c.codex?.start();
    recorder.clear();
    const sessions = await world.call("GET", "/api/v1/codex/sessions");
    expect(sessions.status).toBe(200);
    await world.call("GET", SNAPSHOT_PATH);
    await settle(world, 2);
    const accesses = [...recorder.all()];

    // Detector 1: the recorded layer lists the decoy the violating service read.
    expect(filterAccessesTo(accesses, world.home.decoys.credentialPath).length).toBeGreaterThan(0);
    expect(() => assertNoDecoyAccess(accesses, world.portRecord.calls, world.home, [])).toThrow(
      /canary: .* reached a decoy file/,
    );
    // Detector 2: the sentinel scan finds the credential in a real response and a real event.
    const sinks = collectSinks(world);
    expect(sinks.responses).toContain(CREDENTIAL_SENTINEL);
    expect(() => assertNoSentinelLeak(sinks)).toThrow(/canary: a sentinel leaked into/);
  }, 60_000);

  it("Test 4b: the same detectors pass on a clean service run in the same file (they are not always-fail)", async () => {
    recorder.clear();
    const world = await fresh(false);
    world.c.control.subscribers = 1;
    world.c.codex?.start();
    recorder.clear();
    await world.call("GET", "/api/v1/codex/sessions");
    await settle(world, 2);
    expect(() =>
      assertNoDecoyAccess([...recorder.all()], world.portRecord.calls, world.home, []),
    ).not.toThrow();
    expect(() => assertNoSentinelLeak(collectSinks(world))).not.toThrow();
  }, 60_000);

  it("Test 4c: a read of the decoy credential through the port's non-allowlisted open is refused with the typed error and no file call", async () => {
    recorder.clear();
    const world = await fresh(false);
    const port = createCodexHomePort({ root: world.home.root, fs: world.portRecord.fs });
    const before = world.portRecord.calls.length;
    let thrown: unknown;
    try {
      port.readNamed(world.home.decoys.credentialName, 64);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CodexHomeAccessError);
    expect(world.portRecord.calls.length).toBe(before);
    expect(filterAccessesTo([...recorder.all()], world.home.decoys.credentialPath)).toEqual([]);
    // A port double that DOES read it is recorded by the port-level layer and rejected.
    world.portRecord.fs.readBytes(world.home.decoys.credentialPath, 0, 8);
    expect(() => assertNoForbiddenAccess(world.portRecord.calls, world.home)).toThrow(/canary/);
  }, 60_000);
});

describe("negative control: each detector rule and each sink has teeth", () => {
  const clean: Sinks = {
    responses: "ok",
    events: "ok",
    streamFrames: "ok",
    serviceLog: "ok",
    routeLog: "ok",
    store: "ok",
    processLaunches: "ok",
    fakeCodexLog: "ok",
    portAndReaderOutputs: "ok",
  };

  it("Test 4d: a sentinel in any ONE sink is reported, naming that sink", () => {
    expect(() => assertNoSentinelLeak(clean)).not.toThrow();
    for (const sink of Object.keys(clean) as Array<keyof Sinks>) {
      for (const sentinel of SENTINELS) {
        expect(
          () => assertNoSentinelLeak({ ...clean, [sink]: `before ${sentinel} after` }),
          `${sink} / ${sentinel.slice(0, 8)}`,
        ).toThrow(new RegExp(`canary: a sentinel leaked into ${sink}`));
      }
    }
  });

  it("Test 4e: each access rule fires on a crafted access, and an allowlisted one passes", () => {
    const home = quiet(() => createFakeCodexHome({ withDecoys: true }));
    try {
      const at = (path: string, realpath: string | null = null): FsAccess[] => [
        { fn: "readFileSync", path, realpath },
      ];
      const check = (accesses: FsAccess[], extra: string[] = []): void =>
        assertNoDecoyAccess(accesses, [], home, extra);
      expect(() => check(at(join(home.root, "sessions")))).not.toThrow();
      expect(() => check(at(join(home.root, "state_5.sqlite")))).not.toThrow();
      expect(() => check(at(home.decoys.credentialPath))).toThrow(/reached a decoy file/);
      expect(() => check(at(home.decoys.configPath))).toThrow(/reached a decoy file/);
      expect(() => check(at(join(home.root, home.decoys.lookalikeNames[0] ?? "")))).toThrow(
        /reached a decoy file/,
      );
      // A link whose path looks harmless but whose real path is the decoy.
      expect(() =>
        check(at(join(home.root, "sessions", "harmless"), home.decoys.credentialPath)),
      ).toThrow(/reached a decoy file/);
      // A name anywhere, a file in the home off the allowlist, a Codex-home-like folder, a report decoy.
      expect(() => check(at(join(tmpdir(), CREDENTIAL_NAME)))).toThrow(
        /named a credential or config file/,
      );
      expect(() => check(at(join(home.root, "unlisted.txt")))).toThrow(/left the Codex allowlist/);
      expect(() => check(at(join(tmpdir(), part(".", "cod", "ex"), "x")))).toThrow(
        /reached a Codex home/,
      );
      expect(() => check(at("/tmp/reports/decoy.json"), ["/tmp/reports/decoy.json"])).toThrow(
        /reached a decoy file/,
      );
      // The port-level layer: an off-allowlist call is rejected by the shared assertion.
      expect(() =>
        assertNoDecoyAccess(
          [],
          [{ op: "readBytes", path: join(home.root, "unlisted.txt") }],
          home,
          [],
        ),
      ).toThrow(/canary/);
    } finally {
      quiet(() => home.cleanup());
    }
  });
});

// --- the recorder is itself checked -------------------------------------------------------------

describe("Test 5: the recorder records every function family (a silent gap is a failure)", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "ccc-fs-recorder-")));
    file = join(dir, "ordinary.txt");
    quiet(() => writeFileSync(file, "ordinary"));
    recorder.clear();
  });

  afterEach(() => {
    quiet(() => fsNamespace.rmSync(dir, { recursive: true, force: true }));
  });

  const touched = (fn: string, path: string = file): boolean =>
    filterAccessesTo([...recorder.all()], path).some((access) => access.fn === fn);

  it("records the synchronous, callback, promise, stream, directory and real-path families", async () => {
    readFileSync(file);
    statSync(file);
    fsNamespace.lstatSync(file);
    existsSync(file);
    fsNamespace.accessSync(file);
    readdirSync(dir);
    fsNamespace.opendirSync(dir).closeSync();
    realpathSync(file);
    realpathSync.native(file);
    fsNamespace.closeSync(fsNamespace.openSync(file, "r"));
    await new Promise<void>((done) => fsNamespace.readFile(file, () => done()));
    await new Promise<void>((done) => fsNamespace.stat(file, () => done()));
    await new Promise<void>((done) => fsNamespace.readdir(dir, () => done()));
    await new Promise<void>((done) => {
      const stream = createReadStream(file);
      stream.on("data", () => undefined);
      stream.on("close", () => done());
    });
    await fsPromises.readFile(file);
    await fsPromises.stat(file);
    await fsPromises.readdir(dir);
    await fsPromises.realpath(file);
    await fsPromises.access(file);
    await (await fsPromises.open(file, "r")).close();
    await fsNamespace.promises.readFile(file);
    fsDefault.readFileSync(file);

    for (const fn of [
      "readFileSync",
      "statSync",
      "lstatSync",
      "existsSync",
      "accessSync",
      "realpathSync",
      "realpathSync.native",
      "openSync",
      "readFile",
      "stat",
      "createReadStream",
      "promises.readFile",
      "promises.stat",
      "promises.realpath",
      "promises.access",
      "promises.open",
    ]) {
      expect(touched(fn), fn).toBe(true);
    }
    expect(touched("readdirSync", dir)).toBe(true);
    expect(touched("opendirSync", dir)).toBe(true);
    expect(touched("readdir", dir)).toBe(true);
    expect(touched("promises.readdir", dir)).toBe(true);
    // Both the namespace import and the default import are wrapped.
    expect(
      recorder.all().filter((a) => a.fn === "readFileSync" && a.path === file).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("records writes and both paths of a rename or a copy, never any file content", () => {
    const other = join(dir, "other.txt");
    writeFileSync(other, "secret-looking-content-for-the-recorder");
    fsNamespace.appendFileSync(other, "more");
    mkdirSync(join(dir, "sub"));
    fsNamespace.renameSync(other, join(dir, "renamed.txt"));
    fsNamespace.copyFileSync(join(dir, "renamed.txt"), join(dir, "copy.txt"));
    utimesSync(join(dir, "copy.txt"), 1, 1);
    fsNamespace.unlinkSync(join(dir, "copy.txt"));
    fsNamespace.rmSync(join(dir, "sub"), { recursive: true });
    expect(touched("writeFileSync", other)).toBe(true);
    expect(touched("appendFileSync", other)).toBe(true);
    expect(touched("renameSync", other)).toBe(true);
    expect(touched("renameSync", join(dir, "renamed.txt"))).toBe(true);
    expect(touched("copyFileSync", join(dir, "copy.txt"))).toBe(true);
    expect(touched("utimesSync", join(dir, "copy.txt"))).toBe(true);
    expect(touched("unlinkSync", join(dir, "copy.txt"))).toBe(true);
    expect(touched("rmSync", join(dir, "sub"))).toBe(true);
    expect(JSON.stringify(recorder.all())).not.toContain("secret-looking-content");
  });

  it("records the real path of a symlinked access, so a link to a decoy is seen as the decoy", () => {
    const link = join(dir, "link.txt");
    fsNamespace.symlinkSync(file, link);
    readFileSync(link);
    expect(filterAccessesTo([...recorder.all()], file).some((a) => a.fn === "readFileSync")).toBe(
      true,
    );
  });

  it("wraps every path-taking export of node:fs and node:fs/promises (a new function cannot slip past)", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const actualPromises =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    for (const name of Object.keys(actualFs)) {
      if (typeof (actualFs as Record<string, unknown>)[name] !== "function") continue;
      expect(
        WRAPPED_FS_FUNCTIONS.includes(name) || FS_EXEMPT.includes(name),
        `node:fs.${name} is neither wrapped nor exempt`,
      ).toBe(true);
      if (WRAPPED_FS_FUNCTIONS.includes(name)) {
        expect((fsNamespace as Record<string, unknown>)[name], name).not.toBe(
          (actualFs as Record<string, unknown>)[name],
        );
      }
    }
    for (const name of Object.keys(actualPromises)) {
      if (typeof (actualPromises as Record<string, unknown>)[name] !== "function") continue;
      expect(
        WRAPPED_FS_FUNCTIONS.includes(name) || FS_PROMISES_EXEMPT.includes(name),
        `node:fs/promises.${name} is neither wrapped nor exempt`,
      ).toBe(true);
      if (WRAPPED_FS_FUNCTIONS.includes(name)) {
        expect((fsPromises as Record<string, unknown>)[name], name).not.toBe(
          (actualPromises as Record<string, unknown>)[name],
        );
      }
    }
  });

  it("can be paused for test infrastructure and records again afterwards", () => {
    quiet(() => readFileSync(file));
    expect(touched("readFileSync")).toBe(false);
    readFileSync(file);
    expect(touched("readFileSync")).toBe(true);
  });
});

// --- the canary's own text is clean ---------------------------------------------------------------

describe("Test 6: no secret-shaped or email-shaped literal, and the privacy and secret scans pass", () => {
  const FILES = [
    "packages/service/src/codex/credential-canary.int.test.ts",
    "packages/service/src/test-support/fs-recorder.ts",
    "packages/service/src/test-support/fake-codex.ts",
  ];

  it("has no literal credential or config file name, home path, email or long mixed token in its text", () => {
    for (const relative of FILES) {
      const text = quiet(() => readFileSync(join(REPO_ROOT, relative), "utf8"));
      expect(text.includes(part("auth", ".", "json")), relative).toBe(false);
      expect(text.includes(part("config", ".", "toml")), relative).toBe(false);
      expect(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(text), `${relative} email`).toBe(
        false,
      );
      expect(/\/Users\/(?!USERNAME)[A-Za-z]/.test(text), `${relative} home path`).toBe(false);
      for (const match of text.matchAll(/["'`]([A-Za-z0-9_-]{24,})["'`]/g)) {
        const literal = match[1] ?? "";
        expect(
          /[a-z]/.test(literal) && /[0-9]/.test(literal),
          `${relative} secret-shaped literal ${literal.slice(0, 6)}`,
        ).toBe(false);
      }
    }
  });

  it(
    "passes the repository privacy scan and the secret scanner configuration",
    () => {
      const privacy = spawnSync("sh", ["scripts/check-privacy.sh"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      expect(privacy.status, privacy.stdout).toBe(0);
      const which = spawnSync("which", ["gitleaks"], { encoding: "utf8" });
      if (which.status !== 0) return; // CI runs the scanner as its own job over the full history
      const scan = spawnSync(
        "gitleaks",
        [
          "dir",
          "--no-banner",
          "--redact",
          "--config",
          join(REPO_ROOT, ".gitleaks.toml"),
          ...FILES.map((relative) => join(REPO_ROOT, relative)),
        ],
        { encoding: "utf8" },
      );
      expect(scan.status, scan.stdout + scan.stderr).toBe(0);
      // The repository scan reads every tracked file: slow on a loaded machine, so the ceiling is generous.
    },
    PRIVACY_SCAN_TIMEOUT_MS,
  );
});
