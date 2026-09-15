import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HealthResponseSchema } from "@ccc/domain";
import { openStore } from "@ccc/operational-store";
import { resolveSocketPath, SocketPathTooLongError } from "@ccc/service/paths";
import { describe, expect, it } from "vitest";
import { requestOverSocket, startServiceForTest } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

/**
 * End-to-end proof of the walking skeleton (SKELETON.md): a value written
 * to SQLite by the service is read back through a 0600 Unix domain socket
 * by the same client shape the Obsidian plugin uses. No mocking — every
 * test here spawns the real, built `@ccc/service` entry point.
 */
describe("walking skeleton: clone to a live command-center connection state", () => {
  it("Test 1: binds the socket at mode 0600 the instant it reports listening", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const dbPath = join(dir, "operational.db");
      const handle = await startServiceForTest({ socketPath, dbPath });
      try {
        expect(existsSync(socketPath)).toBe(true);
        const mode = statSync(socketPath).mode & 0o777;
        expect(mode).toBe(0o600);
      } finally {
        await handle.stop();
      }
    });
  });

  it("Test 2: GET /api/v1/health returns 200 and a body matching HealthResponse", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const dbPath = join(dir, "operational.db");
      const handle = await startServiceForTest({ socketPath, dbPath });
      try {
        const res = await requestOverSocket<unknown>(socketPath, {
          method: "GET",
          path: "/api/v1/health",
        });
        expect(res.status).toBe(200);
        const parsed = HealthResponseSchema.safeParse(res.body);
        expect(parsed.success).toBe(true);
      } finally {
        await handle.stop();
      }
    });
  });

  it("Test 3: startedAt in the health body is byte-identical to the service_meta row written at startup", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const dbPath = join(dir, "operational.db");
      const handle = await startServiceForTest({ socketPath, dbPath });
      try {
        const res = await requestOverSocket<{ startedAt: string }>(socketPath, {
          method: "GET",
          path: "/api/v1/health",
        });

        // Read the row directly from the database file the service wrote
        // to at startup — proving the value travelled store -> socket ->
        // client rather than being synthesized in the handler.
        const store = openStore(dbPath);
        const startedAtFromDb = store.readServiceMeta("started_at");
        store.close();

        expect(startedAtFromDb).not.toBeNull();
        expect(res.body.startedAt).toBe(startedAtFromDb);
      } finally {
        await handle.stop();
      }
    });
  });

  it("Test 4: unlinks a pre-existing regular file at the socket path and binds anyway", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const dbPath = join(dir, "operational.db");
      writeFileSync(socketPath, "stale, not a socket");
      const handle = await startServiceForTest({ socketPath, dbPath });
      try {
        const mode = statSync(socketPath).mode & 0o777;
        expect(mode).toBe(0o600);
      } finally {
        await handle.stop();
      }
    });
  });

  it("Test 5: resolveSocketPath() throws SocketPathTooLongError above the 104-byte sun_path cap", () => {
    const previousSocket = process.env.CCC_SOCKET_PATH;
    const previousRuntimeDir = process.env.CCC_RUNTIME_DIR;
    process.env.CCC_SOCKET_PATH = `/tmp/${"x".repeat(120)}/svc.sock`;
    try {
      expect(() => resolveSocketPath()).toThrow(SocketPathTooLongError);
    } finally {
      if (previousSocket === undefined) delete process.env.CCC_SOCKET_PATH;
      else process.env.CCC_SOCKET_PATH = previousSocket;
      if (previousRuntimeDir === undefined) delete process.env.CCC_RUNTIME_DIR;
      else process.env.CCC_RUNTIME_DIR = previousRuntimeDir;
    }
  });
});
