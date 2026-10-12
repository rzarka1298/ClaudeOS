import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createApprovalsClient, createAuthenticatedClient } from "@ccc/service-api-client";
import { realSocketPath, realStorePath } from "./isolation-guards.js";
import { type SandboxHandle, type SandboxOutcome, withSandbox } from "./sandbox.js";
import { createServiceFixture } from "./service-fixture.js";
import { copyStore, queryStore } from "./store-copy.js";

/**
 * The GUI-free end-to-end check of the sandbox (05.2-09, S6, E2E-03, T-05.2-39): inside the
 * sandbox it starts the throwaway service, handshakes, proposes a test approval, finds it in the
 * list, reads a copy of the throwaway store and stops the service; the sandbox then deletes the
 * account, checks for leaks and removes the run root. Around all of it the owner's real store
 * file and real socket are fingerprinted before and after, and any difference fails the check.
 * The fingerprint only hashes the bytes of one file and reads one file status; the owner's real
 * store is never opened with a database tool and nothing under the real runtime folder is
 * written. Output lines are fixed phrases with counts.
 */

export interface Fingerprint {
  /** SHA-256 of the owner's real store file bytes, or null when there is no file. */
  storeHash: string | null;
  /** Modification time of the owner's real socket, or null when there is none. */
  socketMtimeMs: number | null;
  /** Whether the owner's real service socket exists. */
  running: boolean;
}

export interface PreflightPorts {
  runSandbox: <T>(body: (sandbox: SandboxHandle) => Promise<T>) => Promise<SandboxOutcome<T>>;
  startService: (sandbox: SandboxHandle) => Promise<{ stop: () => Promise<void> }>;
  /** Handshakes and reads the approvals list; throws when either fails. */
  handshake: (socketPath: string) => Promise<void>;
  proposeTestApproval: (socketPath: string) => Promise<string>;
  pendingIds: (socketPath: string) => Promise<string[]>;
  /** Copies the throwaway store, reads the copy read-only and returns the audit row count. */
  auditRows: (sandbox: SandboxHandle) => Promise<number>;
  fingerprint: () => Promise<Fingerprint>;
}

export interface PreflightOptions {
  requireRealService: boolean;
}

export interface PreflightOutcome {
  ok: boolean;
  lines: string[];
}

export const AUDIT_COUNT_SQL = "select count(*) as audit_rows from approval_audit;";

export async function runPreflight(
  options: PreflightOptions,
  ports: PreflightPorts,
): Promise<PreflightOutcome> {
  const lines: string[] = [];
  let ok = true;
  const fail = (line: string): void => {
    ok = false;
    lines.push(`fail: ${line}`);
  };

  const before = await ports.fingerprint();
  const outcome = await ports.runSandbox(async (sandbox) => {
    const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch {
        fail(name);
        throw new Error(name);
      }
    };
    const socket = sandbox.paths.socketPath;
    const service = await step("the throwaway service did not start", () =>
      ports.startService(sandbox),
    );
    lines.push("ok: throwaway service started");
    await step("the handshake failed", () => ports.handshake(socket));
    lines.push("ok: handshake succeeded");
    const proposalId = await step("the test approval could not be created", () =>
      ports.proposeTestApproval(socket),
    );
    const pending = await step("the approvals list could not be read", () =>
      ports.pendingIds(socket),
    );
    if (!pending.includes(proposalId)) {
      fail("the test approval is not in the list");
      throw new Error("the test approval is not in the list");
    }
    lines.push("ok: test approval created and listed");
    const rows = await step("the store copy could not be read", () => ports.auditRows(sandbox));
    if (rows < 1) {
      fail("the store copy shows no audit row");
      throw new Error("the store copy shows no audit row");
    }
    lines.push(`ok: store copy read read-only, ${rows} audit row(s)`);
    await step("the service did not stop", () => service.stop());
    lines.push("ok: service stopped");
  });

  if (outcome.error !== undefined && ok) fail("the sandbox body failed");
  if (outcome.leaks.length > 0) fail(`${outcome.leaks.length} leaked process(es) after teardown`);
  if (outcome.cleanupErrors.length > 0) fail(`${outcome.cleanupErrors.length} cleanup error(s)`);
  if (!outcome.runRootRemoved) fail("the run root was not removed");
  if (outcome.leaks.length === 0 && outcome.cleanupErrors.length === 0 && outcome.runRootRemoved) {
    lines.push("ok: teardown clean, account deleted, no leak, run root removed");
  }

  const after = await ports.fingerprint();
  if (!before.running || !after.running) {
    if (options.requireRealService) fail("the real service is not running, nothing to compare");
    else lines.push("note: the real service is not running; nothing to compare");
  } else if (before.storeHash !== after.storeHash || before.socketMtimeMs !== after.socketMtimeMs) {
    fail("real store or socket changed during the preflight");
  } else {
    lines.push("ok: real store and socket unchanged");
  }
  return { ok, lines };
}

function approvals(socketPath: string) {
  return createApprovalsClient(createAuthenticatedClient({ socketPath }));
}

export function createPreflightPorts(): PreflightPorts {
  return {
    runSandbox: (body) => withSandbox({}, body),
    startService: async (sandbox) => {
      const fixture = createServiceFixture(sandbox);
      await fixture.start();
      return { stop: () => fixture.stop() };
    },
    handshake: async (socketPath) => {
      await approvals(socketPath).list();
    },
    proposeTestApproval: async (socketPath) => (await approvals(socketPath).test()).proposalId,
    pendingIds: async (socketPath) =>
      (await approvals(socketPath).list()).pending.map((entry) => entry.proposalId),
    auditRows: async (sandbox) => {
      const { copyPath } = copyStore({
        runtimeDir: sandbox.paths.runtimeDir,
        destDir: join(sandbox.paths.tmpDir, "preflight"),
        runRoot: sandbox.paths.root,
      });
      const rows = await queryStore({
        copyPath,
        sql: AUDIT_COUNT_SQL,
        runRoot: sandbox.paths.root,
      });
      return Number(rows[0]?.audit_rows ?? 0);
    },
    fingerprint: async () => {
      const storePath = realStorePath();
      const socketPath = realSocketPath();
      let storeHash: string | null = null;
      try {
        storeHash = createHash("sha256").update(readFileSync(storePath)).digest("hex");
      } catch {
        storeHash = null;
      }
      let socketMtimeMs: number | null = null;
      try {
        socketMtimeMs = statSync(socketPath).mtimeMs;
      } catch {
        socketMtimeMs = null;
      }
      return { storeHash, socketMtimeMs, running: socketMtimeMs !== null };
    },
  };
}
