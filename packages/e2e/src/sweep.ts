import { execFile } from "node:child_process";
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { assertRunRootShape, RUN_ROOT_PREFIX } from "./isolation-guards.js";
import { type LedgerEntry, type ProcessEntry, readLedger, type SweepOutcome } from "./ledger.js";
import { removeRunRoot } from "./run-root.js";
import type { SweepContext } from "./sandbox.js";

/**
 * Stale-run sweep (05.2-03, D-06, T-05.2-12). A run root left behind by a crashed run is cleaned
 * at the next start: its Keychain account deleted, its directories removed and its still-alive
 * processes asked to terminate - but only when pid, start time AND command-line marker all match
 * the ledger, so a recycled pid is never signalled. This module holds the ONLY pid-based signal in
 * the package: TERM only, through an injected function, never an uncatchable signal. A survivor
 * is reported for the owner to stop by hand. Every other signal goes through a ChildProcess or
 * service handle.
 */

/** A run root younger than this with no run entry may be a run that is starting right now. */
export const YOUNG_ROOT_MS = 60_000;
const TERMINATE_WAIT_MS = 3000;

export interface SweepRunInput {
  runRoot: string;
  /** Age of the run root folder in milliseconds. */
  ageMs: number;
  /** The ledger, or null when it is missing or unreadable. */
  entries: LedgerEntry[] | null;
}

export type SweepAction =
  | { type: "terminate"; pid: number; role: string }
  | { type: "delete-account"; account: string }
  | { type: "remove-dir"; path: string }
  | { type: "remove-root"; path: string };

export interface SweepRunPlan {
  runRoot: string;
  actions: SweepAction[];
  /** Unledgered processes naming the run root; reported for the owner, never signalled. */
  manual: ProcessEntry[];
}

export interface SweepPlan {
  /** The run root of an active run, when one makes a new run refuse to start. */
  busy: string | null;
  runs: SweepRunPlan[];
}

export interface PlanOptions {
  base: string;
  selfPid: number;
  home?: string | undefined;
}

const sameProcess = (row: ProcessEntry, pid: number, start: string): boolean =>
  start !== "" && row.pid === pid && row.start === start;

