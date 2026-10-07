import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TASK_COUNTS_PATH, VAULT_SETUP_PATH } from "@ccc/domain";
import {
  authedRequest,
  collectEvents,
  handshake,
  tearDownServiceEnvironment,
} from "./approval-int-support.js";
import { startServiceForTest, type TestServiceHandle } from "./service-harness.js";
import type { GeneratedTaskVault } from "./task-fixtures.js";

/**
 * Support for the plan 06-25 integration suites that drive the REAL built
 * service over its socket against a generated task vault. Every service is
 * started on a throwaway runtime directory with a short socket path and a
 * throwaway Keychain account, and is stopped by `close()`. Test code only.
 */

export interface TaskServiceReply<T> {
  readonly status: number;
  readonly body: T;
}

export interface TaskServiceSession {
  readonly dir: string;
  readonly socketPath: string;
  /** An authenticated POST with a JSON body. */
  post<T>(path: string, body: unknown): Promise<TaskServiceReply<T>>;
  /** An authenticated GET. */
  get<T>(path: string): Promise<TaskServiceReply<T>>;
  /** Stops the service, starts it again on the same runtime directory and answers how long the first counts request took from the start. */
  restart(): Promise<{ readonly firstCountsMs: number }>;
  /** Resident set size of the running service in kilobytes. */
  rssKb(): number;
  /** The service's own log lines, parsed. */
  logLines(): Record<string, unknown>[];
  /** Opens one event subscription. */
  collectEvents(): { readonly events: { readonly type: string }[]; close(): void };
  /** Stops the service and removes the throwaway runtime directory and Keychain account. */
  close(): Promise<void>;
}

export interface TaskServiceOptions {
  /** True: register the vault and restart, so the boot walk fills the index. False: register only; the index stays empty until a rebuild. */
  readonly bootWalk: boolean;
}

const TEST_BASE = join(homedir(), ".ccc-test");
const ZONE = "UTC";

/** Starts the real service on a throwaway runtime directory with the vault registered. Call `close()` when done. */
export async function startTaskService(
  vault: GeneratedTaskVault,
  options: TaskServiceOptions,
): Promise<TaskServiceSession> {
  mkdirSync(TEST_BASE, { recursive: true });
  const dir = mkdtempSync(join(TEST_BASE, "s-"));
  const socketPath = join(dir, "svc.sock");
  const account = `install-secret-test-${randomBytes(6).toString("hex")}`;
  const env = {
    CCC_INSTALL_SECRET_ACCOUNT: account,
    CCC_HEARTBEAT_INTERVAL_MS: "150",
    CCC_LIVENESS_SWEEP_MS: "200",
    CCC_LIVENESS_GRACE_MS: "500",
    CLAUDE_CONFIG_DIR: join(dir, "claude"),
  };
  mkdirSync(join(dir, "claude", "projects"), { recursive: true });

  let handle: TestServiceHandle | null = null;
  let token = "";

  const start = async (): Promise<void> => {
    handle = await startServiceForTest({
      socketPath,
      dbPath: join(dir, "operational.db"),
      env,
    });
    token = await handshake(socketPath);
  };
  const stop = async (): Promise<void> => {
    const running = handle;
    handle = null;
    if (running !== null) await running.stop();
  };
  const post = <T>(path: string, body: unknown): Promise<TaskServiceReply<T>> =>
    authedRequest<T>(socketPath, token, { method: "POST", path, body });

  const get = <T>(path: string): Promise<TaskServiceReply<T>> =>
    authedRequest<T>(socketPath, token, { method: "GET", path });

  try {
    await start();
    const setup = await post<unknown>(VAULT_SETUP_PATH, { vaultRoot: vault.vaultRoot });
    if (setup.status !== 200) throw new Error(`vault setup answered ${setup.status}`);
    if (options.bootWalk) {
      await stop();
      await start();
    }
  } catch (error: unknown) {
    await (handle as TestServiceHandle | null)?.kill();
    tearDownServiceEnvironment(account);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  return {
    dir,
    socketPath,
    post,
    get,
    async restart() {
      await stop();
      const started = performance.now();
      await start();
      const counts = await post<unknown>(TASK_COUNTS_PATH, {
        context: { scope: "all" },
        zone: ZONE,
      });
      if (counts.status !== 200) throw new Error(`counts answered ${counts.status}`);
      return { firstCountsMs: performance.now() - started };
    },
    rssKb() {
      const pid = (handle as TestServiceHandle | null)?.pid;
      if (pid === undefined) throw new Error("no running service");
      return Number(
        execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim(),
      );
    },
    logLines() {
      return readFileSync(join(dir, "logs", "service.log"), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    collectEvents() {
      return collectEvents(socketPath, token);
    },
    async close() {
      await handle?.kill();
      handle = null;
      tearDownServiceEnvironment(account);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** {@link startTaskService} with the teardown guaranteed. */
export async function withTaskService<T>(
  vault: GeneratedTaskVault,
  options: TaskServiceOptions,
  fn: (session: TaskServiceSession) => Promise<T>,
): Promise<T> {
  const session = await startTaskService(vault, options);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}
