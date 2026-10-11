import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { assertUatAccount } from "./isolation-guards.js";

/**
 * The run ledger (05.2-03, D-06): one JSON object per line recording everything a run creates
 * that teardown or the next start's sweep must be able to find again - the run itself, every
 * process (pid plus start-time text plus a command marker), the Keychain account and extra
 * directories. Identity is never a name search: the throwaway service's identity lives only in
 * its environment, so the ledger holds pid and start time instead.
 */

export interface ProcessEntry {
  pid: number;
  /** The start-time text exactly as the listing prints it; equality is the identity check. */
  start: string;
  /** The full command line. */
  command: string;
}

export type LedgerEntry =
  | {
      kind: "run";
      runId: string;
      runRoot: string;
      startedAt: string;
      ownerPid: number;
      ownerStart: string;
    }
  | { kind: "pid"; role: string; pid: number; start: string; marker?: string }
  | { kind: "account"; account: string }
  | { kind: "dir"; path: string }
  | { kind: "closed"; at: string }
  | { kind: "leaked"; at: string; pids: number[] };

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Validates one parsed line; throws LedgerError for an unknown kind or a malformed entry. */
function parseEntry(value: unknown): LedgerEntry {
  if (!isRecord(value)) throw new LedgerError("Ledger entry is not an object.");
  switch (value.kind) {
    case "run":
      if (
        isString(value.runId) &&
        isString(value.runRoot) &&
        isString(value.startedAt) &&
        isNumber(value.ownerPid) &&
        isString(value.ownerStart)
      ) {
        return {
          kind: "run",
          runId: value.runId,
          runRoot: value.runRoot,
          startedAt: value.startedAt,
          ownerPid: value.ownerPid,
          ownerStart: value.ownerStart,
        };
      }
      break;
    case "pid":
      if (
        isString(value.role) &&
        isNumber(value.pid) &&
        isString(value.start) &&
        (value.marker === undefined || isString(value.marker))
      ) {
        return value.marker === undefined
          ? { kind: "pid", role: value.role, pid: value.pid, start: value.start }
          : {
              kind: "pid",
              role: value.role,
              pid: value.pid,
              start: value.start,
              marker: value.marker,
            };
      }
      break;
    case "account":
      if (isString(value.account)) {
        try {
          assertUatAccount(value.account);
        } catch {
          break;
        }
        return { kind: "account", account: value.account };
      }
      break;
    case "dir":
      if (isString(value.path)) return { kind: "dir", path: value.path };
      break;
    case "closed":
      if (isString(value.at)) return { kind: "closed", at: value.at };
      break;
    case "leaked":
      if (isString(value.at) && Array.isArray(value.pids) && value.pids.every(isNumber)) {
        return { kind: "leaked", at: value.at, pids: value.pids as number[] };
      }
      break;
    default:
      throw new LedgerError("Ledger entry has an unknown kind.");
  }
  throw new LedgerError("Ledger entry is malformed.");
}

/** Appends one entry as a JSON line; the file is created with mode 0600. */
export function appendLedger(path: string, entry: LedgerEntry): void {
  const created = !existsSync(path);
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  if (created) chmodSync(path, 0o600);
}

/**
 * Reads every entry in order. A missing file is an empty ledger; a torn last line (a crash
 * mid-append) is ignored; any other malformed line, or an unknown kind, throws.
 */
export function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  const entries: LedgerEntry[] = [];
  lines.forEach((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (index === lines.length - 1) return;
      throw new LedgerError("Ledger has a malformed line before its end.");
    }
    entries.push(parseEntry(parsed));
  });
  return entries;
}

export interface Leak {
  pid: number;
  reason: "ledgered process still alive" | "process names the run root";
  role?: string;
  command?: string;
}

/**
 * Ledgered processes that are still alive: the same pid AND the same start-time text. The same
 * pid with a different start time is a recycled pid, never a leak (T-05.2-12).
 */
export function findLeaks(entries: readonly LedgerEntry[], table: readonly ProcessEntry[]): Leak[] {
  const leaks: Leak[] = [];
  for (const entry of entries) {
    if (entry.kind !== "pid") continue;
    const alive = table.find((row) => row.pid === entry.pid && row.start === entry.start);
    if (alive !== undefined) {
      leaks.push({
        pid: entry.pid,
        reason: "ledgered process still alive",
        role: entry.role,
        command: alive.command,
      });
    }
  }
  return leaks;
}

/**
 * Any process whose command line names the run root (wdio's temp folders and the sandbox
 * Obsidian's user-data folder sit under it), excluding the runner's own pid.
 */
export function findRunRootProcesses(
  table: readonly ProcessEntry[],
  runRoot: string,
  selfPid: number,
): Leak[] {
  return table
    .filter((row) => row.pid !== selfPid && row.command.includes(runRoot))
    .map((row) => ({ pid: row.pid, reason: "process names the run root", command: row.command }));
}

/** What the stale-run sweep did (or found) before a new run started (Task 2). */
export type SweepOutcome =
  | { status: "none" }
  | { status: "busy"; runRoot: string }
  | {
      status: "swept";
      terminated: number[];
      accountsDeleted: string[];
      removed: string[];
      stillAlive: string[];
    };
