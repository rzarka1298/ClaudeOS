import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import http, { type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  HANDSHAKE_PATH,
  PROJECT_GITHUB_LINK_PATH,
  PROJECT_PIN_PATH,
  PROJECT_REGISTER_PATH,
  PROJECT_REMOVE_PATH,
  PROJECT_RENAME_PATH,
  PROJECTS_REFRESH_PATH,
  type ProjectId,
  type ProjectsSnapshot,
  RegisterProjectResponseSchema,
  SNAPSHOT_PATH,
  SnapshotResponseSchema,
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

// `../routes.js` imports the service's redacting singleton logger, which
// resolves its log file from `CCC_RUNTIME_DIR` at import time. Point it at a
// throwaway directory BEFORE the dynamic imports below, so this test never
// writes into the real runtime directory.
const runtimeDir = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-project-routes-rt-")));
process.env.CCC_RUNTIME_DIR = runtimeDir;

const { mintToken } = await import("../auth/token.js");
const { createEventBus } = await import("../events/event-bus.js");
const { logger } = await import("../logging.js");
const { assertPathAllowed, clearApprovedRoots, PathNotAllowedError } = await import(
  "../path-allowlist.js"
);
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
function storeBackedProjects(store: OperationalStore, getHome: () => string): ProjectServices {
  return {
    snapshot(): ProjectsSnapshot {
      return {
        projects: listProjects(store.db).map((r) =>
          buildProjectView(r, { kind: "pending" }, null, false, getHome()),
        ),
        launchers: launchersSummary(listLauncherConfigs(store.db)),
      };
    },
    onRegistryChanged() {
      registryChanges += 1;
    },
    refresh(projectId) {
      refreshCalls.push(projectId);
    },
    get homeDir() {
      return getHome();
    },
    runtimeDir,
  };
}

let dir: string;
let socketPath: string;
let store: OperationalStore;
let server: Server;
let token: string;
let projectDir: string;
/** The home directory the project services report; a test may point it at a fake home. */
let servicesHome: string;
let registryChanges: number;
let refreshCalls: Array<ProjectId | undefined>;

beforeEach(async () => {
  clearApprovedRoots();
  servicesHome = homedir();
  registryChanges = 0;
  refreshCalls = [];
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
      projects: storeBackedProjects(store, () => servicesHome),
    }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
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

function post(path: string, body: unknown) {
  return request<unknown>(socketPath, { method: "POST", path, body, token });
}

async function registerId(path: string): Promise<ProjectId> {
  const res = RegisterProjectResponseSchema.parse((await register(path)).body);
  if (!("projectId" in res)) throw new Error("expected a projectId");
  return res.projectId;
}

async function snapshotViews() {
  const snap = await request<unknown>(socketPath, { method: "GET", path: SNAPSHOT_PATH, token });
  return SnapshotResponseSchema.parse(snap.body).state.projects.projects;
}

describe("registration policy at the route (D-04, PR-06)", () => {
  it("answers already-registered for the same folder through a symlink and in a different letter case", async () => {
    const id = await registerId(projectDir);
    const link = join(dir, "link-to-project");
    symlinkSync(projectDir, link);
    expect((await register(link)).body).toEqual({ kind: "already-registered", projectId: id });
    const upper = join(dir, "EXAMPLE-PROJECT");
    expect((await register(upper)).body).toEqual({ kind: "already-registered", projectId: id });
    expect(listProjects(store.db)).toHaveLength(1);
  });

  it("refuses every forbidden candidate with one byte-identical 422 body that contains no slash", async () => {
    const file = join(dir, "t.sock");
    const candidates = [
      "/etc",
      "/private/tmp",
      "/",
      homedir(),
      runtimeDir,
      join(dir, "does-not-exist"),
      file,
    ];
    const raws: string[] = [];
    for (const candidate of candidates) {
      const res = await register(candidate);
      expect(res.status).toBe(422);
      raws.push(res.raw);
    }
    expect(new Set(raws).size).toBe(1);
    expect(raws[0]).toBe(JSON.stringify({ error: "folder cannot be registered" }));
    expect(raws[0]).not.toContain("/");
    expect(listProjects(store.db)).toHaveLength(0);
  });

  it("asks for acknowledgement before registering a folder under Documents, and inserts nothing", async () => {
    servicesHome = join(dir, "home");
    const inDocuments = join(servicesHome, "Documents", "example-project");
    mkdirSync(inDocuments, { recursive: true });

    const asked = await register(inDocuments);
    expect(asked.status).toBe(200);
    expect(asked.body).toEqual({ kind: "protected-location", location: "documents" });
    expect(listProjects(store.db)).toHaveLength(0);

    const acknowledged = await register(inDocuments, { acknowledgeProtectedLocation: true });
    expect(acknowledged.status).toBe(200);
    expect(RegisterProjectResponseSchema.parse(acknowledged.body).kind).toBe("registered");
    expect(listProjects(store.db)).toHaveLength(1);
  });

  it("logs the refused candidate only in its local candidate field, and no path for an accepted registration (D-46)", async () => {
    const warn = vi.spyOn(logger, "warn");
    const info = vi.spyOn(logger, "info");
    const error = vi.spyOn(logger, "error");
    const secret = join(dir, "does-not-exist");

    await register(secret);
    const refusalFields = [...warn.mock.calls, ...info.mock.calls, ...error.mock.calls].flatMap(
      (call) => Object.entries((call[0] ?? {}) as Record<string, unknown>),
    );
    const leaking = refusalFields.filter(([, value]) => JSON.stringify(value)?.includes(dir));
    expect(leaking.map(([key]) => key)).toEqual(["candidate"]);

    warn.mockClear();
    info.mockClear();
    error.mockClear();
    await register(projectDir);
    const acceptedFields = [...warn.mock.calls, ...info.mock.calls, ...error.mock.calls].flatMap(
      (call) => Object.entries((call[0] ?? {}) as Record<string, unknown>),
    );
    expect(info.mock.calls.length).toBeGreaterThan(0);
    expect(acceptedFields.filter(([, value]) => JSON.stringify(value)?.includes(dir))).toEqual([]);
  });
});

describe("manage routes (D-08, PROJ-15)", () => {
  it("remove deletes the row only: the snapshot drops it, its files are refused again, the folder stays on disk", async () => {
    const id = await registerId(projectDir);
    const file = join(projectDir, "file.txt");
    expect(() => assertPathAllowed(file)).not.toThrow();
    const before = registryChanges;

    const res = await post(PROJECT_REMOVE_PATH, { projectId: id });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await snapshotViews()).toEqual([]);
    expect(() => assertPathAllowed(file)).toThrow(PathNotAllowedError);
    expect(existsSync(projectDir)).toBe(true);
    expect(registryChanges).toBeGreaterThan(before);
  });

  it("rename trims the display name and refuses 65 characters", async () => {
    const id = await registerId(projectDir);
    const ok = await post(PROJECT_RENAME_PATH, { projectId: id, displayName: "  demo-api  " });
    expect(ok.status).toBe(200);
    expect(getProject(store.db, id)?.displayName).toBe("demo-api");

    const tooLong = await post(PROJECT_RENAME_PATH, { projectId: id, displayName: "x".repeat(65) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body).toEqual({ error: "invalid request body" });
    expect(getProject(store.db, id)?.displayName).toBe("demo-api");
  });

  it("pin true moves the project first in the snapshot", async () => {
    const other = join(dir, "aaa-first-by-name");
    mkdirSync(other);
    await registerId(other);
    const id = await registerId(projectDir);
    expect((await snapshotViews()).map((v) => v.projectId)[0]).not.toBe(id);

    const res = await post(PROJECT_PIN_PATH, { projectId: id, pinned: true });

    expect(res.status).toBe(200);
    const views = await snapshotViews();
    expect(views[0]?.projectId).toBe(id);
    expect(views[0]?.pinned).toBe(true);
  });

  it("stores an https GitHub link and refuses an http one", async () => {
    const id = await registerId(projectDir);
    const ok = await post(PROJECT_GITHUB_LINK_PATH, {
      projectId: id,
      url: "https://github.com/owner/repo",
    });
    expect(ok.status).toBe(200);
    expect(getProject(store.db, id)?.githubUrlOverride).toBe("https://github.com/owner/repo");
    expect((await snapshotViews())[0]?.github).toEqual({
      kind: "github",
      label: "github.com/owner/repo",
      source: "override",
    });

    const bad = await post(PROJECT_GITHUB_LINK_PATH, {
      projectId: id,
      url: "http://github.com/owner/repo",
    });
    expect(bad.status).toBe(400);
    expect(getProject(store.db, id)?.githubUrlOverride).toBe("https://github.com/owner/repo");

    const cleared = await post(PROJECT_GITHUB_LINK_PATH, { projectId: id, url: null });
    expect(cleared.status).toBe(200);
    expect(getProject(store.db, id)?.githubUrlOverride).toBeNull();
  });

  it("answers an unknown projectId with a constant 404 on every manage route", async () => {
    const unknown = "zzzzzzzzz0123456789abcdef";
    const replies = await Promise.all([
      post(PROJECT_REMOVE_PATH, { projectId: unknown }),
      post(PROJECT_RENAME_PATH, { projectId: unknown, displayName: "demo-api" }),
      post(PROJECT_PIN_PATH, { projectId: unknown, pinned: true }),
      post(PROJECT_GITHUB_LINK_PATH, { projectId: unknown, url: null }),
    ]);
    for (const reply of replies) {
      expect(reply.status).toBe(404);
      expect(reply.body).toEqual({ error: "no such project" });
    }
  });

  it("requires authentication on every manage route", async () => {
    for (const path of [
      PROJECT_REMOVE_PATH,
      PROJECT_RENAME_PATH,
      PROJECT_PIN_PATH,
      PROJECT_GITHUB_LINK_PATH,
    ]) {
      const res = await request<unknown>(socketPath, { method: "POST", path, body: {} });
      expect(res.status).toBe(401);
    }
  });
});

describe("refresh (D-42)", () => {
  it("a new registration asks for that project's git state without waiting for it", async () => {
    const id = await registerId(projectDir);
    expect(refreshCalls).toEqual([id]);
    await register(projectDir);
    expect(refreshCalls).toEqual([id]);
  });

  it("POST refresh asks for every project, or one, and answers ok immediately", async () => {
    const id = await registerId(projectDir);
    refreshCalls = [];
    const all = await post(PROJECTS_REFRESH_PATH, {});
    expect(all.status).toBe(200);
    expect(all.body).toEqual({ ok: true });
    const one = await post(PROJECTS_REFRESH_PATH, { projectId: id });
    expect(one.status).toBe(200);
    expect(refreshCalls).toEqual([undefined, id]);
  });

  it("answers an unknown projectId with the constant 404 and requires authentication", async () => {
    const unknown = await post(PROJECTS_REFRESH_PATH, { projectId: "zzzzzzzzz0123456789abcdef" });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: "no such project" });
    const anonymous = await request<unknown>(socketPath, {
      method: "POST",
      path: PROJECTS_REFRESH_PATH,
      body: {},
    });
    expect(anonymous.status).toBe(401);
    expect(refreshCalls).toEqual([]);
  });
});
