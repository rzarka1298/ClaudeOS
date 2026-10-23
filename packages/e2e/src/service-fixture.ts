import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startServiceForTest } from "@ccc/test-fixtures";
import { buildServiceEnv, refuseRealPaths, type ServiceKind } from "./isolation-guards.js";
import { SERVICE_ENTRY } from "./repo-paths.js";
import {
  isResearchGuardEnv,
  RESEARCH_TEST_ENV,
  type ResearchGuardEnv,
} from "./research-uat-fixture.js";
import type { RunRootPaths } from "./run-root.js";
import {
  realWait,
  type SandboxHandle,
  STOP_DEADLINE_MS,
  type Stoppable,
  stopWithDeadline,
  type Wait,
} from "./sandbox.js";

/**
 * The throwaway service fixture (05.2-03, D-05): start, stop, restart and reset the real built
 * service inside the run root, reusing `startServiceForTest`. It never writes outside the run
 * root and checks the locations against the owner's real ones before every start. The CLI parent
 * owns the sandbox and its teardown; the fixture only registers what it starts.
 */

export interface StartOptions {
  kind?: ServiceKind;
  /**
   * The research guard variables of a Phase 7 item (plan 07-17). Accepted only when it is the
   * environment `prepareResearchUat` made, and never together with the expiry kind.
   */
  researchEnv?: ResearchGuardEnv;
  /** 100 ms polls to wait for the socket; raise it for a vault with thousands of notes. */
  waitAttempts?: number;
}

export interface StartServiceArgs {
  socketPath: string;
  dbPath: string;
  env: Record<string, string>;
  waitAttempts?: number;
  /** Called with the service pid as soon as it is spawned, before the socket is ready. */
  onSpawn?: (pid: number) => void | Promise<void>;
}

export interface ServiceFixtureDeps {
  startService?: (args: StartServiceArgs) => Promise<Stoppable>;
  wait?: Wait;
  home?: string | undefined;
  /** The allowed run-root base; tests only (production runs use the default under /tmp). */
  base?: string | undefined;
  deadlineMs?: number;
}

export type FixtureSandbox = Pick<
  SandboxHandle,
  "paths" | "account" | "registerService" | "unregister"
> & {
  recordSpawn?: SandboxHandle["recordSpawn"];
};

export interface ServiceFixture {
  start(options?: StartOptions): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  /** Stops the service and removes the store, its companions, the logs and the spool. */
  resetData(): Promise<void>;
  isRunning(): boolean;
}

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

let archiveSequence = 0;

/**
 * Moves the stopped service's log files to `kept-logs` (named by time, pid and sequence, so workers never collide) instead of deleting
 * them, so the runner can keep every service's log of the run. A new service starts a fresh log.
 */
function archiveServiceLogs(runtimeDir: string): void {
  const logs = join(runtimeDir, "logs");
  try {
    for (const name of readdirSync(logs)) {
      const from = join(logs, name);
      if (!lstatSync(from).isFile()) continue;
      const kept = join(runtimeDir, "kept-logs");
      mkdirSync(kept, { recursive: true, mode: 0o700 });
      archiveSequence += 1;
      renameSync(from, join(kept, `${Date.now()}-${process.pid}-${archiveSequence}-${name}`));
    }
  } catch {
    // No logs folder, or one that cannot be read: nothing to keep.
  }
  rmSync(logs, { recursive: true, force: true });
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

  /**
   * The isolation variables come last, so a research variable can never replace one. The one
   * exception is the research-key account: the research fixture's own empty `-research` account
   * replaces the runner's default `-nokey` account, because the research drills (07-UAT, 08-UAT
   * item 36) read and write that one. Both are nonexistent `ccc-uat-` accounts (FIX4A M2).
   */
  function serviceEnv(
    researchEnv: ResearchGuardEnv | undefined,
    kind: ServiceKind,
  ): Record<string, string> {
    const isolated = buildServiceEnv(paths, sandbox.account, kind, {
      base: deps.base,
      home: deps.home,
    });
    const research = researchEnv?.[RESEARCH_TEST_ENV.keyAccount];
    return {
      ...(researchEnv ?? {}),
      ...isolated,
      ...(research === undefined ? {} : { [RESEARCH_TEST_ENV.keyAccount]: research }),
    };
  }

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
    if (options.researchEnv !== undefined) {
      if (!isResearchGuardEnv(options.researchEnv)) {
        throw new Error("Refusing a research environment that the runner did not prepare.");
      }
      if ((options.kind ?? "normal") !== "normal") {
        throw new Error("The research environment is for the normal service kind only.");
      }
    }
    const args: StartServiceArgs = {
      socketPath: paths.socketPath,
      dbPath: paths.dbPath,
      // The isolation variables come last, so a research variable can never replace one.
      env: serviceEnv(options.researchEnv, options.kind ?? "normal"),
    };
    if (options.waitAttempts !== undefined) args.waitAttempts = options.waitAttempts;
    const record = sandbox.recordSpawn;
    if (record !== undefined) args.onSpawn = (pid) => record.call(sandbox, pid, SERVICE_ENTRY);
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
      archiveServiceLogs(paths.runtimeDir);
      rmSync(join(paths.runtimeDir, "spool"), { recursive: true, force: true });
      mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
      chmodSync(paths.runtimeDir, 0o700);
    },
    isRunning: () => current !== undefined,
  };
}
