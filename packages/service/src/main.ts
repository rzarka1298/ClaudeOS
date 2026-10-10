import { existsSync, unlinkSync } from "node:fs";
import { type Clock, DEFAULT_HEARTBEAT_INTERVAL_MS, type ProjectId, type RunId } from "@ccc/domain";
import { createSecurityCliSecretStore } from "@ccc/keychain";
import {
  applyMigrations,
  createDiagnosticEffects,
  getProject,
  getSessionRun,
  listLauncherConfigs,
  listProjects,
  openStore,
} from "@ccc/operational-store";
import { createProposeForceTerminate } from "./approval-wiring/proposer.js";
import { createProcessNamer, createRunInspector } from "./approval-wiring/run-inspector.js";
import { createServiceApprovalLog, startApprovalServices } from "./approval-wiring/services.js";
import { getInstallSecret } from "./auth/install-secret.js";
import { startClaudeServices } from "./claude/services.js";
import { startUsageServices } from "./claude/usage-services.js";
import { createEventBus } from "./events/event-bus.js";
// The composition root is the ONLY importer of the executors folder (APPR-01,
// T-06-02): effect code is reachable only through the engine's definitions.
import { createDiagnosticTestOperation, createForceTerminateOperation } from "./executors/index.js";
import { recoverInterruptedRuns } from "./lifecycle/recover-runs.js";
import { logger } from "./logging.js";
import { ensureRuntimeDir, resolveDbPath, resolveRuntimeDir, resolveSocketPath } from "./paths.js";
import { recomputeApprovedRoots, VAULT_ROOT_META_KEY } from "./projects/approved-roots.js";
import { createProjectsCollector } from "./projects/collector.js";
import { createExecFileCommandRunner } from "./projects/command-runner.js";
import { createDetector } from "./projects/detection.js";
import { createGitRunner, resolveGit } from "./projects/git-runner.js";
import { createLaunchService } from "./projects/launch-service.js";
import type { LauncherServices } from "./projects/launcher-routes.js";
import { createStoreProjectLookup } from "./projects/project-lookup.js";
import type { ProjectServices } from "./projects/project-routes.js";
import { resolveHomeDir } from "./projects/project-views.js";
import { createScanService } from "./projects/scan.js";
import {
  ensureScriptDir,
  STARTUP_SCRIPT_MIN_AGE_MS,
  sweepStaleScripts,
} from "./projects/script-dir.js";
import { createCommandSpawner } from "./projects/spawner.js";
import { createRequestListener } from "./routes.js";
import { createShutdown } from "./shutdown.js";
import { claimSocketPath, logSocketClaimRefusal, startSocketServer } from "./socket-server.js";
import { createTaskServices } from "./tasks/task-service.js";
import { registerPersistedVaultRoot } from "./vault-root.js";

/**
 * Composition root: resolves the runtime directory and socket/db paths,
 * opens the operational store, writes the startup record, resolves the
 * per-install secret through the Keychain-backed `SecretStore`
 * (`@ccc/keychain`, ADR-0017), starts the socket server, and wires signal
 * handling. Per ADR-0001 this module never binds a numeric port and never
 * opens a network interface — the socket server it starts is the only
 * inbound surface. All startup/shutdown diagnostics go through the
 * redacting logger (`./logging.js`) — never a raw console write.
 */
