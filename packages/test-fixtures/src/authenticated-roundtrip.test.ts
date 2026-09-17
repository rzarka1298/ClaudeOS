import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HANDSHAKE_PATH,
  type HandshakeResponse,
  HandshakeResponseSchema,
  HEALTH_PATH,
  type HealthResponse,
  HealthResponseSchema,
} from "@ccc/domain";
import { createSocketApiClient } from "@ccc/service-api-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServiceForTest } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

const KEYCHAIN_SERVICE_NAME = "com.claude-command-center";
const ITEM_NOT_FOUND_EXIT_CODE = 44;

/**
 * Every test in this file spawns the real, built `@ccc/service` entry
 * point, which persists the per-install secret to the real macOS Keychain
 * (Task 2's own human-check verifies the real access-dialog behaviour —
 * this is intentional, not mocked away). To avoid ever touching, or
 * leaving behind, a real installation's own `install-secret` item, each
 * test points the service at a fresh, unique, throwaway account via
 * `CCC_INSTALL_SECRET_ACCOUNT` and deletes that Keychain item in teardown
 * regardless of outcome.
 */
let throwawayAccount: string;

beforeEach(() => {
  throwawayAccount = `install-secret-test-${randomBytes(6).toString("hex")}`;
  process.env.CCC_INSTALL_SECRET_ACCOUNT = throwawayAccount;
});

afterEach(() => {
  delete process.env.CCC_INSTALL_SECRET_ACCOUNT;
  try {
    execFileSync(
      "security",
      ["delete-generic-password", "-a", throwawayAccount, "-s", KEYCHAIN_SERVICE_NAME],
      { stdio: "ignore" },
    );
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status !== ITEM_NOT_FOUND_EXIT_CODE) throw err;
  }
});

describe("authenticated round-trip: handshake mints a token, health requires it", () => {
  it("POST /api/v1/handshake with no authorization header returns 200 and a valid handshake body", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const dbPath = join(dir, "operational.db");
      const handle = await startServiceForTest({ socketPath, dbPath });
      try {
        const client = createSocketApiClient({ socketPath });
        const res = await client.request<unknown>({ method: "POST", path: HANDSHAKE_PATH });
        expect(res.status).toBe(200);
        expect(HandshakeResponseSchema.safeParse(res.body).success).toBe(true);
      } finally {
        await handle.stop();
      }
    });
  });

  it("GET /api/v1/health with no authorization header returns 401", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const dbPath = join(dir, "operational.db");
      const handle = await startServiceForTest({ socketPath, dbPath });
      try {
        const client = createSocketApiClient({ socketPath });
        const res = await client.request<unknown>({ method: "GET", path: HEALTH_PATH });
        expect(res.status).toBe(401);
      } finally {
        await handle.stop();
      }
    });
  });

  it("GET /api/v1/health carrying the handshake token returns 200 and a valid HealthResponse", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const dbPath = join(dir, "operational.db");
      const handle = await startServiceForTest({ socketPath, dbPath });
      try {
        const client = createSocketApiClient({ socketPath });
        const handshake = await client.request<HandshakeResponse>({
          method: "POST",
          path: HANDSHAKE_PATH,
        });
        const res = await client.request<HealthResponse>({
          method: "GET",
          path: HEALTH_PATH,
          headers: { authorization: `Bearer ${handshake.body.token}` },
        });
        expect(res.status).toBe(200);
        expect(HealthResponseSchema.safeParse(res.body).success).toBe(true);
      } finally {
        await handle.stop();
      }
    });
  });

  it("a token minted before a service restart still verifies after it, because the secret is stable across restarts", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const dbPath = join(dir, "operational.db");
      let handle = await startServiceForTest({ socketPath, dbPath });
      let client = createSocketApiClient({ socketPath });
      const handshake = await client.request<HandshakeResponse>({
        method: "POST",
        path: HANDSHAKE_PATH,
      });
      await handle.stop();

      handle = await startServiceForTest({ socketPath, dbPath });
      try {
        client = createSocketApiClient({ socketPath });
        const res = await client.request<HealthResponse>({
          method: "GET",
          path: HEALTH_PATH,
          headers: { authorization: `Bearer ${handshake.body.token}` },
        });
        expect(res.status).toBe(200);
      } finally {
        await handle.stop();
      }
    });
  });

  it("the per-install secret never appears in the operational store file or any log line (SVC-09)", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const dbPath = join(dir, "operational.db");
      const handle = await startServiceForTest({ socketPath, dbPath });
      try {
        const client = createSocketApiClient({ socketPath });
        await client.request<HandshakeResponse>({ method: "POST", path: HANDSHAKE_PATH });

        // The real secret the service just generated (or reused) for this
        // throwaway account — the marker this assertion greps for.
        const secretValue = execFileSync(
          "security",
          ["find-generic-password", "-a", throwawayAccount, "-s", KEYCHAIN_SERVICE_NAME, "-w"],
          { encoding: "utf8" },
        ).trim();
        expect(secretValue.length).toBeGreaterThan(0);

        const dbBytes = readFileSync(dbPath);
        expect(dbBytes.includes(secretValue)).toBe(false);

        const logPath = join(dir, "logs", "service.log");
        if (existsSync(logPath)) {
          const logText = readFileSync(logPath, "utf8");
          expect(logText).not.toContain(secretValue);
        }
      } finally {
        await handle.stop();
      }
    });
  });
});
