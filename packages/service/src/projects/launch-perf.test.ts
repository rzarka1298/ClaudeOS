import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_PROJECTS_SNAPSHOT,
  LAUNCH_PATH,
  LaunchResultSchema,
  type ProjectId,
} from "@ccc/domain";
import {
  applyMigrations,
  insertProject,
  type OperationalStore,
  openStore,
} from "@ccc/operational-store";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeSpawner, type FakeSpawner } from "../test-support/fake-spawner.js";

/**
 * PERF-05's service half as a timed contract (D-40, D-41): real timers, the
 * real authenticated socket, the production LAUNCH_CAP_MS, and a fake
 * spawner standing in for LaunchServices. Every bound below is measured
 * from the request write to the parsed response, not inferred from the
 * final value. The real-Mac timing of real launches is the phase UAT's job.
 */

// `../routes.js` imports the redacting singleton logger, which resolves its
// log file from `CCC_RUNTIME_DIR` at import time: point it at a throwaway
// directory BEFORE the dynamic imports.
const runtimeDir = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-launch-perf-rt-")));
process.env.CCC_RUNTIME_DIR = runtimeDir;

const { mintToken } = await import("../auth/token.js");
const { createEventBus } = await import("../events/event-bus.js");
const { createRequestListener } = await import("../routes.js");
const { startSocketServer } = await import("../socket-server.js");
const { createStoreProjectLookup } = await import("./project-lookup.js");
const { createLaunchService, LAUNCH_CAP_MS } = await import("./launch-service.js");

afterAll(() => {
  delete process.env.CCC_RUNTIME_DIR;
  rmSync(runtimeDir, { recursive: true, force: true });
});

const TEST_BASE = join(homedir(), ".ccc-test");
/** PERF-05: a launch acknowledges within this. */
const ACK_BUDGET_MS = 500;
/** PERF-05: a failed launch reports its error within this. */
const FAILURE_BUDGET_MS = 5000;

let dir: string;
let socketPath: string;
let store: OperationalStore;
let server: Server;
let token: string;
let projectId: ProjectId;
let spawner: FakeSpawner;

beforeEach(async () => {
  mkdirSync(TEST_BASE, { recursive: true });
  dir = realpathSync.native(mkdtempSync(join(TEST_BASE, "prf-")));
  socketPath = join(dir, "t.sock");
  const projectDir = join(dir, "example-project");
  mkdirSync(projectDir);
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
  projectId = insertProject(store.db, { path: projectDir, displayName: "Example" }).record
    .projectId;
  spawner = createFakeSpawner();
  const secret = randomBytes(32);
  token = mintToken(secret, { nowMs: Date.now() });
  const launch = createLaunchService({
    store,
    spawner,
    lookup: createStoreProjectLookup(store),
    collector: { refresh() {}, onRegistryChanged() {}, gitState: () => null },
    logger: { info() {}, warn() {} },
  });
  server = await startSocketServer({
    socketPath,
    requestListener: createRequestListener({
      store,
      getSecret: () => secret,
      eventBus: createEventBus(),
      projects: {
        snapshot: () => EMPTY_PROJECTS_SNAPSHOT,
        onRegistryChanged() {},
        refresh() {},
        homeDir: homedir(),
        runtimeDir,
      },
      launch,
    }),
  });
});

afterEach(() => {
  server.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Rejects if the promise has not settled within `ms`: "reported" versus "hung". */
function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, fail) =>
      setTimeout(() => fail(new Error(`promise never settled within ${ms}ms`)), ms),
    ),
  ]);
}

interface TimedLaunch {
  status: number;
  body: unknown;
  elapsedMs: number;
}

/** POSTs a finder launch and measures request write to parsed response. */
function timedLaunch(): Promise<TimedLaunch> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ projectId, action: "finder" });
    const started = performance.now();
    const req = http.request(
      {
        socketPath,
        path: LAUNCH_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve({ status: res.statusCode ?? 0, body, elapsedMs: performance.now() - started });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("PERF-05 launch contract over the real socket (D-40, D-41)", () => {
  it("a fast spawner acknowledges { ok: true } in under 500 ms", async () => {
    const reply = await settlesWithin(timedLaunch(), FAILURE_BUDGET_MS);
    expect(reply.status).toBe(200);
    expect(LaunchResultSchema.parse(reply.body)).toEqual({ ok: true });
    expect(reply.elapsedMs).toBeLessThan(ACK_BUDGET_MS);
  });

  it("a hung spawner reports timeout in under 5 s, after the service's own cap fired and aborted the child", async () => {
    spawner.mode = { kind: "hang" };
    const reply = await settlesWithin(timedLaunch(), FAILURE_BUDGET_MS);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: false, error: "timeout" });
    expect(reply.elapsedMs).toBeLessThan(FAILURE_BUDGET_MS);
    expect(reply.elapsedMs).toBeGreaterThanOrEqual(LAUNCH_CAP_MS - 50);
    expect(spawner.abortsObserved).toBe(1);
  });

  it("a spawner failing with an unknown bundle reports app-not-found in under 500 ms", async () => {
    spawner.mode = { kind: "fail", outcome: { exitCode: 1, stderrClass: "bundle-not-found" } };
    const reply = await settlesWithin(timedLaunch(), FAILURE_BUDGET_MS);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: false, error: "app-not-found" });
    expect(reply.elapsedMs).toBeLessThan(ACK_BUDGET_MS);
  });

  it("five concurrent fast launches each finish in under 500 ms", async () => {
    const replies = await settlesWithin(
      Promise.all(Array.from({ length: 5 }, () => timedLaunch())),
      FAILURE_BUDGET_MS,
    );
    expect(replies).toHaveLength(5);
    for (const reply of replies) {
      expect(reply.body).toEqual({ ok: true });
      expect(reply.elapsedMs).toBeLessThan(ACK_BUDGET_MS);
    }
    expect(spawner.calls).toHaveLength(5);
  });
});
