import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCH_PAIR_PATH,
  LAUNCH_PATH,
  type LaunchPairResponse,
  LaunchPairResponseSchema,
  LaunchResultSchema,
  PROJECT_REGISTER_PATH,
  type ProjectId,
  type ProjectsSnapshot,
  RegisterProjectResponseSchema,
} from "@ccc/domain";
import {
  applyMigrations,
  getProject,
  listLauncherConfigs,
  listProjects,
  type OperationalStore,
  openStore,
} from "@ccc/operational-store";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSpawner, type FakeSpawner } from "../test-support/fake-spawner.js";
import type { LaunchService } from "./launch-service.js";

// `../routes.js` imports the redacting singleton logger, which resolves its
// log file from `CCC_RUNTIME_DIR` at import time: point it at a throwaway
// directory BEFORE the dynamic imports, so this test never writes into the
// real runtime directory.
const runtimeDir = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-launch-routes-rt-")));
process.env.CCC_RUNTIME_DIR = runtimeDir;

const { mintToken } = await import("../auth/token.js");
const { createEventBus } = await import("../events/event-bus.js");
const { clearApprovedRoots } = await import("../path-allowlist.js");
const { createRequestListener } = await import("../routes.js");
const { startSocketServer } = await import("../socket-server.js");
const { buildProjectView, launchersSummary } = await import("./project-views.js");
const { createStoreProjectLookup } = await import("./project-lookup.js");
const { createLaunchService } = await import("./launch-service.js");
type ProjectServices = import("./project-routes.js").ProjectServices;

afterAll(() => {
  delete process.env.CCC_RUNTIME_DIR;
  rmSync(runtimeDir, { recursive: true, force: true });
});

// Short socket base under the home directory (the sun_path cap, ADR-0001).
const TEST_BASE = join(homedir(), ".ccc-test");

interface SocketReply {
  status: number;
  body: unknown;
}

function post(
  socketPath: string,
  path: string,
  body: unknown,
  token: string | null,
): Promise<SocketReply> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : null });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

let dir: string;
let socketPath: string;
let store: OperationalStore;
let server: Server;
let token: string;
let projectDir: string;
let spawner: FakeSpawner;
let refreshCalls: ProjectId[];

function storeBackedProjects(db: OperationalStore): ProjectServices {
  return {
    snapshot(): ProjectsSnapshot {
      return {
        projects: listProjects(db.db).map((r) =>
          buildProjectView(r, { kind: "pending" }, null, false, homedir()),
        ),
        launchers: launchersSummary(listLauncherConfigs(db.db)),
      };
    },
    onRegistryChanged() {},
    refresh() {},
    homeDir: homedir(),
    runtimeDir,
  };
}

beforeEach(async () => {
  clearApprovedRoots();
  refreshCalls = [];
  mkdirSync(TEST_BASE, { recursive: true });
  dir = realpathSync.native(mkdtempSync(join(TEST_BASE, "lch-")));
  socketPath = join(dir, "t.sock");
  projectDir = join(dir, "example-project");
  mkdirSync(projectDir);
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
  spawner = createFakeSpawner();
  const secret = randomBytes(32);
  token = mintToken(secret, { nowMs: Date.now() });
  const launch = createLaunchService({
    store,
    spawner,
    lookup: createStoreProjectLookup(store),
    collector: {
      refresh(projectId) {
        refreshCalls.push(projectId);
      },
      onRegistryChanged() {},
      gitState: () => null,
    },
    logger: { info() {}, warn() {} },
  });
  server = await startSocketServer({
    socketPath,
    requestListener: createRequestListener({
      store,
      getSecret: () => secret,
      eventBus: createEventBus(),
      projects: storeBackedProjects(store),
      launch,
    }),
  });
});

afterEach(() => {
  server.close();
  store.close();
  clearApprovedRoots();
  rmSync(dir, { recursive: true, force: true });
});

async function registerProject(): Promise<ProjectId> {
  const reply = await post(socketPath, PROJECT_REGISTER_PATH, { path: projectDir }, token);
  const body = RegisterProjectResponseSchema.parse(reply.body);
  if (body.kind !== "registered") throw new Error(`registration answered ${body.kind}`);
  return body.projectId;
}

