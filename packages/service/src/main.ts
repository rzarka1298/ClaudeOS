import { existsSync, unlinkSync } from "node:fs";
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from "@ccc/domain";
import { createSecurityCliSecretStore } from "@ccc/keychain";
import {
  applyMigrations,
  listLauncherConfigs,
  listProjects,
  openStore,
} from "@ccc/operational-store";
import { getInstallSecret } from "./auth/install-secret.js";
import { createEventBus } from "./events/event-bus.js";
import { recoverInterruptedRuns } from "./lifecycle/recover-runs.js";
import { drainSpool } from "./lifecycle/spool-drain.js";
import { logger } from "./logging.js";
import {
  ensureRuntimeDir,
  resolveDbPath,
  resolveRuntimeDir,
  resolveSocketPath,
  resolveSpoolPath,
} from "./paths.js";
import { recomputeApprovedRoots } from "./projects/approved-roots.js";
import { createProjectsCollector } from "./projects/collector.js";
import { createExecFileCommandRunner } from "./projects/command-runner.js";
import { createDetector } from "./projects/detection.js";
import { createGitRunner, resolveGit } from "./projects/git-runner.js";
import { createLaunchService } from "./projects/launch-service.js";
import type { LauncherServices } from "./projects/launcher-routes.js";
import { createStoreProjectLookup } from "./projects/project-lookup.js";
import type { ProjectServices } from "./projects/project-routes.js";
import { resolveHomeDir } from "./projects/project-views.js";
import {
  ensureScriptDir,
  STARTUP_SCRIPT_MIN_AGE_MS,
  sweepStaleScripts,
} from "./projects/script-dir.js";
import { createCommandSpawner } from "./projects/spawner.js";
import { createRequestListener } from "./routes.js";
import { claimSocketPath, SocketInUseError, startSocketServer } from "./socket-server.js";
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
  const spoolRecords = drainSpool(resolveSpoolPath(), logger);
  logger.info({ count: spoolRecords.length }, "startup: drained hook spool");

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

  const secretStore = createSecurityCliSecretStore();
  const installSecret = await getInstallSecret(secretStore);

  // ADR-0007: the bus (and the bounded buffer it publishes into) is
  // in-process memory only, never written to the store or a file — a
  // service restart loses it by design, and the client implements full
  // resync for exactly that case.
  const eventBus = createEventBus();
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
  // One process port for every child the projects code starts; `main.ts` is
  // the only place a real one is constructed (Shared Pattern 3).
  const commandRunner = createExecFileCommandRunner();
  // Resolved once: `/usr/bin/git` is a shim that opens the Command Line
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
  // Every app launch goes through this one spawner (D-18): execFile with an
  // argv array, a fixed environment, stderr classified and dropped (D-46).
  // The launch service reads the collector's in-memory state only and never
  // waits on git (D-42); Phase 4's guard allows everything (D-49).
  const spawner = createCommandSpawner(commandRunner);
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

  const requestListener = createRequestListener({
    store,
    getSecret: () => installSecret,
    eventBus,
    projects,
    launch,
    launchers,
  });
  const server = await startSocketServer({ socketPath, requestListener });

  logger.info({ socketPath }, "listening");

  const shutdown = (): void => {
    clearInterval(heartbeatTimer);
    projectsCollector.stop();
    server.close(() => {
      store.close();
      if (existsSync(socketPath)) {
        unlinkSync(socketPath);
      }
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err: unknown) => {
  if (err instanceof SocketInUseError) {
    logger.error(
      { socketPath: err.socketPath },
      "startup refused: another service instance is already listening on the socket",
    );
  } else {
    logger.error({ err }, "fatal startup error");
  }
  process.exit(1);
});
