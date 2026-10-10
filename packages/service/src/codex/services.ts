import { accessSync, constants } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  type ClaudeHeadroomView,
  type CodexDoctorSummary,
  type CodexInstall,
  type CodexIntegrationStatus,
  type CodexUsageUpdatedPayload,
  parseStoredLauncherConfig,
  type ServiceEventType,
  type UsageSummary,
} from "@ccc/domain";
import { bridgeStateDir } from "@ccc/launchers";
import {
  getCollectorSetting,
  getLauncherConfig,
  loadRateLimitSnapshot,
  saveRateLimitSnapshot,
} from "@ccc/operational-store";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import { type AttributeFn, createAttribution } from "../claude/attribution.js";
import { runGit } from "../claude/git-readonly.js";
import { createStoreProjectLookup } from "../claude/project-lookup.js";
import { type AnalysisChange, TRANSCRIPT_ANALYSIS_SETTING } from "../claude/usage-services.js";
import type { EventBus } from "../events/event-bus.js";
import { mintSharedBridgeRunId } from "../projects/antigravity-terminal.js";
import type { Spawner } from "../projects/spawner.js";
import { isExecutableFile } from "../projects/terminal-launchers.js";
import {
  type BridgeStatus,
  coveringWindow,
  readBridgeStatus,
  toBridgeStatusView,
} from "./bridge-state.js";
import {
  CodexHomeAccessError,
  type CodexHomePort,
  createCodexHomePort,
  resolveCodexHome,
} from "./codex-home.js";
import type { CodexDetection } from "./detection.js";
import { createDoctorProbe } from "./doctor-probe.js";
import type { DoctorRouteDeps } from "./doctor-routes.js";
import { createFollowLogService } from "./follow-log.js";
import {
  createHeadroomService,
  defaultHeadroomTimers,
  type HeadroomTimers,
} from "./headroom-service.js";
import { createHookOverlay } from "./hook-overlay.js";
import { createCodexHookPipeline, mirrorControlFor } from "./hook-pipeline.js";
import { startCodexHookSpool } from "./hook-spool.js";
import { createHookStatusProvider, type HookStatusFs } from "./hook-status.js";
import { buildCodexIntegrationStatus, type CodexIntegrationService } from "./integration-routes.js";
import { createRateLimitsClient } from "./rate-limits-client.js";
import type { CodexRouteDeps } from "./routes.js";
import { createRunOverlay } from "./run-overlay.js";
import { createRunRecordReader, nodeRunRecordFs, summarizePausedRuns } from "./run-records.js";
import { createCodexSessionMirror, resolveCodexInactivityMs } from "./session-mirror.js";
import { createCodexStoreReader, type OpenDatabase } from "./store-reader.js";
import { createTokenScanner } from "./token-scanner.js";
import { createTranscriptOpener } from "./transcript-open.js";

/**
 * The Codex composition root (plan 05.1-28, D-14, D-15, D-17, D-24, D-25): one
 * function builds every Codex service from its tested parts and nothing is
 * constructed anywhere else. Every external effect arrives through the typed
 * deps object, so the integration tests run this real wiring against fakes.
 *
 * Privacy and effects: the composition adds no timer of its own beyond the ones
 * the parts own (through the injected timers), no process kill, no shell and no
 * read of any Codex credential or configuration file; log lines carry reason
 * codes only.
 */

export interface CodexServicesDeps {
  readonly db: Database.Database;
  readonly bus: Pick<EventBus, "publish" | "subscriberCount">;
  readonly logger: Logger;
  /** The service environment (`CCC_CODEX_HOME`, `CODEX_HOME`, `XDG_STATE_HOME`, `CCC_CODEX_INACTIVITY_MS`, `CCC_SPOOL_POLL_MS`). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The owner's home directory (resolved once by the caller). */
  readonly home: string;
  /** The service runtime directory (the hook spool and the installed hook copy live under it). */
  readonly runtimeDir: string;
  /** The one process port; only the transcript opener uses it. */
  readonly spawner: Spawner;
  /** The Phase 5 usage summary, read late (the usage services may start before or after). */
  readonly usageSummary: () => UsageSummary | null;
  /** Codex detection for the install cache; absent means the saved launcher row alone decides. */
  readonly detection?: Pick<CodexDetection, "detectCodex" | "candidatePath"> | undefined;
  readonly readBridgeStatus?: (() => BridgeStatus) | undefined;
  /** The CODEX_HOME port; defaults to the allowlisted port over the resolved home. */
  readonly port?: CodexHomePort | undefined;
  readonly attribute?: AttributeFn | undefined;
  readonly now?: (() => number) | undefined;
  readonly timers?: HeadroomTimers | undefined;
  readonly serviceStartedAt?: number | undefined;
  readonly timeZone?: string | undefined;
  readonly spoolPollMs?: number | undefined;
  readonly settle?: (() => Promise<void>) | undefined;
  readonly isExecutable?: ((path: string) => Promise<boolean>) | undefined;
  readonly statusFs?: HookStatusFs | undefined;
  readonly mintRunId?: (() => string) | undefined;
  /** Opens the Codex thread store (the credential canary passes a recording opener). */
  readonly openDatabase?: OpenDatabase | undefined;
}