describe("reveal a registered project in Finder over the socket (tracer, PROJ-07)", () => {
  it("answers { ok: true }, spawns exactly /usr/bin/open -R <realpath> with no shell, and touches last_opened_at", async () => {
    const projectId = await registerProject();
    expect(getProject(store.db, projectId)?.lastOpenedAt).toBeNull();

    const reply = await post(socketPath, LAUNCH_PATH, { projectId, action: "finder" }, token);

    expect(reply.status).toBe(200);
    expect(LaunchResultSchema.parse(reply.body)).toEqual({ ok: true });
    expect(spawner.calls).toHaveLength(1);
    const [call] = spawner.calls;
    expect(call?.argv).toEqual(["/usr/bin/open", "-R", realpathSync.native(projectDir)]);
    expect(Object.keys(call?.opts ?? {})).not.toContain("shell");
    expect(getProject(store.db, projectId)?.lastOpenedAt).not.toBeNull();
    expect(refreshCalls).toEqual([projectId]);
  });

  it("refuses a body carrying a path with the constant 400 and spawns nothing (T-04-05)", async () => {
    const projectId = await registerProject();
    const reply = await post(
      socketPath,
      LAUNCH_PATH,
      { projectId, action: "finder", path: "/Applications" },
      token,
    );
    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ error: "invalid request body" });
    expect(spawner.calls).toHaveLength(0);
  });

  it("answers project-missing for an unknown ProjectId, as a typed 200 result", async () => {
    const reply = await post(
      socketPath,
      LAUNCH_PATH,
      { projectId: "0000000000123456789abcdef", action: "finder" },
      token,
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: false, error: "project-missing" });
    expect(spawner.calls).toHaveLength(0);
  });

  it("rejects an unauthenticated launch with the existing 401 and spawns nothing", async () => {
    const projectId = await registerProject();
    const reply = await post(socketPath, LAUNCH_PATH, { projectId, action: "finder" }, null);
    expect(reply.status).toBe(401);
    expect(spawner.calls).toHaveLength(0);
    expect(getProject(store.db, projectId)?.lastOpenedAt).toBeNull();
    expect(refreshCalls).toEqual([]);
  });

  it("rejects a launch carrying a forged bearer token with 401 and spawns nothing", async () => {
    const projectId = await registerProject();
    const forged = mintToken(randomBytes(32), { nowMs: Date.now() });
    const reply = await post(socketPath, LAUNCH_PATH, { projectId, action: "finder" }, forged);
    expect(reply.status).toBe(401);
    expect(spawner.calls).toHaveLength(0);
  });

  it("never carries a path in any launch response", async () => {
    const projectId = await registerProject();
    rmSync(projectDir, { recursive: true, force: true });
    const reply = await post(socketPath, LAUNCH_PATH, { projectId, action: "finder" }, token);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: false, error: "project-missing" });
    expect(JSON.stringify(reply.body)).not.toContain("/");
  });
});

// ---------------------------------------------------------------------------
// The pair route (plan 05.1-20, D-10, CODEX-02)

