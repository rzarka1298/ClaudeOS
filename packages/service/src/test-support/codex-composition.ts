import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { newRunId, type ServiceEvent, type ServiceEventType, type UsageSummary } from "@ccc/domain";
import {
  applyMigrations,
  deleteAllUsageAnalytics,
  type OperationalStore,
  openStore,
  saveLauncherConfig,
} from "@ccc/operational-store";
import { mintToken } from "../auth/token.js";
import type { AttributeFn } from "../claude/attribution.js";
import {
  type ClaudePipeline,
  createClaudePipeline,
  type SessionFactsProvider,
} from "../claude/pipeline.js";
import {
  type AnalysisChange,
  startUsageServices,
  type UsageServices,
} from "../claude/usage-services.js";
import { type CodexHomePort, createCodexHomePort } from "../codex/codex-home.js";
import {
  type CodexServices,
  type CodexServicesDeps,
  startCodexServices,
} from "../codex/services.js";
import { createEventBus, type EventBus } from "../events/event-bus.js";
import { createLogger } from "../logging.js";
import { createRequestListener } from "../routes.js";
import { startSocketServer } from "../socket-server.js";
import { type FakeTimers, fakeTimers } from "./codex-token-fixtures.js";
import {
  type FakeAppServer,
  type FakeAppServerScenario,
  readFakeLog,
  writeFakeAppServer,
} from "./fake-codex-app-server.js";
import {
  createFakeCodexHome,
  type FakeCodexHome,
  type FakeCodexHomeOptions,
  rolloutContent,
  rolloutLifecycleLine,
  rolloutMetaLine,
} from "./fake-codex-home.js";
import { createFakeSpawner, type FakeSpawner } from "./fake-spawner.js";

/**
 * One complete temporary composition of the Codex services (plan 05.1-28),
 * shared by this plan's tests and the end-to-end plan: a throwaway store, the
 * real event bus, a fake CODEX_HOME, an optional fake app-server saved as the
 * Codex launcher row, a recording spawner, injected timers, the REAL request
 * listener on a throwaway socket and a minted bearer token.
 *
 * Nothing here opens the owner's runtime directory, the real Codex home or the
 * real bridge state: the service `home` handed to the services is a directory
 * inside the throwaway tree, the environment is empty, and the CODEX_HOME port
 * is built over the fake root.
 */

export interface SocketReply {
  readonly status: number;
  readonly body: unknown;
}

export interface CodexCompositionOptions {
  /** `false` builds the request context WITHOUT the codex member (the 503 shape). Default true. */
  readonly codex?: boolean;
  /** Writes a fake app-server and saves it as the Codex launcher row. Absent: no saved row. */
  readonly appServer?: FakeAppServerScenario;
  /** Saves the fake as the Codex launcher row (default true). `false` leaves it written but unsaved. */
  readonly saveRow?: boolean;
  /** Use this directory as the service home (it must exist) instead of a fresh empty one. */
  readonly homeDir?: string;
  /** The clock the services read. Default: the real one. */
  readonly now?: () => number;
  /** The fake Codex home. Default: an empty current-shape thread store. */
  readonly home?: FakeCodexHomeOptions;
  /** A fixed Claude usage summary; `"real"` builds the real Phase 5 usage services. */
  readonly usage?: UsageSummary | "real" | null;
  /** Overrides any service dependency (a recording fs, a fake bridge reader, a detection fake). */
  readonly deps?: Partial<CodexServicesDeps>;
  /** The environment handed to the services (default empty). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Open event-stream subscribers the services see. Default 0. */
  readonly subscribers?: number;
  /**
   * Runs after the store is open and migrated and before the Codex services are built: register
   * a project, write run records, plant files the services scan at start.
   */
  readonly prepare?: (context: {
    readonly store: OperationalStore;
    readonly dir: string;
    readonly homeDir: string;
    readonly runtimeDir: string;
  }) => void | Promise<void>;
  /** Wires the Phase 5 hooks (`onAnalysisChanged`) of the real usage services to the Codex services. Default true with `usage: "real"`. */
  readonly wireUsageHooks?: boolean;
}

