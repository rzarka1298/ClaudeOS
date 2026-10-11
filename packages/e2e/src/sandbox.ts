import { resolve, sep } from "node:path";
import {
  assertUatAccount,
  DEFAULT_RUN_BASE,
  scrubInheritedEnv,
  uatAccountFor,
} from "./isolation-guards.js";
import { type CleanupResult, deleteUatAccount } from "./keychain-cleanup.js";
import {
  appendLedger,
  findLeaks,
  findRunRootProcesses,
  type Leak,
  type LedgerEntry,
  type ProcessEntry,
  readLedger,
  type SweepOutcome,
} from "./ledger.js";
import { createRunRoot, type RunRootPaths, removeRunRoot } from "./run-root.js";

/**
 * withSandbox (05.2-03, D-05, D-06): create the guarded run root, ledger the run and its
 * Keychain account BEFORE the body can create anything, run the body, and in a finally stop
 * every registered process (SIGTERM through its handle, kill after 5 seconds), delete every
 * ledgered account, check for leaks and remove the run root. Cleanup failures are collected,
 * never thrown over the body's own error. Everything takes its collaborators as parameters so
 * tests inject fakes; nothing here launches anything.
 */

export const STOP_DEADLINE_MS = 5000;

/** What registerService and registerChild accept: a handle with stop and kill, never a raw pid. */
export interface Stoppable {
  pid: number | undefined;
  stop(): Promise<void>;
  kill(): Promise<void>;
}

export interface SandboxHandle {
  paths: RunRootPaths;
  runId: string;
  account: string;
  registerService(handle: Stoppable, marker?: string): Promise<void>;
  registerChild(role: string, handle: Stoppable, marker?: string): Promise<void>;
  registerAccount(account: string): Promise<void>;
  registerDir(path: string): Promise<void>;
  readTable(): Promise<ProcessEntry[]>;
}

export interface SweepContext {
  base: string;
  home: string | undefined;
  readTable: () => Promise<ProcessEntry[]>;
  deleteAccount: (account: string) => Promise<CleanupResult>;
  wait: (ms: number) => Promise<void>;
  selfPid: number;
}

export type SweepFn = (context: SweepContext) => Promise<SweepOutcome>;

export interface SandboxOptions {
  /** Allowed parent of the run root; defaults to /tmp. A parameter for tests only. */
  base?: string | undefined;
  home?: string | undefined;
  /** The environment to check for CI and to scrub; defaults to process.env. */
  env?: Record<string, string | undefined>;
  platform?: string;
  ownerPid?: number;
  now?: () => Date;
  readTable?: () => Promise<ProcessEntry[]>;
  deleteAccount?: (account: string) => Promise<CleanupResult>;
  /** The injected timer behind the 5 second stop deadline. */
  wait?: (ms: number) => Promise<void>;
  stopDeadlineMs?: number;
  sweep?: SweepFn;
}

export interface SandboxOutcome<T> {
  ok: boolean;
  value: T | undefined;
  error: unknown;
  leaks: Leak[];
  cleanupErrors: Error[];
  runId: string;
  runRoot: string;
  runRootRemoved: boolean;
  sweep: SweepOutcome;
}

const realWait = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms).unref();
  });

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

