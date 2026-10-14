import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { VAULT_SETUP_PATH } from "@ccc/domain";
import { type OperationalStore, openStore } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintToken } from "./auth/token.js";
import { createEventBus } from "./events/event-bus.js";
import { clearApprovedRoots } from "./path-allowlist.js";
import { createRequestListener } from "./routes.js";
import { startSocketServer } from "./socket-server.js";

/**
 * Runs 18 and 22 (05.2 live UAT): a vault set up AFTER the service booted never got its task
 * index built, because the only walks were the boot walk (no vault root yet) and plugin-side
 * change events. The setup route must tell the task services the vault root now exists.
 */
const TEST_BASE = join(homedir(), ".ccc-test");

function post(socketPath: string, vaultRoot: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ vaultRoot });
    const req = http.request(
      {
        socketPath,
        path: VAULT_SETUP_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

let dir: string;
let store: OperationalStore;
let server: Server;
let socketPath: string;
let token: string;
let calls: number;

beforeEach(async () => {
  clearApprovedRoots();
  mkdirSync(TEST_BASE, { recursive: true });
  dir = mkdtempSync(join(TEST_BASE, "vsx-"));
  socketPath = join(dir, "t.sock");
  mkdirSync(join(dir, "Vault", ".obsidian"), { recursive: true });
  store = openStore(join(dir, "operational.db"));
  const secret = randomBytes(32);
  token = mintToken(secret, { nowMs: Date.now() });
  calls = 0;
  server = await startSocketServer({
    socketPath,
    requestListener: createRequestListener({
      store,
      getSecret: () => secret,
      eventBus: createEventBus(),
      onVaultSetup: () => {
        calls += 1;
      },
    }),
  });
});

afterEach(() => {
  server.close();
  store.close();
  clearApprovedRoots();
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/v1/vault/setup tells the task services", () => {
  it("calls onVaultSetup after a successful setup, and again on an idempotent repeat", async () => {
    expect(await post(socketPath, join(dir, "Vault"), token)).toBe(200);
    expect(calls).toBe(1);
    expect(await post(socketPath, join(dir, "Vault"), token)).toBe(200);
    expect(calls).toBe(2);
  });

  it("does not call it when setup is refused", async () => {
    expect(await post(socketPath, join(dir, "Missing"), token)).toBeGreaterThanOrEqual(400);
    expect(calls).toBe(0);
  });
});
