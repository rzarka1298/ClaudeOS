import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ProjectsUpdatedPayload, ProjectsUpdatedPayloadSchema } from "@ccc/domain";
import {
  applyMigrations,
  listLauncherConfigs,
  listProjects,
  type OperationalStore,
  openStore,
} from "@ccc/operational-store";
import { mintToken } from "../auth/token.js";
import { createEventBus, type EventBus } from "../events/event-bus.js";
import { clearApprovedRoots } from "../path-allowlist.js";
import { createProjectsCollector, type ProjectsCollector } from "../projects/collector.js";
import { createDetector, type Detector } from "../projects/detection.js";
import { createLaunchService } from "../projects/launch-service.js";
import type { LauncherServices } from "../projects/launcher-routes.js";
import { createStoreProjectLookup } from "../projects/project-lookup.js";
import type { ProjectServices } from "../projects/project-routes.js";
import { ensureScriptDir } from "../projects/script-dir.js";
import { createRequestListener } from "../routes.js";
import { startSocketServer } from "../socket-server.js";
import {
  createFakeCommandRunner,
  type FakeCommandRunner,
  type ScriptedReply,
} from "./fake-command-runner.js";
import { createFakeSpawner, type FakeSpawner } from "./fake-spawner.js";

/**
 * The launcher routes over a real socket (plan 04-11): the real route
 * table, store, event bus and projects collector, with every process port
 * replaced — detection answers from a scripted {@link FakeCommandRunner} and
 * every launch or test lands in a {@link FakeSpawner}. Nothing opens on the
 * owner's desktop, and the runtime directory is a throwaway one (the
 * package's vitest setup file points `CCC_RUNTIME_DIR` at it).
 */

export interface SocketReply {
  readonly status: number;
  readonly body: unknown;
}

export interface LauncherHarness {
  readonly store: OperationalStore;
  readonly spawner: FakeSpawner;
  readonly runner: FakeCommandRunner;
  readonly eventBus: EventBus;
  readonly collector: ProjectsCollector;
  readonly detector: Detector;
  /** A throwaway home directory: the claude candidates and `~` live here. */
  readonly homeDir: string;
  /** A throwaway runtime directory holding the 0700 launch-script directory. */
  readonly runtimeDir: string;
  readonly scriptDir: string;
  /** POST with a valid bearer token, or none when `token` is `null`. */
  post(
    path: string,
    body: unknown,
    options?: { readonly token?: string | null },
  ): Promise<SocketReply>;
  /** GET with a valid bearer token. */
  get(path: string): Promise<SocketReply>;
  /** Every `projects.updated` payload published since the harness started. */
  projectsUpdates(): ProjectsUpdatedPayload[];
  close(): void;
}

export interface LauncherHarnessOptions {
  /** Scripted mdfind / plutil replies for detection and the save-time bundle check. */
  readonly script?: readonly ScriptedReply[];
  /** Overrides the save/test executable check (defaults to the real regular-file + X_OK check). */
  readonly isExecutable?: (path: string) => Promise<boolean>;
  /** Shortens the Test step's caps. */
  readonly testCapMs?: number;
  readonly automationTestCapMs?: number;
  /** Overrides the save's validation cap (codex review 3, finding 4). */
  readonly saveValidationCapMs?: number;
  /** Wraps the real detector, e.g. to slow `findBundle` down. */
  readonly wrapDetector?: (detector: Detector) => Detector;
}

function request(
  socketPath: string,
  method: "GET" | "POST",
  path: string,
  payload: string | null,
  bearer: string | null,
): Promise<SocketReply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method,
        headers: {
          ...(payload === null
            ? {}
            : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
          ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            body: raw.length > 0 ? (JSON.parse(raw) as unknown) : null,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

// Short socket base under the home directory (the sun_path cap, ADR-0001).
const TEST_BASE = join(homedir(), ".ccc-test");

export async function startLauncherHarness(
  options: LauncherHarnessOptions = {},
): Promise<LauncherHarness> {
  clearApprovedRoots();
  mkdirSync(TEST_BASE, { recursive: true });
  const dir = realpathSync.native(mkdtempSync(join(TEST_BASE, "lr-")));
  const socketPath = join(dir, "t.sock");
  const homeDir = join(dir, "home");
  const runtimeDir = join(dir, "rt");
  mkdirSync(homeDir);
  mkdirSync(runtimeDir, { mode: 0o700 });
  const scriptDir = ensureScriptDir(runtimeDir);
  const store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
  const eventBus = createEventBus();
  const spawner = createFakeSpawner();
  const runner = createFakeCommandRunner({ script: options.script ?? [] });
  const collector = createProjectsCollector({
    eventBus,
    gitRunner: { readProject: () => Promise.resolve({ kind: "not-a-repo" }) },
    readRecords: () => listProjects(store.db),
    readLauncherConfigs: () => listLauncherConfigs(store.db),
    homeDir,
  });
  const realDetector = createDetector({
    runner,
    homeDir,
    readdir: () => Promise.resolve([]),
    ...(options.isExecutable === undefined ? {} : { isExecutable: options.isExecutable }),
    resolveGit: () => Promise.resolve({ kind: "unavailable" }),
  });
  const detector = options.wrapDetector?.(realDetector) ?? realDetector;
  const projects: ProjectServices = {
    snapshot: () => collector.snapshot(),
    onRegistryChanged: () => collector.onRegistryChanged(),
    refresh: (projectId) => collector.refresh(projectId),
    homeDir,
    runtimeDir,
  };
  const launch = createLaunchService({
    store,
    spawner,
    lookup: createStoreProjectLookup(store),
    collector: {
      refresh: () => undefined,
      onRegistryChanged: () => collector.onRegistryChanged(),
      gitState: (projectId) => collector.gitState(projectId),
    },
    logger: { info() {}, warn() {} },
    scriptDir,
  });
  const launchers: LauncherServices = {
    detector,
    homeDir,
    onLaunchersChanged: () => collector.onLaunchersChanged(),
    spawner,
    scriptDir,
    ...(options.isExecutable === undefined ? {} : { isExecutable: options.isExecutable }),
    ...(options.testCapMs === undefined ? {} : { testCapMs: options.testCapMs }),
    ...(options.automationTestCapMs === undefined
      ? {}
      : { automationTestCapMs: options.automationTestCapMs }),
    ...(options.saveValidationCapMs === undefined
      ? {}
      : { saveValidationCapMs: options.saveValidationCapMs }),
  };
  const secret = randomBytes(32);
  const token = mintToken(secret, { nowMs: Date.now() });
  const server: Server = await startSocketServer({
    socketPath,
    requestListener: createRequestListener({
      store,
      getSecret: () => secret,
      eventBus,
      projects,
      launch,
      launchers,
    }),
  });

  return {
    store,
    spawner,
    runner,
    eventBus,
    collector,
    detector,
    homeDir,
    runtimeDir,
    scriptDir,
    post(path, body, postOptions = {}) {
      const bearer = postOptions.token === undefined ? token : postOptions.token;
      return request(socketPath, "POST", path, JSON.stringify(body), bearer);
    },
    get(path) {
      return request(socketPath, "GET", path, null, token);
    },
    projectsUpdates() {
      const replay = eventBus.buffer.since(0);
      if (replay.mode !== "replay") return [];
      return replay.events
        .filter((event) => event.type === "projects.updated")
        .map((event) => ProjectsUpdatedPayloadSchema.parse(event.payload));
    },
    close() {
      collector.stop();
      server.close();
      store.close();
      clearApprovedRoots();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
