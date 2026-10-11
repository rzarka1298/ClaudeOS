import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startServiceForTest } from "@ccc/test-fixtures";
import { buildServiceEnv, refuseRealPaths, type ServiceKind } from "./isolation-guards.js";
import { SERVICE_ENTRY } from "./repo-paths.js";
import type { RunRootPaths } from "./run-root.js";
import {
  type SandboxHandle,
  STOP_DEADLINE_MS,
  type Stoppable,
  stopWithDeadline,
} from "./sandbox.js";

/**
 * The throwaway service fixture (05.2-03, D-05): start, stop, restart and reset the real built
 * service inside the run root, reusing `startServiceForTest`. It never writes outside the run
 * root and checks the locations against the owner's real ones before every start. The CLI parent
 * owns the sandbox and its teardown; the fixture only registers what it starts.
 */

export interface StartOptions {
  kind?: ServiceKind;
  /** 100 ms polls to wait for the socket; raise it for a vault with thousands of notes. */
  waitAttempts?: number;
}

export interface StartServiceArgs {
  socketPath: string;
  dbPath: string;
  env: Record<string, string>;
  waitAttempts?: number;
}

export interface ServiceFixtureDeps {
  startService?: (args: StartServiceArgs) => Promise<Stoppable>;
  wait?: (ms: number) => Promise<void>;
  home?: string | undefined;
  deadlineMs?: number;
}

export type FixtureSandbox = Pick<
  SandboxHandle,
  "paths" | "account" | "registerService" | "unregister"
>;

export interface ServiceFixture {
  start(options?: StartOptions): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  /** Stops the service and removes the store, its companions, the logs and the spool. */
  resetData(): Promise<void>;
  isRunning(): boolean;
}

const realWait = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms).unref();
  });

function handleFromError(err: unknown): Stoppable | undefined {
  if (typeof err === "object" && err !== null && "handle" in err) {
    const handle = (err as { handle: unknown }).handle;
    if (
      typeof handle === "object" &&
      handle !== null &&
      typeof (handle as Stoppable).stop === "function" &&
      typeof (handle as Stoppable).kill === "function"
    ) {
      return handle as Stoppable;
    }
  }
  return undefined;
}

export function createServiceFixture(
  sandbox: FixtureSandbox,
  deps: ServiceFixtureDeps = {},
): ServiceFixture {
  const startService = deps.startService ?? ((args) => startServiceForTest(args));
  const wait = deps.wait ?? realWait;
  const deadlineMs = deps.deadlineMs ?? STOP_DEADLINE_MS;
  const paths: RunRootPaths = sandbox.paths;
  let current: Stoppable | undefined;
  let lastOptions: StartOptions = {};

  async function start(options: StartOptions = {}): Promise<void> {
    if (current !== undefined) throw new Error("The throwaway service is already running.");
    lastOptions = options;
    refuseRealPaths(
      {
        runtimeDir: paths.runtimeDir,
        socketPath: paths.socketPath,
        claudeConfigDir: paths.claudeConfigDir,
      },
      { home: deps.home },
    );
    const args: StartServiceArgs = {
      socketPath: paths.socketPath,
      dbPath: paths.dbPath,
      env: buildServiceEnv(paths, sandbox.account, options.kind ?? "normal"),
    };
    if (options.waitAttempts !== undefined) args.waitAttempts = options.waitAttempts;
    let handle: Stoppable;
    try {
      handle = await startService(args);
    } catch (err) {
      // A service that never exposed its socket still has a process: hand it to teardown.
      const orphan = handleFromError(err);
      if (orphan !== undefined) await sandbox.registerService(orphan, SERVICE_ENTRY);
      throw err;
    }
    current = handle;
    await sandbox.registerService(handle, SERVICE_ENTRY);
  }

  async function stop(): Promise<void> {
    const handle = current;
    if (handle === undefined) return;
    current = undefined;
    await stopWithDeadline(handle, wait, deadlineMs);
    sandbox.unregister(handle);
  }

  return {
    start,
    stop,
    async restart() {
      await stop();
      await start(lastOptions);
    },
    async resetData() {
      await stop();
      for (const name of [paths.dbPath, `${paths.dbPath}-wal`, `${paths.dbPath}-shm`]) {
        rmSync(name, { force: true });
      }
      for (const name of ["logs", "spool"]) {
        rmSync(join(paths.runtimeDir, name), { recursive: true, force: true });
      }
      mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
      chmodSync(paths.runtimeDir, 0o700);
    },
    isRunning: () => current !== undefined,
  };
}
