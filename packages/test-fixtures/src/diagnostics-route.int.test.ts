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
import { afterEach, describe, expect, it } from "vitest";
import { authedRequest, handshake } from "./approval-int-support.js";
import { type DrillContext, pollHealth, withDrillService } from "./diagnostics-drill-kit.js";

/**
 * Plan 08-07 (D-02, D-04, D-05, D-36; DIAG-02): the REAL built service process answers the
 * diagnostics health route through the real authenticated client. The service runs in a
 * temporary folder with its own runtime directory, its own scratch Claude config folder, the
 * Codex isolation variables the harness sets, and a throwaway install-secret account (the
 * established harness convention); it never reads the owner's real folders.
 */

/**
 * The service runs through the drill kit: its own runtime folder, scratch Claude config folder,
 * Codex isolation variables, a nonexistent research-key test account (so a `gesture` check never
 * reaches the owner's real research key), and a preload that records non-loopback connections and
 * child processes.
 */
async function withService<T>(
  fn: (running: { socketPath: string; dir: string; context: DrillContext }) => Promise<T>,
): Promise<T> {
  return withDrillService((context) =>
    fn({ socketPath: context.socketPath, dir: context.dir, context }),
  );
}

describe("Test 1 (tracer, real process): the strict health answer", () => {
  it("a fresh install answers five setup-needed rows, zero failing and zero degraded, keychain presence and zero counts", async () => {
    await withService(async ({ socketPath, dir, context }) => {
      const client = createAuthenticatedClient({ socketPath });

      // Before any owner gesture a reconnect never asks the Keychain about the research key
      // (Amendment A1): the scheduler reads unknown / research-key-not-checked and so does the key.
      const reconnect = await getDiagnosticsHealth(client, "reconnect");
      expect(reconnect.keychain.researchKey).toBe("unknown");
      expect(reconnect.rows[3]).toMatchObject({ id: "scheduler", status: "unknown" });
      const reconnectKey = (
        reconnect.rows[3] as unknown as { parts: { partId: string; reasonCode: string }[] }
      ).parts.find((part) => part.partId === "research-key");
      expect(reconnectKey?.reasonCode).toBe("research-key-not-checked");
      expect(context.researchKeySpawns()).toEqual([]);

      const health = await getDiagnosticsHealth(client, "gesture");

      // The client already parsed it; the raw call proves the wire body parses on its own too.
      const raw = await client.request<unknown>({
        method: "GET",
        path: `${DIAGNOSTICS_HEALTH_PATH}?trigger=gesture`,
      });
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
      expect(health.rows.map((row) => row.status)).toEqual(Array(5).fill("setup-needed"));
      expect(
        health.rows.filter((row) => row.status === "failing" || row.status === "degraded"),
      ).toEqual([]);
      expect(health.rows.every((row) => row.freshness === "live")).toBe(true);
      expect(hooks).toMatchObject({ id: "hooks", reasonCode: "hooks-not-installed" });
      expect(collectors).toMatchObject({ id: "collectors" });
      expect(scheduler).toMatchObject({ id: "scheduler" });
      expect(launchers).toMatchObject({ id: "launchers", reasonCode: "launcher-not-set-up" });
      const schedulerParts = (
        scheduler as unknown as { parts: { partId: string; reasonCode: string }[] }
      ).parts;
      expect(schedulerParts.find((part) => part.partId === "research-key")?.reasonCode).toBe(
        "research-key-missing",
      );
      expect(schedulerParts.find((part) => part.partId === "last-run")?.reasonCode).toBe(
        "never-run",
      );

      // Presence only: the install secret is the service's own startup read, the research key is a
      // nonexistent test account (never the owner's key).
      expect(health.keychain).toEqual({ installSecret: "present", researchKey: "absent" });
      expect(health.counts).toEqual({ projects: 0, scanFolders: 0, openTasks: 0, reports: 0 });

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

      // The gesture asked the Keychain about the nonexistent test account, exactly once per run of
      // the probes (the scheduler row and keychain.researchKey share one read), and made no
      // outbound connection.
      expect(context.researchKeySpawns().length).toBeGreaterThanOrEqual(1);
      expect(context.outbound()).toEqual([]);
    });
  });

  it("N reconnect health calls start zero security processes for the research key; one gesture starts one", async () => {
    await withService(async ({ context }) => {
      // Positive control: the recorder sees the service's own startup spawns (the install secret
      // lookup goes through security), so an empty research-key list below is not a blind recorder.
      const sawSecurity = context
        .events()
        .some((event) => event.kind === "spawn" && event.file.endsWith("/security"));
      expect(sawSecurity).toBe(true);

      for (let i = 0; i < 3; i += 1) {
        await pollHealth(context, () => true, { trigger: "reconnect" });
        await new Promise((resolve) => setTimeout(resolve, 2200)); // past the 2 s cache
      }
      expect(context.researchKeySpawns()).toEqual([]);

      await context.health("gesture");
      expect(context.researchKeySpawns()).toHaveLength(1);

      // A later reconnect reuses the gesture's answer: no new process, and the key reads absent.
      await new Promise((resolve) => setTimeout(resolve, 2200));
      const after = await context.health("reconnect");
      expect(after.keychain.researchKey).toBe("absent");
      expect(context.researchKeySpawns()).toHaveLength(1);
      expect(context.outbound()).toEqual([]);
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
