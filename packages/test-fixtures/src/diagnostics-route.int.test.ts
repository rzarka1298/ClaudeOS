import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DIAGNOSTICS_HEALTH_PATH,
  DiagnosticsHealthResponseSchema,
  HEALTH_PATH,
  type HealthResponse,
  SUBSYSTEM_IDS,
  VAULT_SETUP_PATH,
} from "@ccc/domain";
import {
  createAuthenticatedClient,
  createSocketApiClient,
  getDiagnosticsHealth,
} from "@ccc/service-api-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authedRequest,
  handshake,
  setUpServiceEnvironment,
  tearDownServiceEnvironment,
} from "./approval-int-support.js";
import { startServiceForTest, type TestServiceHandle } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

/**
 * Plan 08-07 (D-02, D-04, D-05, D-36; DIAG-02): the REAL built service process answers the
 * diagnostics health route through the real authenticated client. The service runs in a
 * temporary folder with its own runtime directory, its own scratch Claude config folder, the
 * Codex isolation variables the harness sets, and a throwaway install-secret account (the
 * established harness convention); it never reads the owner's real folders.
 */

let account: string;
const started: TestServiceHandle[] = [];

beforeEach(() => {
  account = setUpServiceEnvironment();
});
afterEach(async () => {
  for (const service of started.splice(0)) await service.kill();
  tearDownServiceEnvironment(account);
});

async function withService<T>(
  fn: (running: { socketPath: string; dir: string }) => Promise<T>,
): Promise<T> {
  return withTempSocketDir(async ({ dir, socketPath }) => {
    mkdirSync(join(dir, "claude", "projects"), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
    const service = await startServiceForTest({
      socketPath,
      dbPath: join(dir, "operational.db"),
      waitAttempts: 200,
    });
    started.push(service);
    try {
      return await fn({ socketPath, dir });
    } finally {
      await service.kill();
    }
  });
}

describe("Test 1 (tracer, real process): the strict health answer", () => {
  it("answers a body the strict schema parses: the vault row set-up-needed, the other four not wired", async () => {
    await withService(async ({ socketPath, dir }) => {
      const client = createAuthenticatedClient({ socketPath });
      const health = await getDiagnosticsHealth(client);

      // The client already parsed it; the raw call proves the wire body parses on its own too.
      const raw = await client.request<unknown>({ method: "GET", path: DIAGNOSTICS_HEALTH_PATH });
      expect(raw.status).toBe(200);
      expect(DiagnosticsHealthResponseSchema.safeParse(raw.body).success).toBe(true);

      expect(health.rows.map((row) => row.id)).toEqual(
        SUBSYSTEM_IDS.filter((id) => id !== "service"),
      );
      const [vault, hooks, collectors, scheduler, launchers] = health.rows;
      expect(vault).toMatchObject({
        id: "vault",
        status: "setup-needed",
        reasonCode: "vault-not-set-up",
        freshness: "live",
        setupAction: { kind: "run-plugin-command", command: "vault-setup" },
      });
      for (const row of [hooks, collectors, scheduler, launchers]) {
        expect(row).toMatchObject({
          status: "unknown",
          reasonCode: "subsystem-not-wired",
          freshness: "live",
        });
      }

      const phase1 = await client.request<HealthResponse>({ method: "GET", path: HEALTH_PATH });
      expect(health.service.version).toBe(phase1.body.serviceVersion);
      expect(health.service.startedAt).toBe(phase1.body.startedAt);

      expect(
        health.paths.runtimeDir.startsWith("~/") || health.paths.runtimeDir.startsWith("…/"),
      ).toBe(true);
      expect(health.paths.socket.startsWith("~/") || health.paths.socket.startsWith("…/")).toBe(
        true,
      );
      expect(health.paths.vault).toBeNull();
      expect(health.vaultFingerprint).toBeNull();

      // No absolute path of the run folder or the owner's home folder anywhere in the body.
      const wire = JSON.stringify(raw.body);
      expect(wire).not.toContain(dir);
      expect(wire).not.toContain(homedir());
    });
  });

  it("answers the uniform 401 without a token and treats every trigger value as a plain read", async () => {
    await withService(async ({ socketPath }) => {
      const bare = createSocketApiClient({ socketPath });
      const unauthenticated = await bare.request<unknown>({
        method: "GET",
        path: DIAGNOSTICS_HEALTH_PATH,
      });
      expect(unauthenticated.status).toBe(401);

      const client = createAuthenticatedClient({ socketPath });
      for (const trigger of ["gesture", "reconnect"] as const) {
        const health = await getDiagnosticsHealth(client, trigger);
        expect(health.rows).toHaveLength(5);
      }
      const odd = await client.request<unknown>({
        method: "GET",
        path: `${DIAGNOSTICS_HEALTH_PATH}?trigger=bogus`,
      });
      expect(odd.status).toBe(200);
    });
  });
});

describe("Test 6 (real process): the vault row after a throwaway vault is set up", () => {
  const extraDirs: string[] = [];
  afterEach(() => {
    for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads vault-ready with a display path and a salted fingerprint, and never the root", async () => {
    await withService(async ({ socketPath }) => {
      const base = join(homedir(), ".ccc-test");
      mkdirSync(base, { recursive: true });
      const vaultRoot = mkdtempSync(join(base, "dv-"));
      extraDirs.push(vaultRoot);
      mkdirSync(join(vaultRoot, ".obsidian"), { recursive: true });

      const token = await handshake(socketPath);
      const setup = await authedRequest<unknown>(socketPath, token, {
        method: "POST",
        path: VAULT_SETUP_PATH,
        body: { vaultRoot },
      });
      expect(setup.status).toBe(200);

      const client = createAuthenticatedClient({ socketPath });
      const health = await getDiagnosticsHealth(client, "gesture");
      expect(health.rows[0]).toMatchObject({
        id: "vault",
        status: "ok",
        reasonCode: "vault-ready",
      });
      expect(health.paths.vault?.startsWith("~/")).toBe(true);
      expect(health.paths.vault).toBe(`~/.ccc-test/${vaultRoot.split("/").at(-1)}`);

      const fingerprint = health.vaultFingerprint;
      expect(fingerprint).not.toBeNull();
      const digest = createHash("sha256")
        .update(`${fingerprint?.salt}:${vaultRoot}`)
        .digest("hex")
        .slice(0, 16);
      expect(fingerprint?.digest).toBe(digest);

      const raw = await client.request<unknown>({ method: "GET", path: DIAGNOSTICS_HEALTH_PATH });
      expect(JSON.stringify(raw.body)).not.toContain(vaultRoot);
    });
  });

  it("reads vault-root-missing once the root is removed", async () => {
    await withService(async ({ socketPath }) => {
      const base = join(homedir(), ".ccc-test");
      mkdirSync(base, { recursive: true });
      const vaultRoot = mkdtempSync(join(base, "dv-"));
      extraDirs.push(vaultRoot);
      mkdirSync(join(vaultRoot, ".obsidian"), { recursive: true });
      const token = await handshake(socketPath);
      await authedRequest<unknown>(socketPath, token, {
        method: "POST",
        path: VAULT_SETUP_PATH,
        body: { vaultRoot },
      });
      rmSync(vaultRoot, { recursive: true, force: true });

      const health = await getDiagnosticsHealth(
        createAuthenticatedClient({ socketPath }),
        "gesture",
      );
      expect(health.rows[0]).toMatchObject({ status: "failing", reasonCode: "vault-root-missing" });
      expect(health.vaultFingerprint).not.toBeNull();
    });
  });
});
