import { join } from "node:path";
import { newRunId } from "@ccc/domain";
import type { OperationalStore } from "@ccc/operational-store";
import type { Logger } from "pino";
import type { EventBus } from "../events/event-bus.js";
import {
  resolveClaudeConfigDir,
  resolveSpoolDropPath,
  resolveSpoolPath,
  resolveStatusLineSpoolPath,
} from "../paths.js";
import { createLivenessSweeper, type LivenessSweeper, livenessConfigFromEnv } from "./liveness.js";
import { type ClaudePipeline, createClaudePipeline } from "./pipeline.js";
import { createProcessFacts, createSessionFactsProvider, nodeExecFile } from "./process-facts.js";
import type { ClaudeRouteDeps } from "./routes.js";
import { type SpoolPoller, startSpoolPoller } from "./spool-poller.js";

/** The spool poll interval (D-08: at most 2 s); `CCC_SPOOL_POLL_MS` shrinks it for tests. */
const DEFAULT_SPOOL_POLL_MS = 2000;

export interface ClaudeServicesDeps {
  readonly store: OperationalStore;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly env: NodeJS.ProcessEnv;
}

export interface ClaudeServices {
  readonly pipeline: ClaudePipeline;
  readonly poller: SpoolPoller;
  readonly sweeper: LivenessSweeper;
  /** What `createRequestListener` carries as `RouteContext.claude`. */
  readonly routeDeps: ClaudeRouteDeps;
  /**
   * Stops the liveness sweeper (awaiting its in-flight sweep), the poller
   * (awaiting its in-flight tick), then the pipeline
   * (awaiting its queue and writing any coalesced activity still pending).
   * The store may be closed only after this resolves.
   */
  stop(): Promise<void>;
}

function pollInterval(env: NodeJS.ProcessEnv): number {
  const value = Number(env.CCC_SPOOL_POLL_MS ?? DEFAULT_SPOOL_POLL_MS);
  return Number.isFinite(value) && value > 0
    ? Math.min(value, DEFAULT_SPOOL_POLL_MS)
    : DEFAULT_SPOOL_POLL_MS;
}

/**
 * The Claude composition (05-08): process facts, the session facts
 * provider, the pipeline and the spool poller, built once in `main.ts`.
 * It drains the spool before returning, so `main.ts` calling it after
 * restart recovery and before `startSocketServer` keeps the D-22 order:
 * recovery, then the drain, then the socket. The Claude config dir is read
 * only (its `projects/` is the transcript root, PR-28); it is never a
 * write root.
 */
export async function startClaudeServices(deps: ClaudeServicesDeps): Promise<ClaudeServices> {
  const { store, bus, logger, env } = deps;
  const processFacts = createProcessFacts({
    execFile: nodeExecFile,
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    logger,
  });
  const facts = createSessionFactsProvider({
    processFacts,
    claudeProjectsRoot: join(resolveClaudeConfigDir(), "projects"),
    logger,
  });
  const pipeline = createClaudePipeline({
    db: store.db,
    bus,
    logger,
    now: () => new Date(),
    mintRunId: newRunId,
    facts,
  });
  const poller = startSpoolPoller({
    spoolPath: resolveSpoolPath(),
    statusLinePath: resolveStatusLineSpoolPath(),
    dropPath: resolveSpoolDropPath(),
    pipeline,
    logger,
    intervalMs: pollInterval(env),
  });

  const sweeper = createLivenessSweeper({
    db: store.db,
    pipeline,
    processFacts,
    logger,
    now: () => new Date(),
    config: livenessConfigFromEnv(env),
  });

  const drained = await poller.drainNow();
  logger.info({ count: drained, dropped: poller.dropCount() }, "startup: drained hook spool");
  // D-22: after recovery turned every non-terminal Run stale and the drain
  // applied any queued endings, one immediate sweep revives the Runs whose
  // process is still the same live process — all before `main.ts` opens
  // the socket. Only then does the periodic sweep begin.
  const revival = await sweeper.sweepNow();
  logger.info(revival, "startup: liveness sweep");
  sweeper.start();

  return {
    pipeline,
    poller,
    sweeper,
    routeDeps: { pipeline },
    async stop() {
      // The sweeper first: its evidence goes through the pipeline, which
      // must still be accepting work, and nothing may sweep a closed store.
      await sweeper.stop();
      await poller.stop();
      await pipeline.stop();
    },
  };
}
