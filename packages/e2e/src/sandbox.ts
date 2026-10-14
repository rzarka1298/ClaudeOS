import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
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
  wait?: Wait;
  stopDeadlineMs?: number;
  sweep?: SweepFn;
  /** The pid-based TERM used for ledgered leftovers; defaults to the sweep's single signal. */
  sendTerm?: (pid: number) => Promise<void>;
  /** Where SIGINT and SIGTERM are caught so an interrupted run still tears down. */
  signals?: SignalSource;
  /**
   * Called once teardown has stopped everything (the runner-kills log is complete) and before the
   * run root is removed, so a caller can keep what lives under it (the wdio logs). A throw is
   * recorded as a cleanup error and never stops the removal.
   */
  beforeRemove?: (info: {
    root: string;
    wdioDir: string;
    runtimeDir: string;
    runId: string;
  }) => void;
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

/** A cancellable pause. Aborting resolves it at once and clears the timer. */
export type Wait = (ms: number, signal?: AbortSignal) => Promise<void>;

/**
 * The real pause. The timer is REFERENCED: teardown awaits it, and an unreferenced timer let
 * Node exit with the Keychain deletion, leak check and exit code still pending (Codex finding 1).
 * Callers that race it against something else pass a signal and abort it when they are done, so
 * no deadline timer outlives the cleanup.
 */
export const realWait: Wait = (ms, signal) =>
  new Promise((done) => {
    if (signal?.aborted === true) {
      done();
      return;
    }
    const timer = setTimeout(done, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

const OBSIDIAN_APP_PREFIX = "/Applications/Obsidian.app/Contents/";

/**
 * True only for a process the sandbox itself launched: the installed Obsidian (or one of its
 * helpers) started with this run's own `--user-data-dir`, or a chromedriver whose command line
 * names this run root. A process that merely mentions the run root (an observer's `tail -f`, a
 * watcher loop, an editor) is not the runner's to signal.
 */
export function isSandboxLaunched(command: string, runRoot: string): boolean {
  const names = (flag: string): boolean => {
    for (let at = command.indexOf(flag); at >= 0; at = command.indexOf(flag, at + 1)) {
      const after = command.slice(at + flag.length);
      if (after.startsWith(runRoot) && /^(?:$|[\s/])/.test(after.slice(runRoot.length)))
        return true;
    }
    return false;
  };
  if (command.startsWith(OBSIDIAN_APP_PREFIX)) return names("--user-data-dir=");
  const executable = command.split(/\s/)[0] ?? "";
  return executable.split("/").pop() === "chromedriver" && names("=");
}

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
  wait: Wait,
  deadlineMs: number,
): Promise<void> {
  const controller = new AbortController();
  try {
    await stopOrKill(handle, wait, deadlineMs, controller.signal);
  } finally {
    controller.abort();
  }
}

async function stopOrKill(
  handle: Stoppable,
  wait: Wait,
  deadlineMs: number,
  signal: AbortSignal,
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
  if (await Promise.race([stopped, wait(deadlineMs, signal).then(() => false)])) return;
  const killed = attempt(() => handle.kill());
  if (!(await Promise.race([killed, wait(deadlineMs, signal).then(() => false)]))) {
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
  let accountCleanupFailed = false;

  const sendTerm = options.sendTerm ?? terminateByPid;

  /**
   * Ledgered leftovers: first record every sandbox-launched process still naming the run root
   * (Obsidian, its helpers and chromedriver are launched by the wdio service and never ledgered) with its start time, then
   * TERM only the ledgered pids whose pid, start time and marker still match a fresh table.
   * Never the runner itself. No uncatchable signal is sent by pid; a survivor stays a leak.
   */
  function logKill(pid: number, role: string, start: string): void {
    const reason =
      role === "leftover" ? "teardown-run-root-leftover" : "teardown-ledgered-identity";
    try {
      mkdirSync(paths.wdioDir, { recursive: true });
      appendFileSync(
        join(paths.wdioDir, "runner-kills.log"),
        `${new Date().toISOString()} pid=${pid} role=${role} start=${start} reason=${reason}\n`,
        { mode: 0o600 },
      );
    } catch {
      // logging must never stop a cleanup
    }
  }

  async function terminateLedgered(): Promise<void> {
    const table = await readTable();
    const known = readLedger(paths.ledgerPath);
    for (const row of findRunRootProcesses(table, paths.root, ownerPid)) {
      const full = table.find((candidate) => candidate.pid === row.pid);
      if (full === undefined || full.start === "") continue;
      // Only processes the sandbox itself launched are adopted. Anything else that merely names
      // the run root (an observer's `tail -f`, an until-loop, an editor) stays a reported leak
      // and is never signalled (the same policy as the stale sweep's "manual" list).
      if (!isSandboxLaunched(full.command, paths.root)) continue;
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
        // Every signal is logged BEFORE it is sent, into the wdio folder the runner keeps, so a
        // session that dies can be matched against runner kills (exact pid + start time only).
        logKill(entry.pid, entry.role, entry.start);
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
          accountCleanupFailed = true;
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
        options.beforeRemove?.({
          root: paths.root,
          wdioDir: paths.wdioDir,
          runtimeDir: paths.runtimeDir,
          runId: paths.runId,
        });
      } catch (err) {
        cleanupErrors.push(asError(err));
      }
      try {
        // A leftover Keychain account keeps the ledger: the next start's sweep needs it to retry
        // the deletion (Codex finding 5).
        if (leaks.length === 0 && !accountCleanupFailed) {
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
