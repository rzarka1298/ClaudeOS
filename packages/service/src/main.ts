import { existsSync, unlinkSync } from "node:fs";
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from "@ccc/domain";
import { createSecurityCliSecretStore } from "@ccc/keychain";
import { applyMigrations, openStore } from "@ccc/operational-store";
import { getInstallSecret } from "./auth/install-secret.js";
import { startClaudeServices } from "./claude/services.js";
import { createEventBus } from "./events/event-bus.js";
import { recoverInterruptedRuns } from "./lifecycle/recover-runs.js";
import { logger } from "./logging.js";
import { ensureRuntimeDir, resolveDbPath, resolveRuntimeDir, resolveSocketPath } from "./paths.js";
import { createRequestListener } from "./routes.js";
import { startSocketServer } from "./socket-server.js";
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

  // ADR-0007: the bus (and the bounded buffer it publishes into) is
  // in-process memory only, never written to the store or a file — a
  // service restart loses it by design, and the client implements full
  // resync for exactly that case. Created here, ahead of the Claude block,
  // because the startup spool drain already publishes session events.
  const eventBus = createEventBus();

  // Claude (Phase 5): the session pipeline, then the spool drain it runs
  // before returning. After recovery and before the socket opens (D-22):
  // recovery, then the drain, then the socket. A drained ending applies to
  // a recovered-stale Run; recovery itself never promotes to completed.
  const claudeServices = await startClaudeServices({
    store,
    bus: eventBus,
    logger,
    env: process.env,
  });

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

  const secretStore = createSecurityCliSecretStore();
  const installSecret = await getInstallSecret(secretStore);

  const heartbeatIntervalMs = Number(
    process.env.CCC_HEARTBEAT_INTERVAL_MS ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  const heartbeatTimer = setInterval(() => {
    eventBus.publish("service.heartbeat", { at: new Date().toISOString() });
  }, heartbeatIntervalMs);

  const requestListener = createRequestListener({
    store,
    getSecret: () => installSecret,
    eventBus,
    claude: claudeServices.routeDeps,
  });
  const server = await startSocketServer({ socketPath, requestListener });

  logger.info({ socketPath }, "listening");

  // The store closes only after the Claude services have drained (the
  // pipeline's queue, its pending coalesced writes, the in-flight spool
  // tick) AND every open connection has ended, so no write ever runs
  // against a closed store (wave 3 review).
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeatTimer);
    const claudeStopped = claudeServices.stop().catch((err: unknown) => {
      logger.error({ err }, "shutdown: claude services did not stop cleanly");
    });
    server.close(() => {
      void claudeStopped.then(() => {
        store.close();
        if (existsSync(socketPath)) {
          unlinkSync(socketPath);
        }
        process.exit(0);
      });
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err: unknown) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
