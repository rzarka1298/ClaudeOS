import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  type LaunchGuard,
  newRunId,
  type ProjectLookup,
  type SessionTerminator,
} from "@ccc/domain";
import { getSessionOverride, type OperationalStore } from "@ccc/operational-store";
import type { Logger } from "pino";
import type { EventBus } from "../events/event-bus.js";
import {
  resolveClaudeConfigDir,
  resolveRuntimeDir,
  resolveSpoolDropPath,
  resolveSpoolPath,
  resolveStatusLineSpoolPath,
} from "../paths.js";
import type { Spawner } from "../projects/spawner.js";
import { createAttribution } from "./attribution.js";
import {
  createProposerSlot,
  type ProposerSlot,
  unconfiguredTerminalLauncher,
} from "./default-ports.js";
import { createFocusService, nodeFocusExecFile } from "./focus.js";
import { runGit } from "./git-readonly.js";
import { readInstallRecord } from "./integration-status.js";
import { createLaunchGuard, listWorktrees } from "./launch-guard.js";
import { classifyLaunchSource } from "./launch-source.js";
import { createLivenessSweeper, type LivenessSweeper, livenessConfigFromEnv } from "./liveness.js";
import { createPhase4Bridge } from "./phase4-bridge.js";
import { type ClaudePipeline, createClaudePipeline } from "./pipeline.js";
import {
  createProcessFacts,
  createSessionFactsProvider,
  nodeExecFile,
  type ProcessFacts,
} from "./process-facts.js";
import { createStoreProjectLookup } from "./project-lookup.js";
import type { ClaudeRouteDeps } from "./routes.js";
import { nodeOpenFile, type SessionActionDeps } from "./session-action-routes.js";
import { type SpoolPoller, startSpoolPoller } from "./spool-poller.js";
import { createTerminateExecutor } from "./terminate-executor.js";

/** The spool poll interval (D-08: at most 2 s); `CCC_SPOOL_POLL_MS` shrinks it for tests. */
const DEFAULT_SPOOL_POLL_MS = 2000;

export interface ClaudeServicesDeps {
  readonly store: OperationalStore;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly env: NodeJS.ProcessEnv;
  /**
   * Phase 4's real launch machinery (05-17). With it, resume and branch open
   * terminals through Phase 4's adapter and `startGuard` carries Phase 5's
   * concurrent-write guard for Phase 4's launch service. Absent (unit tests,
   * a composition without projects), the launcher answers
   * `launcher-not-configured` and `startGuard` allows everything.
   */
  readonly phase4?: {
    readonly spawner: Spawner;
    readonly scriptDir: string;
    readonly lookup: ProjectLookup;
  };
}

export interface ClaudeServices {
  readonly pipeline: ClaudePipeline;
  readonly poller: SpoolPoller;
  readonly sweeper: LivenessSweeper;
  /** What `createRequestListener` carries as `RouteContext.claude`. */
  readonly routeDeps: ClaudeRouteDeps;
  /** Phase 5's guard in Phase 4's `LaunchGuard` shape, for `createLaunchService({ guard })` (D-29). */
  readonly startGuard: LaunchGuard | undefined;
  /**
   * The force-terminate executor (05-14), typed on
   * `CapabilityToken<"session.force-terminate">`. Deliberately NOT in
   * `routeDeps`: no route can reach it. It is here for the Phase 6 approval
   * engine, the only issuer of that token, to run after the owner approves.
   */
  readonly terminator: SessionTerminator;
  /**
   * The process facts the Claude services read with (existence probe, start
   * times, ancestry). Read-only, and deliberately NOT in `routeDeps`: the
   * approval composition builds its run inspector over it (06-21).
   */
  readonly processFacts: ProcessFacts;
  /**
   * The late-bound force-terminate proposer (R-WIRING). `main.ts` binds the
   * engine-backed proposer once the approval services exist; until then the
   * terminate-request route answers `approval-unavailable`.
   */
  readonly proposerSlot: ProposerSlot;
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
 * The Claude composition (05-08, 05-11): process facts, project
 * attribution through the read-only git gateway, the launch-source
 * classifier, the session facts provider, the pipeline, the spool poller
 * and the liveness sweeper, built once in `main.ts`. It drains the spool
 * and runs one revival sweep before returning, so `main.ts` calling it
 * after restart recovery and before `startSocketServer` keeps the D-22
 * order: recovery, then the drain, then the revival sweep, then the socket. The Claude config dir is read
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
  // Attribution reads the registered projects and the owner's overrides
  // and runs only read-only git (SESS-11); it never writes (D-57).
  const attribute = createAttribution({
    lookup: createStoreProjectLookup(store.db),
    getOverride: (claudeSessionId) => getSessionOverride(store.db, claudeSessionId),
    realpath,
    runGit,
    logger,
  });
  const facts = createSessionFactsProvider({
    processFacts,
    claudeProjectsRoot: join(resolveClaudeConfigDir(), "projects"),
    logger,
    attribute,
    getOverride: (claudeSessionId) => getSessionOverride(store.db, claudeSessionId),
    classifyLaunchSource: (input) => classifyLaunchSource(input, processFacts),
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
    attribute,
  });

  // Session actions (05-14, 05-17). Resume and branch open terminals through
  // Phase 4's launcher (the adapter its saved configuration selects), and
  // before Phase 6 the terminate request answers approval-unavailable
  // (PR-26): honest, never reaching the OS. Git stays read-only (D-30).
  const guard = createLaunchGuard({ db: store.db, runGit, realpath });
  const installedClaudeBin = (): string | null =>
    readInstallRecord(resolveRuntimeDir())?.claudeBin ?? null;
  const bridge =
    deps.phase4 === undefined
      ? undefined
      : createPhase4Bridge({
          store,
          spawner: deps.phase4.spawner,
          scriptDir: deps.phase4.scriptDir,
          lookup: deps.phase4.lookup,
          guard,
          listWorktrees: (projectRoot) => listWorktrees(projectRoot, { runGit, realpath }),
          installedClaudeBin,
          pipeline,
          mintRunId: newRunId,
          now: () => new Date(),
        });
  const proposerSlot = createProposerSlot();
  const actions: SessionActionDeps = {
    db: store.db,
    launcher: bridge?.terminalLauncher ?? unconfiguredTerminalLauncher,
    guard,
    lookup: createStoreProjectLookup(store.db),
    listWorktrees: (projectRoot) => listWorktrees(projectRoot, { runGit, realpath }),
    focus: createFocusService({
      processFacts,
      execFile: nodeFocusExecFile,
      db: store.db,
      logger,
    }),
    proposer: proposerSlot.proposer,
    // Read per request: the owner's saved launcher first (Phase 4 D-21), then
    // the installer's record, so a change after startup is picked up.
    claudeBin: bridge?.claudeBin ?? installedClaudeBin,
    claudeProjectsRoot: join(resolveClaudeConfigDir(), "projects"),
    openFile: nodeOpenFile,
    now: () => new Date(),
    mintRunId: newRunId,
  };

  const terminator = createTerminateExecutor({
    db: store.db,
    pipeline,
    processFacts,
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    now: () => new Date(),
    logger,
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
    routeDeps: { pipeline, actions },
    startGuard: bridge?.startGuard,
    terminator,
    processFacts,
    proposerSlot,
    async stop() {
      // The sweeper first: its evidence goes through the pipeline, which
      // must still be accepting work, and nothing may sweep a closed store.
      await sweeper.stop();
      await poller.stop();
      await pipeline.stop();
    },
  };
}
