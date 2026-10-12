import { type ChildProcess, execFile, spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { LedgerEntry } from "../ledger.js";
import { HOOK_ENTRY } from "../repo-paths.js";
import { NOTIFICATION_TITLE } from "./cross-copy.js";

/**
 * Support for the synthetic-session spec (06-UAT test 11) and the notification spec (test 1),
 * 05.2-08. The Force-terminate flow is driven with synthetic hook events about a process this
 * spec spawned itself, ported from packages/test-fixtures/src/approval-int-support.ts (test
 * support, not exported).
 *
 * Safety rules, each pinned by a unit test (T-05.2-30, T-05.2-31, T-05.2-38):
 * - the only process ever signalled is a ChildProcess handle returned by `spawnSacrificialChild`;
 *   there is no pid-based signal anywhere in this file;
 * - `runHook` refuses a pid that is not a ledgered sacrificial child, so a real process can never
 *   be registered as a session, and `assertTargetIsSacrificial` is the second check before any
 *   approval;
 * - the hook runs with an explicit minimal environment (PATH, HOME, CLAUDE_PID) and the sandbox
 *   runtime directory, so no variable of the runner and no real spool or settings is reachable;
 * - window activation accepts one application name, Finder, and never the app named Obsidian.
 */

/** Passed as an extra argument so the idle child is identifiable in the process listing. */
export const SACRIFICIAL_MARKER = "ccc-uat-sacrificial";
const IDLE_SCRIPT = "setInterval(() => {}, 1000)";
const CHILD_EXIT_WAIT_MS = 5_000;
const HOOK_WAIT_MS = 15_000;

/** Fixed statements over the copied store (never built from request text). */
export const RUNS_SQL =
  "select run_id, claude_session_id, pid, pid_started_at, state from runs where claude_session_id is not null order by started_at desc limit 20;";
export const AUDIT_SEQUENCE_SQL =
  "select seq, proposal_id, event from approval_audit order by seq;";

const REFUSAL =
  "Refusing to approve a termination: the session's recorded process is not a sacrificial child this spec spawned.";

/**
 * Throws unless the pid the service recorded for the session is one of the ledgered sacrificial
 * pids. Pid 1, this process, its parent and anything that is not a positive integer are refused
 * even when listed. The message never names a pid.
 */
export function assertTargetIsSacrificial(
  recordedPid: number | null,
  ledgerPids: readonly number[],
): void {
  if (
    recordedPid === null ||
    !Number.isInteger(recordedPid) ||
    recordedPid <= 1 ||
    recordedPid === process.pid ||
    recordedPid === process.ppid ||
    !ledgerPids.includes(recordedPid)
  ) {
    throw new Error(REFUSAL);
  }
}

function isStrictlyBelow(root: string, path: string): boolean {
  const base = resolve(root);
  const target = resolve(path);
  return target !== base && target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

/** The SessionStart record the compiled hook accepts (the int-test helper's fields). */
export function buildSessionStartRecord(
  sessionId: string,
  cwd: string,
  runRoot: string,
): Record<string, unknown> {
  if (!SESSION_ID.test(sessionId)) throw new Error("The synthetic session id is not plain.");
  if (!isStrictlyBelow(runRoot, cwd)) {
    throw new Error("The synthetic session folder must be inside the run root.");
  }
  return {
    session_id: sessionId,
    cwd,
    permission_mode: "default",
    model: "claude-test-model",
    hook_event_name: "SessionStart",
    source: "startup",
  };
}

/** The whole environment the hook receives: nothing of the runner's own leaks through. */
export function buildHookEnv(input: { home: string; claudePid: number }): Record<string, string> {
  return { PATH: "/usr/bin:/bin", HOME: input.home, CLAUDE_PID: String(input.claudePid) };
}

export function hookArgs(runtimeDir: string): string[] {
  return [HOOK_ENTRY, "--runtime-dir", runtimeDir];
}

export interface HookRunInput {
  runtimeDir: string;
  runRoot: string;
  home: string;
  pid: number;
  ledgerPids: readonly number[];
  record: Record<string, unknown>;
  spawnFn?: typeof spawn;
}

/**
 * Runs the compiled hook once, as Claude Code spawns it, with CLAUDE_PID set to a ledgered
 * sacrificial child. Both folders must sit inside the run root; the check happens before spawn.
 */
export async function runHook(input: HookRunInput): Promise<void> {
  assertTargetIsSacrificial(input.pid, input.ledgerPids);
  if (
    !isStrictlyBelow(input.runRoot, input.runtimeDir) ||
    !isStrictlyBelow(input.runRoot, input.home)
  ) {
    throw new Error("The hook runtime directory and home must be inside the run root.");
  }
  const start = input.spawnFn ?? spawn;
  const child = start(process.execPath, hookArgs(input.runtimeDir), {
    env: buildHookEnv({ home: input.home, claudePid: input.pid }),
    stdio: ["pipe", "ignore", "ignore"],
    shell: false,
  });
  const done = new Promise<void>((finish) => {
    child.once("close", () => finish());
    child.once("error", () => finish());
  });
  child.stdin?.end(JSON.stringify(input.record));
  const timer = setTimeout(() => child.kill("SIGKILL"), HOOK_WAIT_MS);
  try {
    await done;
  } finally {
    clearTimeout(timer);
  }
}

export interface SacrificialChild {
  readonly child: ChildProcess;
  readonly pid: number;
}

export interface SacrificialDeps {
  /** Every child spawned lands here so it can be reaped and its pid ledgered. */
  registry: SacrificialChild[];
  ledger: (entry: LedgerEntry) => void;
  /** The listing's start-time text for a pid, as the ledger stores it. */
  readStart: (pid: number) => Promise<string>;
  spawnFn?: typeof spawn;
}

/** A harmless idle node process standing in for a Claude process; ledgered as sacrificial. */
export async function spawnSacrificialChild(deps: SacrificialDeps): Promise<SacrificialChild> {
  const start = deps.spawnFn ?? spawn;
  const child = start(process.execPath, ["-e", IDLE_SCRIPT, SACRIFICIAL_MARKER], {
    stdio: "ignore",
    shell: false,
  });
  await new Promise<void>((done, fail) => {
    child.once("spawn", () => done());
    child.once("error", fail);
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("The sacrificial child has no pid.");
  const sacrificial: SacrificialChild = { child, pid };
  deps.registry.push(sacrificial);
  deps.ledger({
    kind: "pid",
    role: "sacrificial",
    pid,
    start: await deps.readStart(pid),
    marker: SACRIFICIAL_MARKER,
  });
  return sacrificial;
}

export function ledgerPidsOf(registry: readonly SacrificialChild[]): number[] {
  return registry.map((entry) => entry.pid);
}

const running = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null;

/** Ends every still-running sacrificial child through its handle and empties the registry. */
export async function reapSacrificialChildren(registry: SacrificialChild[]): Promise<number> {
  const entries = registry.splice(0);
  await Promise.all(
    entries.map(
      (entry) =>
        new Promise<void>((done) => {
          if (!running(entry.child)) return done();
          const timer = setTimeout(done, CHILD_EXIT_WAIT_MS);
          entry.child.once("exit", () => {
            clearTimeout(timer);
            done();
          });
          entry.child.kill("SIGKILL");
        }),
    ),
  );
  return entries.length;
}

/** The pid the service recorded for a session, from the copied store's runs rows, or null. */
export function recordedPidFor(
  rows: ReadonlyArray<Record<string, unknown>>,
  sessionId: string,
): number | null {
  const row = rows.find((entry) => entry.claude_session_id === sessionId);
  return typeof row?.pid === "number" ? row.pid : null;
}

/**
 * The audit trail of the whole flow: requested, denied, requested, approved first, then at least
 * one executed (the carried-out request) and one failed (the already-ended session).
 */
export function checkAuditSequence(events: readonly string[]): { ok: boolean; reason: string } {
  const lead = ["requested", "denied", "requested", "approved"];
  if (lead.some((event, index) => events[index] !== event)) {
    return {
      ok: false,
      reason: "The audit trail does not start requested, denied, requested, approved.",
    };
  }
  for (const needed of ["executed", "failed"]) {
    if (!events.includes(needed))
      return { ok: false, reason: `The audit trail has no ${needed} row.` };
  }
  return { ok: true, reason: "" };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const BANNER_MAX_WIDTH = 440;
const BANNER_MAX_HEIGHT = 180;
const MENU_BAR_OFFSET = 32;

/** The small top-right rectangle where a banner appears, inside the screen, in whole numbers. */
export function bannerRegion(screen: { width: number; height: number }): Rect {
  for (const size of [screen.width, screen.height]) {
    if (!Number.isInteger(size) || size <= 0)
      throw new Error("The screen size must be positive whole numbers.");
  }
  const w = Math.min(BANNER_MAX_WIDTH, screen.width);
  const h = Math.min(BANNER_MAX_HEIGHT, screen.height);
  return { x: screen.width - w, y: Math.min(MENU_BAR_OFFSET, screen.height - h), w, h };
}

export interface NotificationFacts {
  title: string;
  body: string | null;
  tag: string | null;
  hasOnclick: boolean;
  permission: string | null;
  actions?: unknown[];
}

/** requester, then "asks to", then a templated action, ending in a full stop. */
const GENERIC_BODY = /^[^./]{1,60} asks to [^./]{1,120}\.$/;

/** The banner's content contract (APPR-09): fixed title, generic body, no actions, permission granted. */
export function checkNotificationRecord(
  record: NotificationFacts,
  options: { forbidden?: readonly string[] } = {},
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (record.title !== NOTIFICATION_TITLE) problems.push("title");
  if (record.body === null || !GENERIC_BODY.test(record.body)) problems.push("body-not-generic");
  else if ((options.forbidden ?? []).some((term) => term !== "" && record.body?.includes(term))) {
    problems.push("body-names-request");
  }
  if (record.actions !== undefined && record.actions.length > 0) problems.push("actions-offered");
  if (record.permission !== "granted") problems.push("permission");
  if (!record.hasOnclick) problems.push("no-click-handler");
  if (record.tag === null || record.tag === "") problems.push("no-tag");
  return { ok: problems.length === 0, problems };
}

/** While the window is reported focused the plugin must create no native notification. */
export function checkNoNotificationWhileFocused(records: readonly unknown[]): {
  ok: boolean;
  problems: string[];
} {
  return records.length === 0
    ? { ok: true, problems: [] }
    : { ok: false, problems: ["notification-while-focused"] };
}

const OPEN_TOOL = "/usr/bin/open";
const ALLOWED_APP = "Finder";
const execFileAsync = promisify(execFile);

/**
 * Brings the one allowlisted application to the front (Finder), so the Obsidian window is
 * unfocused and a banner can show. Any other name throws before anything is spawned; the app
 * named Obsidian is never activated (it would reach the owner's real window).
 */
export async function activateAllowlistedApp(
  name: string,
  run: (file: string, args: readonly string[]) => Promise<void> = async (file, args) => {
    await execFileAsync(file, [...args]);
  },
): Promise<void> {
  if (name !== ALLOWED_APP) throw new Error("Only Finder may be brought to the front.");
  await run(OPEN_TOOL, ["-a", ALLOWED_APP]);
}
