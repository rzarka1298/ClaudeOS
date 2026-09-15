import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createSecurityCliSecretStore } from "@ccc/keychain";
import { applyMigrations, openStore } from "@ccc/operational-store";
import { getInstallSecret } from "./auth/install-secret.js";
import { createEventBus } from "./events/event-bus.js";
import { recoverInterruptedRuns } from "./lifecycle/recover-runs.js";
import { drainSpool } from "./lifecycle/spool-drain.js";
import { logger } from "./logging.js";
import { resolveDbPath, resolveRuntimeDir, resolveSocketPath, resolveSpoolPath } from "./paths.js";
import { createRequestListener } from "./routes.js";
import { startSocketServer } from "./socket-server.js";

/**
 * The default interval between the service's own `service.heartbeat`
 * events. Overridable via `CCC_HEARTBEAT_INTERVAL_MS` so an integration
 * test can observe a push within its own timeout without waiting thirty
 * real seconds.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

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

  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

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

  const requestListener = createRequestListener({
    store,
    getSecret: () => installSecret,
    eventBus,
  });
  const server = await startSocketServer({ socketPath, requestListener });

  logger.info({ socketPath }, "listening");

  const shutdown = (): void => {
    clearInterval(heartbeatTimer);
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
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