export interface CodexServices {
  /** What `createRequestListener` carries as `RouteContext.codex`. */
  readonly routeDeps: CodexRouteDeps;
  /** Arms the timers and kicks the first install detection; `main.ts` calls it once the socket is open. */
  start(): void;
  /** The Phase 5 toggle or delete moved (additive listener of the usage services). */
  onAnalysisChanged(change: AnalysisChange): void;
  /** A launcher row was saved or changed. */
  onLaunchersChanged(): void;
  /** The usage services' integration refresh point: rescan the hook copy and the bridge. */
  onIntegrationRefresh(): void;
  /** Idempotent. Stops the spool, timers and in-flight work; the store may close after it resolves. */
  stop(): Promise<void>;
}

/**
 * The Claude member of the headroom signal, from the Phase 5 usage summary (D-22 gives no
 * verdict to Claude, only facts). The window with the most used capacity is shown, because that
 * is the one a reader needs; a tie goes to the seven-day window. Unavailable carries its reason
 * and no number (never zero).
 */
export function claudeHeadroomViewOf(summary: UsageSummary | null): ClaudeHeadroomView {
  if (summary === null) return { kind: "unavailable", reason: "no-report-yet" };
  const capacity = summary.capacity;
  if (capacity.kind === "unavailable") return { kind: "unavailable", reason: capacity.reason };
  let best = capacity.windows[0];
  for (const window of capacity.windows) {
    if (
      best === undefined ||
      window.usedPercent > best.usedPercent ||
      (window.usedPercent === best.usedPercent && window.window === "seven-day")
    ) {
      best = window;
    }
  }
  if (best === undefined) return { kind: "unavailable", reason: "no-report-yet" };
  return {
    kind: "available",
    window: best.window,
    usedPercent: best.usedPercent,
    resetsAt: best.resetsAt,
    source: capacity.source,
    observedAt: capacity.observedAt,
    freshness: capacity.freshness,
  };
}

/** The saved Codex launcher row's executable, read on every call; null when absent or unreadable. */
function savedCodexExecutable(db: Database.Database): string | null {
  try {
    const record = getLauncherConfig(db, "codex");
    return record === null
      ? null
      : (parseStoredLauncherConfig("codex", record.config)?.executablePath ?? null);
  } catch {
    return null;
  }
}

