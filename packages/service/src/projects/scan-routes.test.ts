import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { join } from "node:path";
import {
  type ProjectId,
  type ProjectsSnapshot,
  RegisterProjectResponseSchema,
  SCAN_ROOTS_ADD_PATH,
  SCAN_ROOTS_LIST_PATH,
  SCAN_ROOTS_REMOVE_PATH,
  SCAN_ROOTS_RESCAN_PATH,
  ScanStateResponseSchema,
  SNAPSHOT_PATH,
  SnapshotResponseSchema,
  SUGGESTION_DISMISS_PATH,
  SUGGESTION_REGISTER_PATH,
} from "@ccc/domain";
import {
  applyMigrations,
  listLauncherConfigs,
  listProjects,
  listScanRoots,
  type OperationalStore,
  openStore,
} from "@ccc/operational-store";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { VAULT_ROOT_META_KEY } from "./approved-roots.js";

/**
 * The scan routes over the real socket (plan 04-13 Task 1, PROJ-02, PROJ-03,
 * D-07): nominate a parent folder, see its Git folders as suggestions, and
 * register one into a real project.
 *
 * Nothing here touches the real home folder or the real runtime directory:
 * the tree, the socket, the store and the "home" the service abbreviates
 * against all live under one short `/tmp` mkdtemp (the socket path must stay
 * under the sun_path cap, ADR-0001), and `CCC_RUNTIME_DIR` points the
 * redacting logger at a throwaway directory before any service module loads.
 */

const runtimeDir = realpathSync.native(mkdtempSync("/tmp/ccc-scan-rt-"));
process.env.CCC_RUNTIME_DIR = runtimeDir;

const { mintToken } = await import("../auth/token.js");
const { createEventBus } = await import("../events/event-bus.js");
const { createRequestListener } = await import("../routes.js");
const { startSocketServer } = await import("../socket-server.js");
const { clearApprovedRoots } = await import("../path-allowlist.js");
const { buildProjectView, launchersSummary } = await import("./project-views.js");
const { createScanService } = await import("./scan.js");
type ProjectServices = import("./project-routes.js").ProjectServices;

afterAll(() => {
  delete process.env.CCC_RUNTIME_DIR;
  rmSync(runtimeDir, { recursive: true, force: true });
});

interface SocketReply<T> {
  status: number;
  body: T;
  raw: string;
}

function request<T>(
  socketPath: string,
  opts: { method: string; path: string; body?: unknown; token?: string },
): Promise<SocketReply<T>> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? "" : JSON.stringify(opts.body);
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

let base: string;
let fakeHome: string;
let scanRoot: string;
let socketPath: string;
let store: OperationalStore;
let server: Server;
let token: string;
let registryChanges: number;
let refreshCalls: Array<ProjectId | undefined>;

