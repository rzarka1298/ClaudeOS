import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import type { SecretStore } from "@ccc/keychain";
import { openStore } from "@ccc/operational-store";
import { getInstallSecret } from "./auth/install-secret.js";
import { resolveDbPath, resolveRuntimeDir, resolveSocketPath } from "./paths.js";
import { createRequestListener } from "./routes.js";
import { startSocketServer } from "./socket-server.js";

const KEYCHAIN_SERVICE_NAME = "com.claude-command-center";
const ITEM_NOT_FOUND_EXIT_CODE = 44;

/**
 * Plan 01-02 Task 1's own minimal Keychain-backed `SecretStore`, calling
 * `/usr/bin/security` directly via `execFileSync` with argument arrays
 * only (never an interpolated shell string). Task 2 replaces this with
 * the fully unit-tested `@ccc/keychain` `security-cli.ts` wrapper
 * (execa-based, exit-code-44 handling verified against a mocked
 * subprocess); it exists here only so the authenticated round-trip
 * proves real cross-restart secret persistence before that package
 * lands.
 */
function createBootstrapKeychainStore(): SecretStore {
  return {
    async get(account: string): Promise<string | null> {
      try {
        const stdout = execFileSync(
          "security",
          ["find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE_NAME, "-w"],
          { encoding: "utf8" },
        );
        return stdout.trim();
      } catch (err: unknown) {
        const status = (err as { status?: number }).status;
        if (status === ITEM_NOT_FOUND_EXIT_CODE) return null;
        throw err;
      }
    },
    async set(account: string, value: string): Promise<void> {
      execFileSync("security", [
        "add-generic-password",
        "-a",
        account,
        "-s",
        KEYCHAIN_SERVICE_NAME,
        "-w",
        value,
        "-U",
      ]);
    },
    async delete(account: string): Promise<void> {
      execFileSync("security", [
        "delete-generic-password",
        "-a",
        account,
        "-s",
        KEYCHAIN_SERVICE_NAME,
      ]);
    },
  };
}

/**
 * Composition root: resolves the runtime directory and socket/db paths,
 * opens the operational store, writes the startup record, resolves the
 * per-install secret, starts the socket server, and wires signal
 * handling. Per ADR-0001 this module never binds a numeric port and never
 * opens a network interface — the socket server it starts is the only
 * inbound surface.
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

  const secretStore = createBootstrapKeychainStore();
  const installSecret = await getInstallSecret(secretStore);

  const requestListener = createRequestListener({ store, getSecret: () => installSecret });
  const server = await startSocketServer({ socketPath, requestListener });

  // No structured logger is wired yet (Task 2 lands packages/service/src/logging.ts) — plain
  // stdout, which launchd's StandardOutPath captures per the research plist pattern.
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