function isStrictlyInside(outer: string, inner: string): boolean {
  const a = resolve(outer);
  const b = resolve(inner);
  return b !== a && b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`);
}

/** SIGTERM through the handle, then kill after the deadline when it has not exited. */
async function stopWithDeadline(
  handle: Stoppable,
  wait: (ms: number) => Promise<void>,
  deadlineMs: number,
): Promise<void> {
  const stopped = Promise.resolve()
    .then(() => handle.stop())
    .then(
      () => true,
      () => true,
    );
  const exited = await Promise.race([stopped, wait(deadlineMs).then(() => false)]);
  if (!exited) await handle.kill();
}

export async function withSandbox<T>(
  options: SandboxOptions,
  body: (sandbox: SandboxHandle) => Promise<T>,
): Promise<SandboxOutcome<T>> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (env.CI !== undefined && env.CI !== "") {
    throw new Error("The live UAT runner needs a GUI session and refuses to run under CI.");
  }
  if (platform !== "darwin") {
    throw new Error("The live UAT runner runs on macOS only.");
  }

  // Inherited overrides and isolation variables are scrubbed from the runner's own environment
  // before anything is started (D-05); the throwaway service gets its env from buildServiceEnv.
  const scrubbed = scrubInheritedEnv(env);
  for (const key of Object.keys(env)) {
    if (!(key in scrubbed)) delete env[key];
  }

  const base = options.base ?? DEFAULT_RUN_BASE;
  const readTable = options.readTable ?? (() => Promise.resolve<ProcessEntry[]>([]));
  const deleteAccount = options.deleteAccount ?? ((account: string) => deleteUatAccount(account));
  const wait = options.wait ?? realWait;
  const deadlineMs = options.stopDeadlineMs ?? STOP_DEADLINE_MS;
  const ownerPid = options.ownerPid ?? process.pid;
  const now = options.now ?? (() => new Date());

  const sweep: SweepOutcome = options.sweep
    ? await options.sweep({
        base,
        home: options.home,
        readTable,
        deleteAccount,
        wait,
        selfPid: ownerPid,
      })
    : { status: "none" };
  if (sweep.status === "busy") {
    throw new Error("Another UAT run is active; wait for it to finish or stop it first.");
  }

  const paths = createRunRoot({ base, home: options.home });
  const account = uatAccountFor(paths.runId);
  const processes: Array<{ role: string; handle: Stoppable }> = [];
  const accounts = new Set<string>([account]);
  const cleanupErrors: Error[] = [];

  const ownerRow = (await readTable()).find((row) => row.pid === ownerPid);
  appendLedger(paths.ledgerPath, {
    kind: "run",
    runId: paths.runId,
    runRoot: paths.root,
    startedAt: now().toISOString(),
    ownerPid,
    ownerStart: ownerRow?.start ?? "",
  });
  appendLedger(paths.ledgerPath, { kind: "account", account });

  const sandbox: SandboxHandle = {
    paths,
    runId: paths.runId,
    account,
    readTable,
    async registerService(handle, marker) {
      await sandbox.registerChild("service", handle, marker);
    },
    async registerChild(role, handle, marker) {
      processes.push({ role, handle });
      if (handle.pid === undefined) return;
      const row = (await readTable()).find((entry) => entry.pid === handle.pid);
      const entry: LedgerEntry =
        marker === undefined
          ? { kind: "pid", role, pid: handle.pid, start: row?.start ?? "" }
          : { kind: "pid", role, pid: handle.pid, start: row?.start ?? "", marker };
      appendLedger(paths.ledgerPath, entry);
    },
    async registerAccount(extra) {
      assertUatAccount(extra);
      if (accounts.has(extra)) return;
      accounts.add(extra);
      appendLedger(paths.ledgerPath, { kind: "account", account: extra });
    },
    async registerDir(path) {
      if (!isStrictlyInside(paths.root, path)) {
        throw new Error("Refusing to ledger a directory outside the run root.");
      }
      appendLedger(paths.ledgerPath, { kind: "dir", path: resolve(path) });
    },
  };

  let value: T | undefined;
  let error: unknown;
  let failed = false;
  let leaks: Leak[] = [];
  let runRootRemoved = false;
  try {
    value = await body(sandbox);
  } catch (err) {
    failed = true;
    error = err;
  } finally {
    for (const { handle } of [...processes].reverse()) {
      try {
        await stopWithDeadline(handle, wait, deadlineMs);
      } catch (err) {
        cleanupErrors.push(asError(err));
      }
    }
    for (const ledgered of accounts) {
      try {
        await deleteAccount(ledgered);
      } catch (err) {
        cleanupErrors.push(asError(err));
      }
    }
    try {
      const table = await readTable();
      leaks = [
        ...findLeaks(readLedger(paths.ledgerPath), table),
        ...findRunRootProcesses(table, paths.root, ownerPid),
      ];
    } catch (err) {
      cleanupErrors.push(asError(err));
    }
    try {
      if (leaks.length === 0) {
        removeRunRoot(paths.root, { base, home: options.home });
        runRootRemoved = true;
      } else {
        appendLedger(paths.ledgerPath, {
          kind: "leaked",
          at: now().toISOString(),
          pids: leaks.map((leak) => leak.pid),
        });
      }
    } catch (err) {
      cleanupErrors.push(asError(err));
    }
  }

  return {
    ok: !failed && leaks.length === 0 && cleanupErrors.length === 0,
    value,
    error,
    leaks,
    cleanupErrors,
    runId: paths.runId,
    runRoot: paths.root,
    runRootRemoved,
    sweep,
  };
}