/** CODEX_HOME for a child process, only when the owner configured one (never the default). */
function configuredCodexHome(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string | null {
  const resolved = resolveCodexHome(env, home);
  return resolved === join(home, ".codex") ? null : resolved;
}

/** A port over a Codex home that does not exist: every read answers "nothing there". */
function createAbsentCodexHomePort(): CodexHomePort {
  return {
    stateDbPath: () => null,
    readNamed: () => null,
    listRolloutFiles: () => [],
    statRollout: () => null,
    readRolloutRange: () => {
      throw new CodexHomeAccessError("unreadable");
    },
    resolveSessionsFile: () => null,
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "non-error";
}

/** The Claude-side spool poll interval: at most two seconds, `CCC_SPOOL_POLL_MS` shrinks it. */
const DEFAULT_SPOOL_POLL_MS = 2000;

function spoolPollMsFrom(env: Readonly<Record<string, string | undefined>>): number {
  const value = Number(env.CCC_SPOOL_POLL_MS ?? DEFAULT_SPOOL_POLL_MS);
  return Number.isFinite(value) && value > 0
    ? Math.min(value, DEFAULT_SPOOL_POLL_MS)
    : DEFAULT_SPOOL_POLL_MS;
}

/** True when `path` is an executable file right now (a synchronous guess for the first status). */
function executableNow(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function startCodexServices(deps: CodexServicesDeps): Promise<CodexServices> {
  const { db, logger } = deps;
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? defaultHeadroomTimers;
  const codexHome = configuredCodexHome(deps.env, deps.home);
  // ONE inactivity window for the mirror, the run overlay, the hook overlay and the follow
  // service: they must agree on when a session is no longer live.
  const inactivityMs = resolveCodexInactivityMs(deps.env);
  const reasonLog = {
    warn: (
      fields: { readonly reason: string; readonly errorName?: string; readonly detail?: string },
      message: string,
    ): void => {
      logger.warn(fields, message);
    },
  };

  /** Forwards one event to the bus; a bus fault never reaches the part that published it. */
  function publish(type: ServiceEventType, payload: unknown): void {
    try {
      deps.bus.publish(type, payload);
    } catch (error: unknown) {
      logger.warn(
        { reason: "publish-failed", type, errorName: errorName(error) },
        "codex event not published",
      );
    }
  }

  const subscribers = (): number => deps.bus.subscriberCount();
  const analysisOn = (): boolean => getCollectorSetting(db, TRANSCRIPT_ANALYSIS_SETTING) === "true";
  const lookup = createStoreProjectLookup(db);
  const attribute =
    deps.attribute ??
    createAttribution({ lookup, getOverride: () => null, realpath, runGit, logger });
  const projectName = (projectId: string): string | null =>
    lookup.list().find((project) => project.projectId === projectId)?.name ?? null;

  // The CODEX_HOME port is the only reader of Codex files. Under a test runner the real default
  // home is refused (plan 05.1-14); the services then run against an absent home, never the real one.
  let port: CodexHomePort;
  if (deps.port !== undefined) {
    port = deps.port;
  } else {
    try {
      port = createCodexHomePort({ root: resolveCodexHome(deps.env, deps.home) });
    } catch (error: unknown) {
      logger.warn(
        { reason: "codex-home-refused", errorName: errorName(error) },
        "codex home not opened",
      );
      port = createAbsentCodexHomePort();
    }
  }

  const readBridge: () => BridgeStatus =
    deps.readBridgeStatus ?? (() => readBridgeStatus({ env: deps.env, home: deps.home, now }));

  let stopped = false;
  let started = false;
  /** Late-bound: the integration service needs parts that themselves report back to it. */
  const lateIntegration: { refresh: () => void } = { refresh: () => undefined };

  // --- the install cache: the saved row's executable, or a detected candidate -------------------
  let install: CodexInstall = {
    installed: (() => {
      const saved = savedCodexExecutable(db);
      return saved !== null && executableNow(saved);
    })(),
    version: null,
  };

  async function refreshInstall(): Promise<void> {
    const saved = savedCodexExecutable(db);
    const isExecutable = deps.isExecutable ?? isExecutableFile;
    const savedOk = saved !== null && (await isExecutable(saved));
    let found: Awaited<ReturnType<CodexDetection["detectCodex"]>>["executables"] = [];
    if (deps.detection !== undefined) {
      try {
        found = (await deps.detection.detectCodex()).executables;
      } catch {
        found = [];
      }
    }
    const version = savedOk
      ? (found.find((candidate) => deps.detection?.candidatePath(candidate.candidateId) === saved)
          ?.version ?? null)
      : (found[0]?.version ?? null);
    const next: CodexInstall = { installed: savedOk || found.length > 0, version };
    if (stopped) return;
    if (next.installed !== install.installed || next.version !== install.version) {
      install = next;
      lateIntegration.refresh();
    }
  }

  function startInstallRefresh(): void {
    void refreshInstall().catch((error: unknown) => {
      logger.warn(
        { reason: "install-refresh-failed", errorName: errorName(error) },
        "codex install not refreshed",
      );
    });
  }

  // --- the session mirror and its overlays ---------------------------------------------------------
  const mirror = createCodexSessionMirror({
    port,
    reader: createCodexStoreReader({
      port,
      now,
      ...(deps.openDatabase === undefined ? {} : { openDatabase: deps.openDatabase }),
    }),
    attribute,
    projectName,
    analysisOn,
    subscribers,
    publish: (type, payload) => {
      publish(type, payload);
    },
    now,
    timers,
    inactivityMs,
    // Any evidence of Codex counts: a saved launcher row, a detected install or a thread store.
    installed: () =>
      savedCodexExecutable(db) !== null || install.installed || port.stateDbPath() !== null,
    logger: reasonLog,
  });

  const bridgeDirs = [
    ...new Set([bridgeStateDir(deps.env, deps.home), bridgeStateDir({}, deps.home)]),
  ];
  const runReader = createRunRecordReader({
    listProjects: () => lookup.list(),
    bridgeStateDir: bridgeDirs,
    home: deps.home,
  });
  // OVERLAY ORDER (wave 6 review H2): the run overlay is registered BEFORE the hook overlay. A
  // wrapper-only limit pause (the wrapper's record says limit, the rollout does not) is decided by
  // the run overlay; the hook overlay never overrides a limit-paused view. Registered the other
  // way round, a later hook Stop would complete the view first and the run overlay (which never
  // pauses a completed view) would lose the pause. createRunOverlay registers its own overlay and
  // tick hook; they are not added again here.
  const runOverlay = createRunOverlay({
    reader: runReader,
    mirror,
    now,
    inactivityMs,
    logger: reasonLog,
  });
  // The tick hook only runs while the event stream has subscribers, so scan once before the first poll.
  await runOverlay.refresh();

  // --- the hook pipeline: socket and spool, one overlay -------------------------------------------
  const pipeline = createCodexHookPipeline({
    now,
    mirrorControl: mirrorControlFor(mirror),
    subscribers,
    onStatusChange: () => lateIntegration.refresh(),
    logger: reasonLog,
  });
  mirror.addOverlay(createHookOverlay({ pipeline, now, inactivityMs }));
  const hookStatus = createHookStatusProvider({
    runtimeDir: deps.runtimeDir,
    ...(deps.statusFs === undefined ? {} : { fs: deps.statusFs }),
    serviceStartedAt: deps.serviceStartedAt ?? now(),
    pipeline,
    onChange: () => lateIntegration.refresh(),
  });
  const spool = startCodexHookSpool({
    runtimeDir: deps.runtimeDir,
    pipeline,
    logger,
    intervalMs: deps.spoolPollMs ?? spoolPollMsFrom(deps.env),
    ...(deps.settle === undefined ? {} : { settle: deps.settle }),
  });
  // Before the socket opens: a record left by an earlier process must be applied first.
  const drained = await spool.drainNow();
  logger.info({ count: drained, dropped: spool.dropCount() }, "startup: drained codex hook spool");

  // --- headroom ------------------------------------------------------------------------------------
  const client = createRateLimitsClient({
    executablePath: () => savedCodexExecutable(db),
    codexHome: () => codexHome,
    homeDir: () => deps.home,
    now,
    logger: reasonLog,
  });
  const headroom = createHeadroomService({
    client,
    saveSnapshot: (snapshot) => {
      try {
        saveRateLimitSnapshot(db, snapshot, snapshot.observedAt);
      } catch (error: unknown) {
        logger.warn(
          { reason: "snapshot-not-saved", errorName: errorName(error) },
          "codex usage not persisted",
        );
      }
    },
    loadSnapshot: () => loadRateLimitSnapshot(db),
    // No rollout rate-limit reader exists in this phase's parts; the bar-only fallback is absent.
    fallback: () => null,
    pausedRuns: () => summarizePausedRuns(mirror.snapshot()),
    claudeView: () => claudeHeadroomViewOf(deps.usageSummary()),
    subscribers,
    publish: (type: "codex.usage.updated", payload: CodexUsageUpdatedPayload) => {
      publish(type, payload);
    },
    now,
    timers,
    isConfigured: () => savedCodexExecutable(db) !== null,
    logger: reasonLog,
  });

  // --- token activity ------------------------------------------------------------------------------
  const tokens = createTokenScanner({
    db,
    port,
    logger,
    now: () => new Date(now()),
    timeZone: deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    isAnalysisOn: analysisOn,
    subscribers,
    publish: (type, payload) => {
      publish(type, payload);
    },
    timers,
  });

  // --- doctor, transcript opener and follow --------------------------------------------------------
  const doctorProbe = createDoctorProbe({
    executablePath: () => savedCodexExecutable(db),
    codexHome: () => codexHome,
    homeDir: () => deps.home,
    now,
    logger: reasonLog,
  });
  let lastDoctor: CodexDoctorSummary | null = null;
  const doctor: DoctorRouteDeps = {
    async run() {
      const result = await doctorProbe.run();
      if (result.kind === "ok") {
        lastDoctor = result.summary;
        lateIntegration.refresh();
      }
      return result;
    },
  };
  const opener = createTranscriptOpener({
    resolveThread: (threadId) => mirror.resolveThread(threadId),
    port,
    spawner: deps.spawner,
  });
  const follow = createFollowLogService({
    runs: runReader,
    fs: nodeRunRecordFs,
    readBridgeStatus: readBridge,
    // A run whose log sits under another candidate state directory (default versus custom state
    // home) is queued to the directory that holds it, never to one that would reject the log.
    readBridgeStatusContaining: (containing) =>
      readBridgeStatus({ env: deps.env, home: deps.home, now, containing }),
    coveringWindow,
    mintRunId: deps.mintRunId ?? mintSharedBridgeRunId,
    now,
    inactivityMs,
    logger: reasonLog,
  });

  // --- the integration status: the bridge view, the hooks, the install cache and the doctor --------
  function statusNow(): CodexIntegrationStatus {
    return buildCodexIntegrationStatus({
      bridge: () => {
        try {
          return toBridgeStatusView(readBridge());
        } catch {
          return { state: "not-installed", lastWindowAt: null };
        }
      },
      hooks: () => hookStatus.status(),
      install: () => install,
      doctor: () => lastDoctor,
    });
  }
  let current = statusNow();
  let currentKey = JSON.stringify(current);
  let refreshing = false;
  const integration: CodexIntegrationService = {
    status: () => current,
    refresh() {
      if (refreshing || stopped) return current;
      refreshing = true;
      try {
        hookStatus.rescan();
        const next = statusNow();
        const key = JSON.stringify(next);
        current = next;
        if (key !== currentKey) {
          currentKey = key;
          publish("codex.integration.updated", next);
        }
        return current;
      } finally {
        refreshing = false;
      }
    },
  };
  lateIntegration.refresh = () => {
    try {
      integration.refresh();
    } catch (error: unknown) {
      logger.warn(
        { reason: "integration-refresh-failed", errorName: errorName(error) },
        "codex integration not refreshed",
      );
    }
  };

  const routeDeps: CodexRouteDeps = {
    headroom,
    sessions: { mirror, opener },
    tokens,
    doctor,
    hooks: pipeline,
    follow: { follow },
    integration,
  };

  let stopPromise: Promise<void> | null = null;
  return {
    routeDeps,
    start() {
      if (stopped || started) return;
      started = true;
      headroom.start();
      mirror.start();
      tokens.start();
      startInstallRefresh();
    },
    onAnalysisChanged(change: AnalysisChange) {
      if (stopped) return;
      try {
        if (change.cause === "toggle") {
          // Titles appear or vanish at once, and the token scan starts or stops.
          tokens.onAnalysisChanged(change.enabled);
          void mirror.pollNow().catch(() => undefined);
        } else {
          // The analytics tables were just emptied: start the scan state over and republish.
          tokens.reset();
          if (change.enabled) tokens.onAnalysisChanged(true);
        }
      } catch (error: unknown) {
        logger.warn(
          { reason: "analysis-change-failed", errorName: errorName(error) },
          "codex analysis change not applied",
        );
      }
    },
    onLaunchersChanged() {
      if (stopped) return;
      startInstallRefresh();
      try {
        headroom.refreshIfStale();
      } catch {
        // A refresh is best effort; the next read-through repeats it.
      }
    },
    onIntegrationRefresh() {
      if (stopped) return;
      lateIntegration.refresh();
    },
    stop() {
      stopPromise ??= (async () => {
        stopped = true;
        const step = async (name: string, run: () => void | Promise<void>): Promise<void> => {
          try {
            await run();
          } catch (error: unknown) {
            logger.warn(
              { reason: "stop-step-failed", step: name, errorName: errorName(error) },
              "codex service did not stop cleanly",
            );
          }
        };
        // The spool first: no record is applied while the rest winds down.
        await step("spool", () => spool.stop());
        await step("headroom", () => headroom.stop());
        await step("mirror", () => mirror.stop());
        await step("tokens", () => tokens.stop());
        await step("run-overlay", () => runOverlay.dispose());
        await step("client", () => client.dispose());
        // An in-flight scan chunk writes to the store: wait for it before the store may close.
        await step("tokens-idle", () => tokens.idle());
      })();
      return stopPromise;
    },
  };
}