const isStrictlyInside = (outer: string, inner: string): boolean => {
  const a = resolve(outer);
  const b = resolve(inner);
  return b !== a && b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`);
};

export function planSweep(
  runs: readonly SweepRunInput[],
  table: readonly ProcessEntry[],
  options: PlanOptions,
): SweepPlan {
  const plans: SweepRunPlan[] = [];
  for (const run of runs) {
    const entries = run.entries ?? [];
    const runEntry = entries.find((entry) => entry.kind === "run");
    const closed = entries.some((entry) => entry.kind === "closed");

    if (runEntry?.kind === "run") {
      // Active: the owner process is alive with the recorded start time (or its start time was
      // never recorded and the pid is alive, which cannot be proven stale).
      const owner = table.find((row) => row.pid === runEntry.ownerPid);
      const alive =
        owner !== undefined &&
        owner.pid !== options.selfPid &&
        (runEntry.ownerStart === "" || owner.start === runEntry.ownerStart);
      if (alive && !closed) return { busy: run.runRoot, runs: [] };
    } else if (run.ageMs < YOUNG_ROOT_MS) {
      return { busy: run.runRoot, runs: [] };
    }

    let rootOk = true;
    try {
      assertRunRootShape(run.runRoot, { base: options.base, home: options.home });
    } catch {
      rootOk = false;
    }
    if (!rootOk) {
      plans.push({ runRoot: run.runRoot, actions: [], manual: [] });
      continue;
    }

    const actions: SweepAction[] = [];
    const ledgered = new Set<number>();
    if (!closed) {
      for (const entry of [...entries].reverse()) {
        if (entry.kind !== "pid") continue;
        ledgered.add(entry.pid);
        const row = table.find((candidate) => sameProcess(candidate, entry.pid, entry.start));
        if (row !== undefined && entry.marker !== undefined && entry.marker !== "") {
          if (row.command.includes(entry.marker)) {
            actions.push({ type: "terminate", pid: entry.pid, role: entry.role });
          }
        }
      }
      for (const entry of entries) {
        if (entry.kind === "account")
          actions.push({ type: "delete-account", account: entry.account });
      }
    }
    for (const entry of entries) {
      if (entry.kind === "dir" && isStrictlyInside(run.runRoot, entry.path)) {
        actions.push({ type: "remove-dir", path: resolve(entry.path) });
      }
    }
    actions.push({ type: "remove-root", path: run.runRoot });

    const manual = table.filter(
      (row) =>
        row.pid !== options.selfPid && !ledgered.has(row.pid) && row.command.includes(run.runRoot),
    );
    plans.push({ runRoot: run.runRoot, actions, manual });
  }
  return { busy: null, runs: plans };
}

export interface SweepDeps {
  sendTerm: (pid: number) => Promise<void>;
  deleteAccount: (account: string) => Promise<unknown>;
  removeDir: (path: string) => void;
  removeRunRoot: (path: string) => void;
  readTable: () => Promise<ProcessEntry[]>;
  wait: (ms: number) => Promise<void>;
}

export async function executeSweep(plan: SweepPlan, deps: SweepDeps): Promise<SweepOutcome> {
  if (plan.busy !== null) return { status: "busy", runRoot: plan.busy };
  if (plan.runs.length === 0) return { status: "none" };

  const terminated: number[] = [];
  const accountsDeleted: string[] = [];
  const removed: string[] = [];
  const stillAlive: string[] = [];
  const errors: string[] = [];
  const attempt = async (what: string, step: () => unknown): Promise<boolean> => {
    try {
      await step();
      return true;
    } catch (err) {
      errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  for (const run of plan.runs) {
    const signalled: Array<{ pid: number; start: string }> = [];
    const before = run.actions.some((a) => a.type === "terminate") ? await deps.readTable() : [];
    for (const action of run.actions) {
      if (action.type !== "terminate") continue;
      const row = before.find((candidate) => candidate.pid === action.pid);
      if (await attempt(`terminate ${action.pid}`, () => deps.sendTerm(action.pid))) {
        terminated.push(action.pid);
        if (row !== undefined) signalled.push({ pid: row.pid, start: row.start });
      }
    }
    let survivors = 0;
    if (signalled.length > 0) {
      await deps.wait(TERMINATE_WAIT_MS);
      const after = await deps.readTable();
      for (const sent of signalled) {
        if (after.some((row) => sameProcess(row, sent.pid, sent.start))) {
          stillAlive.push(`pid ${sent.pid}: still alive: stop manually`);
          survivors += 1;
        }
      }
    }
    for (const stray of run.manual) {
      stillAlive.push(`pid ${stray.pid}: still alive: stop manually`);
      survivors += 1;
    }
    for (const action of run.actions) {
      if (action.type === "delete-account") {
        if (
          await attempt(`delete account ${action.account}`, () =>
            deps.deleteAccount(action.account),
          )
        ) {
          accountsDeleted.push(action.account);
        }
      }
    }
    if (survivors > 0) continue; // keep the folders so the owner can find the leftovers
    for (const action of run.actions) {
      if (action.type === "remove-dir") {
        if (await attempt(`remove ${action.path}`, () => deps.removeDir(action.path))) {
          removed.push(action.path);
        }
      }
    }
    for (const action of run.actions) {
      if (action.type === "remove-root") {
        if (await attempt(`remove ${action.path}`, () => deps.removeRunRoot(action.path))) {
          removed.push(action.path);
        }
      }
    }
  }
  return { status: "swept", terminated, accountsDeleted, removed, stillAlive, errors };
}

// --- default wiring ------------------------------------------------------------------------

/** Candidate run roots directly under `base`: exact name shape, a real directory, ours. */
export function listCandidateRuns(base: string, now: number = Date.now()): SweepRunInput[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const runs: SweepRunInput[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(base);
  } catch {
    return runs;
  }
  for (const name of names) {
    if (!name.startsWith(RUN_ROOT_PREFIX)) continue;
    const runRoot = join(base, name);
    try {
      const info = lstatSync(runRoot);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      if (uid !== undefined && info.uid !== uid) continue;
      let entries: LedgerEntry[] | null;
      try {
        entries = readLedger(join(runRoot, "ledger.jsonl"));
      } catch {
        entries = null;
      }
      runs.push({ runRoot, ageMs: now - info.mtimeMs, entries });
    } catch {
      // vanished while scanning
    }
  }
  return runs;
}

const execFileAsync = promisify(execFile);

/** The only pid-based signal: TERM through the system kill command, argv array, no shell. */
const terminateByPid = async (pid: number): Promise<void> => {
  await execFileAsync("kill", ["-TERM", String(pid)]);
};

/** The real sweep: scan, plan against a fresh process table, execute. */
export async function runStaleSweep(context: SweepContext): Promise<SweepOutcome> {
  const runs = listCandidateRuns(context.base);
  if (runs.length === 0) return { status: "none" };
  const table = await context.readTable();
  const plan = planSweep(runs, table, {
    base: context.base,
    selfPid: context.selfPid,
    home: context.home,
  });
  return executeSweep(plan, {
    sendTerm: terminateByPid,
    deleteAccount: context.deleteAccount,
    removeDir: (path) => rmSync(path, { recursive: true, force: true }),
    removeRunRoot: (path) => removeRunRoot(path, { base: context.base, home: context.home }),
    readTable: context.readTable,
    wait: context.wait,
  });
}
