import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { join } from "node:path";
import {
  type ProjectsSnapshot,
  SCAN_ROOTS_ADD_PATH,
  SCAN_ROOTS_LIST_PATH,
  SCAN_ROOTS_RESCAN_PATH,
  ScanStateResponseSchema,
} from "@ccc/domain";
import {
  applyMigrations,
  listLauncherConfigs,
  listProjects,
  type OperationalStore,
  openStore,
} from "@ccc/operational-store";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { VAULT_ROOT_META_KEY } from "./approved-roots.js";

/**
 * Codex review 3, finding 2: a scan response must fit the plugin client's
 * 65,536-byte response cap (`SocketApiClient`), however many Git folders a
 * scan finds (the walker stops at 5,000 entries). Over the real socket.
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

/** What `SocketApiClient` accepts at most (`MAX_RESPONSE_BYTES`, 64 KiB). */
const CLIENT_RESPONSE_LIMIT = 64 * 1024;
/** Well past the 74.5 KB the review measured at 500, and under the walker's cap. */
const REPO_COUNT = 600;

function repoName(i: number): string {
  return `repository-number-${String(i).padStart(4, "0")}`;
}

let base: string;
let fakeHome: string;
let scanRoot: string;
let socketPath: string;
let store: OperationalStore;
let server: Server;
let token: string;

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
    onRegistryChanged() {},
    refresh() {},
    homeDir: fakeHome,
    runtimeDir,
  };
}

beforeEach(async () => {
  clearApprovedRoots();
  base = realpathSync.native(mkdtempSync("/tmp/ccc-scan-"));
  fakeHome = join(base, "home");
  scanRoot = join(fakeHome, "code");
  for (let i = 0; i < REPO_COUNT; i++) {
    mkdirSync(join(scanRoot, repoName(i), ".git"), { recursive: true });
  }
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

describe("scan responses fit the client's response cap (codex review 3, finding 2)", () => {
  it("add, rescan and list each answer within 64 KiB for a folder of 600 repositories", async () => {
    const added = await post(SCAN_ROOTS_ADD_PATH, { path: scanRoot });
    expect(added.status).toBe(200);
    expect(Buffer.byteLength(added.raw)).toBeLessThanOrEqual(CLIENT_RESPONSE_LIMIT);
    const state = ScanStateResponseSchema.parse(added.body);
    const scanRootId = state.scanRoots[0]?.scanRootId;

    const rescanned = await post(SCAN_ROOTS_RESCAN_PATH, { scanRootId });
    expect(rescanned.status).toBe(200);
    expect(Buffer.byteLength(rescanned.raw)).toBeLessThanOrEqual(CLIENT_RESPONSE_LIMIT);

    const listed = await post(SCAN_ROOTS_LIST_PATH, {});
    expect(listed.status).toBe(200);
    expect(Buffer.byteLength(listed.raw)).toBeLessThanOrEqual(CLIENT_RESPONSE_LIMIT);
  });
});
