import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  HANDSHAKE_PATH,
  PROJECT_REGISTER_PATH,
  type ProjectsSnapshot,
  RegisterProjectResponseSchema,
  SNAPSHOT_PATH,
  SnapshotResponseSchema,
} from "@ccc/domain";
import {
  applyMigrations,
  listLauncherConfigs,
  listProjects,
  type OperationalStore,
  openStore,
} from "@ccc/operational-store";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

// `../routes.js` imports the service's redacting singleton logger, which
// resolves its log file from `CCC_RUNTIME_DIR` at import time. Point it at a
// throwaway directory BEFORE the dynamic imports below, so this test never
// writes into the real runtime directory.
const runtimeDir = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-project-routes-rt-")));
process.env.CCC_RUNTIME_DIR = runtimeDir;

const { mintToken } = await import("../auth/token.js");
const { createEventBus } = await import("../events/event-bus.js");
const { clearApprovedRoots } = await import("../path-allowlist.js");
const { createRequestListener } = await import("../routes.js");
const { startSocketServer } = await import("../socket-server.js");
const { buildProjectView, launchersSummary } = await import("./project-views.js");
type ProjectServices = import("./project-routes.js").ProjectServices;

afterAll(() => {
  delete process.env.CCC_RUNTIME_DIR;
  rmSync(runtimeDir, { recursive: true, force: true });
});

// The same short base every socket test uses: macOS's per-user $TMPDIR is
// long enough to break the sun_path cap (ADR-0001). It also sits under the
// home directory, which is what lets the displayPath assertion below mean
// something.
const TEST_BASE = join(homedir(), ".ccc-test");

interface SocketReply<T> {
  status: number;
  body: T;
  raw: string;
}

function request<T>(
  socketPath: string,
  opts: { method: string; path: string; body?: unknown; rawBody?: string; token?: string },
): Promise<SocketReply<T>> {
  return new Promise((resolve, reject) => {
    const payload = opts.rawBody ?? (opts.body === undefined ? "" : JSON.stringify(opts.body));
    const req = http.request(
      {
        socketPath,
        path: opts.path,
        method: opts.method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            body: (raw.length > 0 ? JSON.parse(raw) : undefined) as T,
            raw,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/**
 * Project services backed directly by the store: every project reads
 * `pending` git state (nothing has been read yet). Built from the production
 * view functions so the snapshot shape is the real one.
 */
function storeBackedProjects(store: OperationalStore, home: string): ProjectServices {
  return {
    snapshot(): ProjectsSnapshot {
      return {
        projects: listProjects(store.db).map((r) =>
          buildProjectView(r, { kind: "pending" }, null, false, home),
        ),
        launchers: launchersSummary(listLauncherConfigs(store.db)),
      };
    },
    onRegistryChanged() {},
    refresh() {},
    homeDir: home,
    runtimeDir,
  };
}

let dir: string;
let socketPath: string;
let store: OperationalStore;
let server: Server;
let token: string;
let projectDir: string;

beforeEach(async () => {
  clearApprovedRoots();
  mkdirSync(TEST_BASE, { recursive: true });
  dir = realpathSync.native(mkdtempSync(join(TEST_BASE, "prj-")));
  socketPath = join(dir, "t.sock");
  projectDir = join(dir, "example-project");
  mkdirSync(projectDir);
  store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
  const secret = randomBytes(32);
  token = mintToken(secret, { nowMs: Date.now() });
  server = await startSocketServer({
    socketPath,
    requestListener: createRequestListener({
      store,
      getSecret: () => secret,
      eventBus: createEventBus(),
      projects: storeBackedProjects(store, homedir()),
    }),
  });
});

afterEach(() => {
  server.close();
  store.close();
  clearApprovedRoots();
  rmSync(dir, { recursive: true, force: true });
});

function register(path: string, extra: Record<string, unknown> = {}) {
  return request<unknown>(socketPath, {
    method: "POST",
    path: PROJECT_REGISTER_PATH,
    body: { path, ...extra },
    token,
  });
}

describe("register a folder over the real socket (tracer, PROJ-01)", () => {
  it("registers, answers already-registered the second time, and lists the project in the snapshot", async () => {
    const first = await register(projectDir);
    expect(first.status).toBe(200);
    const firstBody = RegisterProjectResponseSchema.parse(first.body);
    expect(firstBody.kind).toBe("registered");
    if (firstBody.kind !== "registered") throw new Error("unreachable");

    const second = await register(projectDir);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ kind: "already-registered", projectId: firstBody.projectId });

    const snap = await request<unknown>(socketPath, {
      method: "GET",
      path: SNAPSHOT_PATH,
      token,
    });
    expect(snap.status).toBe(200);
    const parsed = SnapshotResponseSchema.parse(snap.body);
    const views = parsed.state.projects.projects;
    expect(views).toHaveLength(1);
    const [view] = views;
    expect(view?.projectId).toBe(firstBody.projectId);
    expect(view?.git.kind).toBe("pending");
    expect(view?.pinned).toBe(false);
    expect(view?.displayName).toBe("example-project");
    // D-43: the displayPath is home-abbreviated, and no absolute home path
    // appears anywhere in the snapshot body.
    expect(view?.displayPath.startsWith(homedir())).toBe(false);
    expect(view?.displayPath.startsWith("~/")).toBe(true);
    expect(snap.raw).not.toContain(homedir());
  });

  it("stores the realpath form and exactly one row", async () => {
    await register(projectDir);
    await register(`${projectDir}/`);
    const rows = listProjects(store.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe(realpathSync.native(projectDir));
  });

  it("two concurrent registrations of the same folder yield one row and one ProjectId", async () => {
    const [a, b] = await Promise.all([register(projectDir), register(projectDir)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ids = [a.body, b.body]
      .map((body) => RegisterProjectResponseSchema.parse(body))
      .map((r) => ("projectId" in r ? r.projectId : null));
    expect(ids[0]).not.toBeNull();
    expect(ids[0]).toBe(ids[1]);
    expect(listProjects(store.db)).toHaveLength(1);
  });

  it("rejects an unauthenticated request with the existing 401 and registers nothing", async () => {
    const res = await request<unknown>(socketPath, {
      method: "POST",
      path: PROJECT_REGISTER_PATH,
      body: { path: projectDir },
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "authentication required" });
    expect(listProjects(store.db)).toHaveLength(0);
  });

  it("rejects a relative path with the constant invalid-body 400", async () => {
    const res = await register("relative");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid request body" });
    expect(listProjects(store.db)).toHaveLength(0);
  });

  it("the handshake route stays unauthenticated after the route-kit extraction", async () => {
    const res = await request<{ token: string }>(socketPath, {
      method: "POST",
      path: HANDSHAKE_PATH,
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
  });
});