export interface CodexComposition {
  readonly store: OperationalStore;
  readonly bus: EventBus;
  readonly dir: string;
  readonly homeDir: string;
  readonly runtimeDir: string;
  readonly home: FakeCodexHome;
  readonly port: CodexHomePort;
  readonly appServer: FakeAppServer | null;
  readonly spawner: FakeSpawner;
  readonly timers: FakeTimers;
  readonly codex: CodexServices | undefined;
  readonly usage: UsageServices | undefined;
  readonly token: string;
  /** Mutable: the subscriber count the services read. */
  readonly control: { subscribers: number };
  request(
    method: string,
    path: string,
    body?: unknown,
    options?: { readonly token?: string | null; readonly rawBody?: string },
  ): Promise<SocketReply>;
  get(path: string, options?: { readonly token?: string | null }): Promise<SocketReply>;
  post(
    path: string,
    body?: unknown,
    options?: { readonly token?: string | null },
  ): Promise<SocketReply>;
  /** Names of the processes the fake app-server saw start (empty when it never ran). */
  appServerStarts(): number;
  /** Every event of one type published on the bus since the start. */
  events(type: ServiceEventType): ServiceEvent[];
  /** Stops the Codex services (when composed), the socket, the usage services and the store. */
  close(): Promise<void>;
}

const TEST_BASE = join(homedir(), ".ccc-test");

const NULL_FACTS: SessionFactsProvider = {
  factsFor: async () => ({
    pidStartedAt: null,
    launchSource: null,
    projectId: null,
    worktreeRoot: null,
    transcriptPath: null,
  }),
};

/** Attribution that never runs git: every cwd is unclassified. */
export const NO_MATCH_ATTRIBUTION: AttributeFn = async () => ({
  projectId: null,
  worktreeRoot: null,
  reason: "no-match",
});

function rawRequest(
  socketPath: string,
  method: string,
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
          let body: unknown = null;
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw) as unknown;
            } catch {
              body = raw;
            }
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