describe("POST /api/v1/projects/launch-pair", () => {
  const PAIR_ENVELOPE: LaunchPairResponse = {
    claude: { status: "opened" },
    codex: { status: "setup" },
  };
  let pairDir: string;
  let pairServer: Server | null;

  beforeEach(() => {
    pairDir = realpathSync.native(mkdtempSync(join(TEST_BASE, "pr-")));
    pairServer = null;
  });

  afterEach(() => {
    pairServer?.close();
    rmSync(pairDir, { recursive: true, force: true });
  });

  /** A second server over a stub launch member, so the route is judged on its own. */
  async function serveWith(
    launch: Partial<LaunchService> | undefined,
  ): Promise<{ socket: string; token: string }> {
    const secret = randomBytes(32);
    const socket = join(pairDir, "p.sock");
    pairServer = await startSocketServer({
      socketPath: socket,
      requestListener: createRequestListener({
        store,
        getSecret: () => secret,
        eventBus: createEventBus(),
        projects: storeBackedProjects(store),
        ...(launch === undefined ? {} : { launch: launch as LaunchService }),
      }),
    });
    return { socket, token: mintToken(secret, { nowMs: Date.now() }) };
  }

  const PROJECT = "0000000000123456789abcdef";

  it("answers 200 with the typed envelope for a well-formed request over the real service (no launchers saved)", async () => {
    const projectId = await registerProject();
    const reply = await post(socketPath, LAUNCH_PAIR_PATH, { projectId }, token);
    expect(reply.status).toBe(200);
    expect(LaunchPairResponseSchema.parse(reply.body)).toEqual({
      claude: { status: "error", error: "launcher-not-configured" },
      codex: { status: "setup" },
    });
    expect(spawner.calls).toHaveLength(0);
  });

  it("passes the project id and the choice to launchPair, once, and relays its envelope", async () => {
    const launchPair = vi.fn(() => Promise.resolve(PAIR_ENVELOPE));
    const { socket, token: t } = await serveWith({ launchPair });
    const reply = await post(
      socket,
      LAUNCH_PAIR_PATH,
      { projectId: PROJECT, choice: { kind: "plan" } },
      t,
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(PAIR_ENVELOPE);
    expect(launchPair).toHaveBeenCalledTimes(1);
    expect(launchPair).toHaveBeenCalledWith({ projectId: PROJECT, choice: { kind: "plan" } });
  });

  it("relays the guard's conflict answer as a 200", async () => {
    const conflict = { ok: false, conflict: { projectName: "Example", conflicts: [] } };
    const { socket, token: t } = await serveWith({
      launchPair: () => Promise.resolve(conflict as never),
    });
    const reply = await post(socket, LAUNCH_PAIR_PATH, { projectId: PROJECT }, t);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(conflict);
  });

  it.each(["path", "argv", "agent", "executable", "shell", "action"])(
    "refuses a body carrying the extra key %s with the constant 400 and calls nothing",
    async (key) => {
      const launchPair = vi.fn(() => Promise.resolve(PAIR_ENVELOPE));
      const { socket, token: t } = await serveWith({ launchPair });
      const reply = await post(
        socket,
        LAUNCH_PAIR_PATH,
        { projectId: PROJECT, [key]: key === "argv" ? ["/bin/sh"] : "/bin/sh" },
        t,
      );
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual({ error: "invalid request body" });
      expect(launchPair).not.toHaveBeenCalled();
    },
  );

  it("refuses a body without a project id and an unauthenticated request", async () => {
    const launchPair = vi.fn(() => Promise.resolve(PAIR_ENVELOPE));
    const { socket, token: t } = await serveWith({ launchPair });
    const missing = await post(socket, LAUNCH_PAIR_PATH, {}, t);
    expect(missing.status).toBe(400);
    const anonymous = await post(socket, LAUNCH_PAIR_PATH, { projectId: PROJECT }, null);
    expect(anonymous.status).toBe(401);
    expect(launchPair).not.toHaveBeenCalled();
  });

  it("answers the constant 500 body when no launch service is wired", async () => {
    const { socket, token: t } = await serveWith(undefined);
    const reply = await post(socket, LAUNCH_PAIR_PATH, { projectId: PROJECT }, t);
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({ error: "internal error" });
  });

  it("never leaks the message of a launchPair that throws", async () => {
    const { socket, token: t } = await serveWith({
      launchPair: () => Promise.reject(new Error("exploded at /Users/USERNAME/secret")),
    });
    const reply = await post(socket, LAUNCH_PAIR_PATH, { projectId: PROJECT }, t);
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({ error: "internal error" });
    expect(JSON.stringify(reply.body)).not.toContain("secret");
  });

  it("adds exactly one POST-only route and leaves the single launch route as it was", async () => {
    const { launchRoutes } = await import("./launch-routes.js");
    expect(Object.keys(launchRoutes).sort()).toEqual([LAUNCH_PATH, LAUNCH_PAIR_PATH].sort());
    expect(Object.keys(launchRoutes[LAUNCH_PAIR_PATH] ?? {})).toEqual(["POST"]);
    expect(Object.keys(launchRoutes[LAUNCH_PATH] ?? {})).toEqual(["POST"]);
  });
});
