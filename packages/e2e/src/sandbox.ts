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
  appendPidOnce,
  findLeaks,
  findRunRootProcesses,
  type Leak,
  type LedgerEntry,
  type ProcessEntry,
  readLedger,
  type SweepOutcome,
} from "./ledger.js";
import { readProcessTable } from "./process-table.js";
import { createRunRoot, type RunRootPaths, removeRunRoot } from "./run-root.js";
import { isSignalablePid, matchesLedgeredProcess, runStaleSweep, terminateByPid } from "./sweep.js";

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
  /** Ledgers a service pid the moment it spawns, before its socket is ready (MEDIUM-2b). */
  recordSpawn(pid: number, marker?: string): Promise<void>;
  registerAccount(account: string): Promise<void>;
  registerDir(path: string): Promise<void>;
  /** Drops a handle that has already exited so teardown does not wait on it again. */
  unregister(handle: Stoppable): void;
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
  /** The pid-based TERM used for ledgered leftovers; defaults to the sweep's single signal. */
  sendTerm?: (pid: number) => Promise<void>;
  /** Where SIGINT and SIGTERM are caught so an interrupted run still tears down. */
  signals?: SignalSource;
  /** Called with 128 + signal number after a signal-driven teardown; defaults to process.exit. */
  exit?: (code: number) => void;
}

export interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown;
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

/**
 * SIGTERM through the handle, then kill after the deadline when it has not exited. A rejected
 * stop counts as not exited, and kill has its own deadline: a process that survives both makes
 * this throw so the caller records it instead of hanging the teardown (Wave 2 review LOW-2).
 */
export async function stopWithDeadline(
  handle: Stoppable,
  wait: (ms: number) => Promise<void>,
  deadlineMs: number,
): Promise<void> {
  const attempt = async (step: () => Promise<void>): Promise<boolean> => {
    try {
      await step();
      return true;
    } catch {
      return false;
    }
  };
  const stopped = attempt(() => handle.stop());
  if (await Promise.race([stopped, wait(deadlineMs).then(() => false)])) return;
  const killed = attempt(() => handle.kill());
  if (!(await Promise.race([killed, wait(deadlineMs).then(() => false)]))) {
    throw new Error("A process did not exit after stop and kill; it is reported as a leak.");
  }
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
  const readTable = options.readTable ?? (() => readProcessTable());
  const deleteAccount = options.deleteAccount ?? ((account: string) => deleteUatAccount(account));
  const wait = options.wait ?? realWait;
  const deadlineMs = options.stopDeadlineMs ?? STOP_DEADLINE_MS;
  const ownerPid = options.ownerPid ?? process.pid;
  const now = options.now ?? (() => new Date());

  const sweepFn: SweepFn = options.sweep ?? runStaleSweep;
  const sweep: SweepOutcome = await sweepFn({
    base,
    home: options.home,
    readTable,
    deleteAccount,
    wait,
    selfPid: ownerPid,
  });
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
      appendPidOnce(paths.ledgerPath, entry);
    },
    async recordSpawn(pid, marker) {
      const row = (await readTable()).find((entry) => entry.pid === pid);
      appendPidOnce(paths.ledgerPath, {
        kind: "pid",
        role: "service",
        pid,
        start: row?.start ?? "",
        ...(marker === undefined ? {} : { marker }),
      });
    },
    async registerAccount(extra) {
      assertUatAccount(extra);
      if (accounts.has(extra)) return;
      accounts.add(extra);
      appendLedger(paths.ledgerPath, { kind: "account", account: extra });
    },
    unregister(handle) {
      const at = processes.findIndex((entry) => entry.handle === handle);
      if (at >= 0) processes.splice(at, 1);
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

  const sendTerm = options.sendTerm ?? terminateByPid;

  /**
   * Ledgered leftovers: first record every process still naming the run root (Obsidian and its
   * helpers are launched by the wdio service and never ledgered) with its start time, then
   * TERM only the ledgered pids whose pid, start time and marker still match a fresh table.
   * Never the runner itself. No uncatchable signal is sent by pid; a survivor stays a leak.
   */
  async function terminateLedgered(): Promise<void> {
    const table = await readTable();
    const known = readLedger(paths.ledgerPath);
    for (const row of findRunRootProcesses(table, paths.root, ownerPid)) {
      const full = table.find((candidate) => candidate.pid === row.pid);
      if (full === undefined || full.start === "") continue;
      const already = known.some(
        (entry) => entry.kind === "pid" && entry.pid === full.pid && entry.start === full.start,
      );
      if (!already) {
        appendLedger(paths.ledgerPath, {
          kind: "pid",
          role: "leftover",
          pid: full.pid,
          start: full.start,
          marker: paths.root,
        });
      }
    }
    const fresh = await readTable();
    const sent: number[] = [];
    for (const entry of readLedger(paths.ledgerPath)) {
      if (entry.kind !== "pid" || entry.pid === ownerPid || !isSignalablePid(entry.pid)) continue;
      if (sent.includes(entry.pid)) continue;
      const row = fresh.find((candidate) => matchesLedgeredProcess(candidate, entry));
      if (row === undefined) continue;
      try {
        await sendTerm(entry.pid);
        sent.push(entry.pid);
      } catch (err) {
        cleanupErrors.push(asError(err));
      }
    }
    if (sent.length > 0) await wait(deadlineMs);
  }

  let tornDown: Promise<void> | undefined;
  function teardown(): Promise<void> {
    tornDown ??= (async () => {
      for (const { handle } of [...processes].reverse()) {
        try {
          await stopWithDeadline(handle, wait, deadlineMs);
        } catch (err) {
          cleanupErrors.push(asError(err));
        }
      }
      try {
        await terminateLedgered();
      } catch (err) {
        cleanupErrors.push(asError(err));
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
        const ledgered = findLeaks(readLedger(paths.ledgerPath), table);
        const seen = new Set(ledgered.map((leak) => leak.pid));
        leaks = [
          ...ledgered,
          ...findRunRootProcesses(table, paths.root, ownerPid).filter(
            (leak) => !seen.has(leak.pid),
          ),
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
    })();
    return tornDown;
  }

  const signals: SignalSource = options.signals ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const onInterrupt = (code: number) => () => {
    void teardown().finally(() => exit(code));
  };
  const onSigint = onInterrupt(130);
  const onSigterm = onInterrupt(143);
  signals.on("SIGINT", onSigint);
  signals.on("SIGTERM", onSigterm);
  try {
    value = await body(sandbox);
  } catch (err) {
    failed = true;
    error = err;
  } finally {
    try {
      await teardown();
    } finally {
      signals.off("SIGINT", onSigint);
      signals.off("SIGTERM", onSigterm);
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
