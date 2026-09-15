import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { openStore } from "@ccc/operational-store";
import { resolveDbPath, resolveRuntimeDir, resolveSocketPath } from "./paths.js";
import { createRequestListener } from "./routes.js";
import { startSocketServer } from "./socket-server.js";

/**
 * Composition root: resolves the runtime directory and socket/db paths,
 * opens the operational store, writes the startup record, starts the
 * socket server, and wires signal handling. Per ADR-0001 this module never
 * binds a numeric port and never opens a network interface — the socket
 * server it starts is the only inbound surface.
 */
async function main(): Promise<void> {
  const runtimeDir = resolveRuntimeDir();
  const socketPath = resolveSocketPath();
  const dbPath = resolveDbPath();

  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

  const store = openStore(dbPath);
  const startedAt = new Date().toISOString();
  store.writeServiceMeta("started_at", startedAt);
  // The walking skeleton pins the service version literally rather than
  // reading package.json at runtime (a JSON import under NodeNext module
  // resolution is an unnecessary wrinkle for Phase 1); a later phase can
  // thread the real build-time version through if it becomes load-bearing.
  store.writeServiceMeta("service_version", "0.1.0");

  const requestListener = createRequestListener({ store });
  const server = await startSocketServer({ socketPath, requestListener });

  // No structured logger is wired yet (Phase 1 stub) — plain stdout, which
  // launchd's StandardOutPath captures per the research plist pattern.
  console.log(`[ccc-service] listening on ${socketPath}`);

  const shutdown = (): void => {
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
  console.error("[ccc-service] fatal startup error", err);
  process.exit(1);
});
