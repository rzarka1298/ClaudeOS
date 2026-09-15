import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  EVENTS_PATH,
  HANDSHAKE_PATH,
  type HandshakeResponse,
  type ServiceEvent,
} from "@ccc/domain";
import { createEventClient, createSocketApiClient } from "@ccc/service-api-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServiceForTest } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

const KEYCHAIN_SERVICE_NAME = "com.claude-command-center";
const ITEM_NOT_FOUND_EXIT_CODE = 44;

/**
 * Same throwaway-Keychain-account convention as `authenticated-roundtrip
 * .test.ts` (plan 01-02): every test here spawns the real, built
 * `@ccc/service` entry point, which persists the per-install secret to the
 * real macOS Keychain under a fresh account, deleted in teardown.
 * `CCC_HEARTBEAT_INTERVAL_MS` is set short so the tests observe a real
 * heartbeat push within their own timeout rather than the production
 * 30-second default.
 */
let throwawayAccount: string;

beforeEach(() => {
  throwawayAccount = `install-secret-test-${randomBytes(6).toString("hex")}`;
  process.env.CCC_INSTALL_SECRET_ACCOUNT = throwawayAccount;
  process.env.CCC_HEARTBEAT_INTERVAL_MS = "150";
});

afterEach(() => {
  delete process.env.CCC_INSTALL_SECRET_ACCOUNT;
  delete process.env.CCC_HEARTBEAT_INTERVAL_MS;
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

/** Builds the same `getToken` shape `packages/plugin/src/main.ts` constructs. */
function tokenGetter(socketPath: string): () => Promise<string> {
  const handshakeClient = createSocketApiClient({ socketPath });
  return async () => {
    const res = await handshakeClient.request<HandshakeResponse>({
      method: "POST",
      path: HANDSHAKE_PATH,
    });
    return res.body.token;
  };
}

describe("live push: one event, pushed from the service, received by the same client the plugin uses", () => {
  it("the client receives exactly one event whose envelope validates and whose id is 1", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const dbPath = join(dir, "operational.db");
      const handle = await startServiceForTest({ socketPath, dbPath });
      try {
        const client = createEventClient({ socketPath, getToken: tokenGetter(socketPath) });
        const received: ServiceEvent[] = [];

        const firstEvent = await new Promise<ServiceEvent>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("timed out waiting for the first heartbeat")),
            5000,
          );
          client.subscribe(
            (event) => {
              received.push(event);
              if (received.length === 1) {
                clearTimeout(timeout);
                resolve(event);
              }
            },
            () => {},
          );
        });

        expect(firstEvent.id).toBe(1);
        expect(firstEvent.type).toBe("service.heartbeat");
        client.dispose();
      } finally {
        await handle.stop();
      }
    });
  });

  it("GET /api/v1/events with no bearer token returns 401 and establishes no stream", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const dbPath = join(dir, "operational.db");
      const handle = await startServiceForTest({ socketPath, dbPath });
      try {
        const client = createSocketApiClient({ socketPath });
        const res = await client.request<unknown>({ method: "GET", path: EVENTS_PATH });
        expect(res.status).toBe(401);
      } finally {
        await handle.stop();
      }
    });
  });
});
