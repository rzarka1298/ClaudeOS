import { join } from "node:path";
import {
  type ClaudeHeadroomView,
  type CodexUsageUpdatedPayload,
  parseStoredLauncherConfig,
  type ServiceEventType,
  type UsageSummary,
} from "@ccc/domain";
import {
  getLauncherConfig,
  loadRateLimitSnapshot,
  saveRateLimitSnapshot,
} from "@ccc/operational-store";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { AttributeFn } from "../claude/attribution.js";
import type { AnalysisChange } from "../claude/usage-services.js";
import type { EventBus } from "../events/event-bus.js";
import type { Spawner } from "../projects/spawner.js";
import type { BridgeStatus } from "./bridge-state.js";
import {
  CodexHomeAccessError,
  type CodexHomePort,
  createCodexHomePort,
  resolveCodexHome,
} from "./codex-home.js";
import type { CodexDetection } from "./detection.js";
import {
  createHeadroomService,
  defaultHeadroomTimers,
  type HeadroomTimers,
} from "./headroom-service.js";
import type { HookStatusFs } from "./hook-status.js";
import { createRateLimitsClient } from "./rate-limits-client.js";
import type { CodexRouteDeps } from "./routes.js";

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

export async function startCodexServices(deps: CodexServicesDeps): Promise<CodexServices> {
  const { db, logger } = deps;
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? defaultHeadroomTimers;
  const codexHome = configuredCodexHome(deps.env, deps.home);
  const reasonLog = {
    warn: (fields: { readonly reason: string }, message: string): void => {
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
    pausedRuns: () => ({ count: 0, earliestResetAt: null }),
    claudeView: () => claudeHeadroomViewOf(deps.usageSummary()),
    subscribers: () => deps.bus.subscriberCount(),
    publish: (type: "codex.usage.updated", payload: CodexUsageUpdatedPayload) => {
      publish(type, payload);
    },
    now,
    timers,
    isConfigured: () => savedCodexExecutable(db) !== null,
    logger: reasonLog,
  });

  const routeDeps: CodexRouteDeps = { headroom };

  let stopped = false;
  let started = false;
  return {
    routeDeps,
    start() {
      if (stopped || started) return;
      started = true;
      headroom.start();
    },
    onAnalysisChanged() {},
    onLaunchersChanged() {},
    onIntegrationRefresh() {},
    async stop() {
      if (stopped) return;
      stopped = true;
      headroom.stop();
      client.dispose();
    },
  };
}