function storeBackedProjects(): ProjectServices {
  return {
    snapshot(): ProjectsSnapshot {
      return {
        projects: listProjects(store.db).map((r) =>
          buildProjectView(r, { kind: "pending" }, null, false, fakeHome),
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
    homeDir: fakeHome,
    runtimeDir,
  };
}

beforeEach(async () => {
  clearApprovedRoots();
  registryChanges = 0;
  refreshCalls = [];
  base = realpathSync.native(mkdtempSync("/tmp/ccc-scan-"));
  fakeHome = join(base, "home");
  scanRoot = join(fakeHome, "code");
  mkdirSync(join(scanRoot, "alpha", ".git"), { recursive: true });
  mkdirSync(join(scanRoot, "beta"), { recursive: true });
  socketPath = join(base, "t.sock");
  store = openStore(join(base, "operational.db"));
  applyMigrations(store.db);
  const secret = randomBytes(32);
  token = mintToken(secret, { nowMs: Date.now() });
  const projects = storeBackedProjects();
  server = await startSocketServer({
    socketPath,
    requestListener: createRequestListener({
      store,
      getSecret: () => secret,
      eventBus: createEventBus(),
      projects,
      scan: createScanService({
        store,
        homeDir: fakeHome,
        readPolicy: () => {
          const vaultRoot = store.readServiceMeta(VAULT_ROOT_META_KEY);
          return {
            homeDir: fakeHome,
            runtimeDir,
            vaultRoot: vaultRoot !== null && vaultRoot.length > 0 ? vaultRoot : null,
          };
        },
        projects,
      }),
    }),
  });
});

afterEach(() => {
  server.close();
  store.close();
  clearApprovedRoots();
  rmSync(base, { recursive: true, force: true });
});

function post(path: string, body: unknown, withToken = true) {
  return request<unknown>(socketPath, {
    method: "POST",
    path,
    body,
    ...(withToken ? { token } : {}),
  });
}

describe("nominate a scan folder, see a suggestion, register it (tracer, PROJ-02, PROJ-03)", () => {
  it("adding a scan folder scans it once and suggests only its Git folder, home-abbreviated", async () => {
    const res = await post(SCAN_ROOTS_ADD_PATH, { path: scanRoot });
    expect(res.status).toBe(200);
    const state = ScanStateResponseSchema.parse(res.body);
    expect(state.scanRoots).toHaveLength(1);
    const [root] = state.scanRoots;
    expect(root?.depth).toBe(1);
    expect(root?.lastScannedAt).not.toBeNull();
    expect(root?.displayPath).toBe("~/code");
    expect(state.suggestions).toHaveLength(1);
    const [suggestion] = state.suggestions;
    expect(suggestion?.folderName).toBe("alpha");
    expect(suggestion?.displayPath).toBe("~/code/alpha");
    expect(suggestion?.scanRootId).toBe(root?.scanRootId);
    // The non-Git sibling never becomes a suggestion.
    expect(res.raw).not.toContain("beta");
    // No absolute path of any kind reaches the plugin (D-43).
    expect(res.raw).not.toContain(base);
    expect(listScanRoots(store.db)).toHaveLength(1);
  });

  it("a suggestion becomes a project only after the register request, then leaves the suggestions", async () => {
    const added = ScanStateResponseSchema.parse(
      (await post(SCAN_ROOTS_ADD_PATH, { path: scanRoot })).body,
    );
    // Scanning never registers anything on its own (PROJ-03).
    expect(listProjects(store.db)).toHaveLength(0);
    const suggestionId = added.suggestions[0]?.suggestionId;
    expect(suggestionId).toBeDefined();

    const reg = await post(SUGGESTION_REGISTER_PATH, { suggestionId });
    expect(reg.status).toBe(200);
    const body = RegisterProjectResponseSchema.parse(reg.body);
    expect(body.kind).toBe("registered");
    if (body.kind !== "registered") throw new Error("unreachable");

    const rows = listProjects(store.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe(join(scanRoot, "alpha"));
    expect(registryChanges).toBe(1);
    expect(refreshCalls).toEqual([body.projectId]);

    const snap = await request<unknown>(socketPath, { method: "GET", path: SNAPSHOT_PATH, token });
    const views = SnapshotResponseSchema.parse(snap.body).state.projects.projects;
    expect(views.map((v) => v.displayName)).toEqual(["alpha"]);

    const listed = ScanStateResponseSchema.parse((await post(SCAN_ROOTS_LIST_PATH, {})).body);
    expect(listed.suggestions).toEqual([]);
    expect(listed.scanRoots).toHaveLength(1);
  });

  it("refuses a forbidden scan folder with one constant 422 body and stores nothing", async () => {
    for (const candidate of ["/etc", "/", fakeHome]) {
      const res = await post(SCAN_ROOTS_ADD_PATH, { path: candidate });
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: "folder cannot be scanned" });
    }
    expect(listScanRoots(store.db)).toHaveLength(0);
  });

  it("after the add, every request addresses the scan folder and suggestion by ID only", async () => {
    await post(SCAN_ROOTS_ADD_PATH, { path: scanRoot });
    expect((await post(SCAN_ROOTS_RESCAN_PATH, { path: scanRoot })).status).toBe(400);
    expect((await post(SCAN_ROOTS_REMOVE_PATH, { path: scanRoot })).status).toBe(400);
    expect((await post(SUGGESTION_REGISTER_PATH, { path: join(scanRoot, "alpha") })).status).toBe(
      400,
    );
    expect(listProjects(store.db)).toHaveLength(0);
  });

  it("answers a constant 404 for an unknown scan folder or suggestion", async () => {
    const unknownRoot = "000000000aaaaaaaaaaaaaaaa";
    const rescan = await post(SCAN_ROOTS_RESCAN_PATH, { scanRootId: unknownRoot });
    expect(rescan.status).toBe(404);
    expect(rescan.body).toEqual({ error: "no such scan folder" });
    const remove = await post(SCAN_ROOTS_REMOVE_PATH, { scanRootId: unknownRoot });
    expect(remove.status).toBe(404);
    const reg = await post(SUGGESTION_REGISTER_PATH, { suggestionId: "nosuch" });
    expect(reg.status).toBe(404);
    expect(reg.body).toEqual({ error: "no such suggestion" });
    const dismiss = await post(SUGGESTION_DISMISS_PATH, { suggestionId: "nosuch" });
    expect(dismiss.status).toBe(404);
  });

  it("every scan route requires the bearer token", async () => {
    for (const path of [
      SCAN_ROOTS_ADD_PATH,
      SCAN_ROOTS_REMOVE_PATH,
      SCAN_ROOTS_RESCAN_PATH,
      SCAN_ROOTS_LIST_PATH,
      SUGGESTION_REGISTER_PATH,
      SUGGESTION_DISMISS_PATH,
    ]) {
      const res = await post(path, {}, false);
      expect(res.status).toBe(401);
    }
    expect(listScanRoots(store.db)).toHaveLength(0);
  });
});