export async function startCodexComposition(
  options: CodexCompositionOptions = {},
): Promise<CodexComposition> {
  mkdirSync(TEST_BASE, { recursive: true });
  const dir = realpathSync.native(mkdtempSync(join(TEST_BASE, "cc-")));
  const socketPath = join(dir, "t.sock");
  const homeDir = options.homeDir ?? join(dir, "home");
  const runtimeDir = join(dir, "rt");
  if (options.homeDir === undefined) mkdirSync(homeDir);
  mkdirSync(runtimeDir, { mode: 0o700 });

  const store = openStore(join(dir, "operational.db"));
  applyMigrations(store.db);
  const bus = createEventBus();
  const logger = createLogger(join(dir, "logs", "service.log"));

  await options.prepare?.({ store, dir, homeDir, runtimeDir });

  const home = createFakeCodexHome(options.home ?? { database: { ddl: "current", threads: [] } });
  const port = createCodexHomePort({ root: home.root });
  const spawner = createFakeSpawner();
  const timers = fakeTimers();
  const control = { subscribers: options.subscribers ?? 0 };

  let appServer: FakeAppServer | null = null;
  if (options.appServer !== undefined) {
    appServer = writeFakeAppServer(join(dir, "fake"), options.appServer);
    if (options.saveRow !== false) {
      saveLauncherConfig(store.db, "codex", { executablePath: appServer.path, args: [] });
    }
  }

  const holder: { codex: CodexServices | undefined } = { codex: undefined };
  let usage: UsageServices | undefined;
  let pipeline: ClaudePipeline | undefined;
  let fixedSummary: UsageSummary | null = null;
  if (options.usage === "real") {
    pipeline = createClaudePipeline({
      db: store.db,
      bus,
      logger,
      now: () => new Date(),
      mintRunId: newRunId,
      facts: NULL_FACTS,
    });
    usage = startUsageServices({
      db: store.db,
      bus,
      pipeline,
      poller: { setStatusLineSink: () => undefined, dropCount: () => 0 },
      logger,
      env: {},
      now: () => new Date(),
      settingsFacts: () => ({ statusLine: "installed", cleanupPeriodDays: 30 }),
      ...(options.wireUsageHooks === false
        ? {}
        : {
            deleteAnalytics: deleteAllUsageAnalytics,
            onAnalysisChanged: (change: AnalysisChange) => holder.codex?.onAnalysisChanged(change),
            onIntegrationRefresh: () => holder.codex?.onIntegrationRefresh(),
          }),
    });
  } else {
    fixedSummary = options.usage ?? null;
  }

  let codex: CodexServices | undefined;
  if (options.codex !== false) {
    codex = await startCodexServices({
      db: store.db,
      bus: {
        publish: (type, payload) => bus.publish(type, payload),
        subscriberCount: () => control.subscribers,
      },
      logger,
      env: options.env ?? {},
      home: homeDir,
      runtimeDir,
      spawner,
      usageSummary: () => (usage === undefined ? fixedSummary : usage.summary()),
      port,
      attribute: NO_MATCH_ATTRIBUTION,
      timers,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...options.deps,
    });
    holder.codex = codex;
  }

  const secret = randomBytes(32);
  const token = mintToken(secret, { nowMs: Date.now() });
  const server: Server = await startSocketServer({
    socketPath,
    requestListener: createRequestListener({
      store,
      getSecret: () => secret,
      eventBus: bus,
      ...(usage === undefined || pipeline === undefined ? {} : { claude: { pipeline, usage } }),
      ...(codex === undefined ? {} : { codex: codex.routeDeps }),
    }),
  });

  let closed = false;
  const request: CodexComposition["request"] = (method, path, body, requestOptions = {}) => {
    const bearer = requestOptions.token === undefined ? token : requestOptions.token;
    const payload = requestOptions.rawBody ?? (body === undefined ? null : JSON.stringify(body));
    return rawRequest(socketPath, method, path, payload, bearer);
  };

  return {
    store,
    bus,
    dir,
    homeDir,
    runtimeDir,
    home,
    port,
    appServer,
    spawner,
    timers,
    codex,
    usage,
    token,
    control,
    request,
    get: (path, requestOptions) => request("GET", path, undefined, requestOptions),
    post: (path, body, requestOptions) => request("POST", path, body ?? {}, requestOptions),
    appServerStarts: () =>
      appServer === null ? 0 : readFakeLog(appServer.logPath).filter((e) => e.t === "start").length,
    events(type) {
      const replay = bus.buffer.since(0);
      if (replay.mode !== "replay") return [];
      return replay.events.filter((event) => event.type === type);
    },
    async close() {
      if (closed) return;
      closed = true;
      await codex?.stop();
      await usage?.stop();
      server.close();
      store.close();
      home.cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** One thread of a fake Codex home built relative to a clock (see {@link codexHomeWithThreads}). */
export interface CompositionThread {
  readonly id: string;
  /** Milliseconds before `nowMs` that the store says the thread was last updated. */
  readonly agoMs: number;
  /** Lifecycle lines as [event, agoMs]. Default: none. */
  readonly lifecycle?: ReadonlyArray<
    readonly ["task_started" | "task_complete" | "turn_aborted", number]
  >;
  readonly cwd?: string;
  /** A prompt-derived title the mirror may show only while transcript analysis is on. */
  readonly title?: string;
}

/**
 * Options for a fake Codex home holding `threads`: a current-shape thread store and one rollout
 * per thread (meta line plus the lifecycle lines), all stamped relative to `nowMs`.
 */
export function codexHomeWithThreads(
  threads: readonly CompositionThread[],
  nowMs: number = Date.now(),
): FakeCodexHomeOptions {
  const minute = 60_000;
  return {
    rollouts: threads.map((thread) => ({
      day: "2026-10-06",
      name: `rollout-${thread.id}.jsonl`,
      content: rolloutContent(
        rolloutMetaLine({
          id: thread.id,
          atMs: nowMs - thread.agoMs - minute,
          ...(thread.cwd === undefined ? {} : { cwd: thread.cwd }),
        }),
        ...(thread.lifecycle ?? []).map(([event, ago]) =>
          rolloutLifecycleLine(event, nowMs - ago, "turn-1"),
        ),
      ),
      mtimeMs: nowMs - thread.agoMs,
    })),
    database: {
      ddl: "current",
      threads: threads.map((thread) => ({
        id: thread.id,
        updatedAtMs: nowMs - thread.agoMs,
        ...(thread.cwd === undefined ? {} : { cwd: thread.cwd }),
        ...(thread.title === undefined ? {} : { title: thread.title }),
      })),
    },
  };
}

/** Polls `check` until it is true or `timeoutMs` passes; returns the final answer. */
export async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}