async function main(): Promise<void> {
  const runtimeDir = resolveRuntimeDir();
  const socketPath = resolveSocketPath();
  const dbPath = resolveDbPath();

  ensureRuntimeDir(runtimeDir, logger);

  // A second instance must refuse BEFORE it changes anything a live
  // instance depends on — the launch-script sweep, the store (migrations,
  // run recovery, the spool drain) and above all the socket file itself.
  // Probing, not unlinking: a live listener throws SocketInUseError (the
  // file stays); only a stale socket from an unclean shutdown is removed.
  await claimSocketPath(socketPath);

  // Phase 4 (plan 04-09): the private launch-script directory, before the
  // socket listens. Leftovers from interrupted launches go, but only those
  // older than a short threshold: a launchd KeepAlive restart can follow a
  // hand-off within seconds, before Terminal has read that script (D-20,
  // Pitfall 5). Only the count is logged.
  const scriptDir = ensureScriptDir(runtimeDir, logger);
  const sweptScripts = sweepStaleScripts(scriptDir, { olderThanMs: STARTUP_SCRIPT_MIN_AGE_MS });
  if (sweptScripts > 0) {
    logger.info({ count: sweptScripts }, "startup: removed leftover launch scripts");
  }

  const store = openStore(dbPath);
  // ADR-0018: migrations apply before anything else touches the store, so
  // no request is ever served against a stale schema. `service_meta` was
  // created ad hoc by `openStore()` above (plan 01-01); the baseline
  // migration's `CREATE TABLE IF NOT EXISTS` takes ownership without
  // erroring on the table it finds already there.
  applyMigrations(store.db);
  const startedAt = new Date().toISOString();
  store.writeServiceMeta("started_at", startedAt);
  // The walking skeleton pins the service version literally rather than
  // reading package.json at runtime (a JSON import under NodeNext module
  // resolution is an unnecessary wrinkle for Phase 1); a later phase can
  // thread the real build-time version through if it becomes load-bearing.
  store.writeServiceMeta("service_version", "0.1.0");

  // Restart recovery, then the spool drain, both before the socket begins
  // accepting connections: a Run's pre-recovery state and a spool record
  // from a previous process's lifetime must never be observable over the
  // API (SVC-11, ADR-0007/ADR-0010).
  const reconciledCount = recoverInterruptedRuns(store.db, logger);
  if (reconciledCount > 0) {
    logger.info({ reconciledCount }, "startup: reconciled interrupted runs");
  }

  // The managed vault root is the only approved path root this phase
  // introduces, and the allowlist is in-memory — so it has to be rebuilt
  // from the private operational store on every boot or a restart would
  // silently revoke access to the user's own vault. Deny-by-default holds
  // until setup has run at least once: `null` here registers nothing.
  const vaultRoot = registerPersistedVaultRoot(store);
  logger.info(
    { registered: vaultRoot !== null },
    "startup: reloaded managed vault root into the path allowlist",
  );

  // --- Phase 4 (projects and launchers) startup block -------------------
  // Phase 5 appends its own block after this one; keep Phase 4's calls
  // together here.
  //
  // The approved roots are a pure function of the store (D-05): the vault
  // root plus every registered project. Recomputed here, after migrations
  // and the vault-root reload, so a restart restores project access exactly
  // as persisted. Only the count is logged — never a path (D-46).
  const approvedRoots = recomputeApprovedRoots(store);
  logger.info({ count: approvedRoots.length }, "startup: recomputed approved path roots");

  // ADR-0007: the bus (and the bounded buffer it publishes into) is
  // in-process memory only, never written to the store or a file — a
  // service restart loses it by design, and the client implements full
  // resync for exactly that case. Created here, ahead of the Claude block,
  // because the startup spool drain already publishes session events.
  const eventBus = createEventBus();

  // Phase 4's process ports, built before the Claude services because Phase
  // 5's resume and branch open terminals through the same spawner (05-17).
  // One process port for every child the projects code starts; `main.ts` is
  // the only place a real one is constructed (Shared Pattern 3).
  const commandRunner = createExecFileCommandRunner();
  // Every app launch goes through this one spawner (D-18): execFile with an
  // argv array, a fixed environment, stderr classified and dropped (D-46).
  const spawner = createCommandSpawner(commandRunner);

  // Claude (Phase 5): the session pipeline, then the spool drain it runs
  // before returning. After recovery and before the socket opens (D-22):
  // recovery, then the drain, then the socket. A drained ending applies to
  // a recovered-stale Run; recovery itself never promotes to completed.
  const claudeServices = await startClaudeServices({
    store,
    bus: eventBus,
    logger,
    env: process.env,
    phase4: { spawner, scriptDir, lookup: createStoreProjectLookup(store) },
  });
  // Usage (05-12): status-line capacity and cost, the opt-in transcript
  // scanner and integration status. It hooks the pipeline and the poller
  // only through their listener APIs, and its background work (the startup
  // transcript sweep) begins only once the socket is open, never blocking
  // startup (D-55).
  const usageServices = startUsageServices({
    db: store.db,
    bus: eventBus,
    pipeline: claudeServices.pipeline,
    poller: claudeServices.poller,
    logger,
    env: process.env,
    now: () => new Date(),
  });

  const secretStore = createSecurityCliSecretStore();
  const installSecret = await getInstallSecret(secretStore);

  const heartbeatIntervalMs = Number(
    process.env.CCC_HEARTBEAT_INTERVAL_MS ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  const heartbeatTimer = setInterval(() => {
    eventBus.publish("service.heartbeat", { at: new Date().toISOString() });
  }, heartbeatIntervalMs);

  // --- Phase 4 (projects and launchers): git status collection ---------
  // Built after the event bus because the collector publishes into it and
  // gates its interval on `eventBus.subscriberCount()` (D-11).
  //
  // Resolved once: the system git path is a shim that opens the Command Line
  // Tools installer when no developer directory is selected, so it is only
  // used when `xcode-select -p` succeeds (D-10).
  const gitResolution = await resolveGit(commandRunner);
  logger.info({ gitAvailable: gitResolution.kind === "available" }, "startup: resolved git");
  const gitRunner = createGitRunner({ runner: commandRunner, git: gitResolution });
  // Git state lives in memory only (D-11); every project starts `pending`
  // and is read on the first tick with a subscriber, or on refresh.
  // One resolved home for every home comparison: display paths and
  // protected-location detection both judge realpaths (D-43, D-29).
  const homeDir = resolveHomeDir();
  const projectsCollector = createProjectsCollector({
    eventBus,
    gitRunner,
    readRecords: () => listProjects(store.db),
    readLauncherConfigs: () => listLauncherConfigs(store.db),
    homeDir,
  });
  projectsCollector.start();
  // The routes see the collector only through this narrow port (SC-2).
  const projects: ProjectServices = {
    snapshot: () => projectsCollector.snapshot(),
    onRegistryChanged: () => projectsCollector.onRegistryChanged(),
    refresh: (projectId) => projectsCollector.refresh(projectId),
    homeDir,
    runtimeDir,
  };

  // --- Phase 4 (projects and launchers): the launch pipeline ------------
  // The one spawner (D-18) is built above, beside the command runner, because
  // Phase 5's session launches reuse it. The launch service reads the
  // collector's in-memory state only and never waits on git (D-42); its guard
  // is Phase 5's concurrent-write guard (D-29), failing closed without one.
  const launch = createLaunchService({
    store,
    spawner,
    lookup: createStoreProjectLookup(store),
    collector: {
      refresh: (projectId) => projectsCollector.refresh(projectId),
      onRegistryChanged: () => projectsCollector.onRegistryChanged(),
      gitState: (projectId) => projectsCollector.gitState(projectId),
    },
    logger,
    // Claude Code reaches its terminal through a generated script in this
    // directory; the executable check (access X_OK) runs inside the launch
    // service before every launch (D-20, D-22).
    scriptDir,
    // Phase 5's concurrent-write guard, adapted to this seam (05-17, D-29).
    guard: claudeServices.startGuard ?? {
      check: (input) =>
        Promise.resolve(
          input.action === "claude-code" ? { ok: false, error: "spawn-failed" } : { ok: true },
        ),
    },
  });

  // --- Phase 4 (projects and launchers): launcher setup (plan 04-11) -----
  // Detection runs mdfind/plutil/xcode-select through the same command
  // runner and only proposes (D-27); saves, Test launches and the System
  // Settings panes go through the launcher routes. Test launches use the
  // same spawner and script directory as real launches.
  const launchers: LauncherServices = {
    detector: createDetector({ runner: commandRunner, homeDir }),
    homeDir,
    onLaunchersChanged: () => projectsCollector.onLaunchersChanged(),
    spawner,
    scriptDir,
  };

  // --- Phase 4 (projects and launchers): scan folders (plan 04-13) -------
  // Scans run only when a folder is nominated and when the owner chooses
  // Rescan folder: nothing here schedules, watches or repeats (D-07). The
  // policy is read fresh on every call, so a vault set up later applies.
  const scan = createScanService({
    store,
    homeDir,
    readPolicy: () => {
      const persistedVault = store.readServiceMeta(VAULT_ROOT_META_KEY);
      return {
        homeDir,
        runtimeDir,
        vaultRoot: persistedVault !== null && persistedVault.length > 0 ? persistedVault : null,
      };
    },
    projects,
  });

  // --- Phase 6 (approvals and tasks) startup block ------------------------
  // After the Claude block above (its spool drain and revival sweep have
  // settled every Run's state, so force-terminate reconcile reads true facts,
  // A-3) and before the socket opens. The terminator is handed to the
  // force-terminate operation here and nowhere else; the routes below get the
  // narrow approval services and no executor (APPR-01, T-06-02).
  const approvalClock: Clock = { now: () => new Date().toISOString() };
  const approvalLog = createServiceApprovalLog(logger);
  const readVaultRoot = (): string | null => {
    const persisted = store.readServiceMeta(VAULT_ROOT_META_KEY);
    return persisted !== null && persisted.length > 0 ? persisted : null;
  };
  const runInspector = createRunInspector({
    db: store.db,
    processFacts: claudeServices.processFacts,
  });
  const approvals = startApprovalServices({
    db: store.db,
    definitions: [
      createDiagnosticTestOperation({
        effects: createDiagnosticEffects(store.db, approvalClock.now),
      }),
      createForceTerminateOperation({
        terminator: claudeServices.terminator,
        inspector: runInspector,
        log: approvalLog,
      }),
    ],
    clock: approvalClock,
    eventBus,
    getVaultRoot: readVaultRoot,
    log: approvalLog,
    env: process.env,
    projectName: (projectId) => getProject(store.db, projectId as ProjectId)?.displayName ?? null,
  });
  const recovered = await approvals.recover();
  logger.info({ counts: recovered }, "startup: recovered approval requests");
  // The expiry sweep starts right after recovery, before the socket opens (D-09).
  approvals.start();
  // Only now does force-terminate become a real request: the slot answered
  // approval-unavailable until the engine, recovery and the sweeper existed (D-42).
  claudeServices.proposerSlot.bind(
    createProposeForceTerminate({
      engine: approvals.engine,
      inspector: runInspector,
      runContext: (runId) => {
        const run = getSessionRun(store.db, runId as RunId);
        if (run === null) return null;
        const project =
          run.projectId === null ? null : getProject(store.db, run.projectId as ProjectId);
        return { projectId: run.projectId, projectName: project?.displayName ?? null };
      },
      processName: createProcessNamer({
        readAncestry: (pid) => claudeServices.processFacts.readAncestry(pid),
      }),
      log: approvalLog,
    }),
  );

  // Tasks: the task index is a disposable cache of the vault, so the startup
  // walk rebuilds it after migrations and before the socket opens. Only the
  // narrow TaskServices members go into the route context.
  const taskHost = createTaskServices({
    db: store.db,
    getVaultRoot: readVaultRoot,
    eventBus,
    now: () => new Date(),
    log: logger,
  });
  // A missing vault root or a failed walk never stops the service: the index
  // stays a cache, the task routes answer their closed codes, and one fixed
  // code is logged (D-35, SVC-11). No path, title or note text reaches the log.
  try {
    const walked = taskHost.startupWalk();
    if (walked.ok) {
      logger.info(
        { tasks: walked.value.tasks, attention: walked.value.attention },
        "startup: task index built",
      );
    } else {
      logger.warn({ code: walked.code }, "startup: task index not built");
    }
  } catch {
    logger.error({ code: "task-startup-walk-threw" }, "startup: task index not built");
  }

  const requestListener = createRequestListener({
    store,
    getSecret: () => installSecret,
    eventBus,
    claude: { ...claudeServices.routeDeps, usage: usageServices },
    projects,
    launch,
    launchers,
    scan,
    approvals: approvals.services,
    tasks: {
      create: (request) => taskHost.create(request),
      list: (request) => taskHost.list(request),
      counts: (request) => taskHost.counts(request),
      get: (request) => taskHost.get(request),
      dueToday: (request) => taskHost.dueToday(request),
      attention: (request) => taskHost.attention(request),
      changed: (request) => taskHost.changed(request),
      rebuild: () => taskHost.rebuild(),
    },
  });
  const server = await startSocketServer({ socketPath, requestListener });

  logger.info({ socketPath }, "listening");
  usageServices.start();

  // The store closes only after the Claude services have drained (the
  // pipeline's queue, its pending coalesced writes, the in-flight spool
  // tick) AND every open connection has ended, so no write ever runs
  // against a closed store (wave 3 review).
  const shutdown = createShutdown({
    stopIntake: () => {
      clearInterval(heartbeatTimer);
      taskHost.dispose();
      projectsCollector.stop();
    },
    // The approvals first (D-09): the expiry sweeper stops, then every
    // execution already running is awaited. An execution reaches the Claude
    // services' terminator and the store, so both must outlive it. Then usage,
    // whose scans read the store and hang off the pipeline and the poller, and
    // last the Claude services, after which the store may close.
    stopApprovals: () => approvals.stop(),
    stopUsage: () => usageServices.stop(),
    stopClaude: () => claudeServices.stop(),
    closeServer: (done) => {
      server.close(done);
    },
    closeConnections: () => {
      eventBus.closeAll();
      server.closeIdleConnections();
    },
    closeResources: () => {
      store.close();
      if (existsSync(socketPath)) {
        unlinkSync(socketPath);
      }
    },
    exit: (code) => process.exit(code),
    onError: (message, err) => {
      logger.error({ err }, message);
    },
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err: unknown) => {
  if (!logSocketClaimRefusal(logger, err)) {
    logger.error({ err }, "fatal startup error");
  }
  process.exit(1);
});
