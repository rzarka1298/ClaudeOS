import type { ChildProcess, spawn } from "node:child_process";
import type { LedgerEntry } from "../ledger.js";

/** Typed skeleton for the RED commit; the GREEN commit implements every function. */
const TODO = (name: string): never => {
  throw new Error(`${name} is not implemented yet (typed skeleton).`);
};

export const SACRIFICIAL_MARKER = "";
export const RUNS_SQL = "";
export const AUDIT_SEQUENCE_SQL = "";

export interface SacrificialChild {
  readonly child: ChildProcess;
  readonly pid: number;
}
export interface SacrificialDeps {
  registry: SacrificialChild[];
  ledger: (entry: LedgerEntry) => void;
  readStart: (pid: number) => Promise<string>;
  spawnFn?: typeof spawn;
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
export interface NotificationFacts {
  title: string;
  body: string | null;
  tag: string | null;
  hasOnclick: boolean;
  permission: string | null;
  actions?: unknown[];
}

export const assertTargetIsSacrificial = (_recorded: number | null, _ledger: readonly number[]): void =>
  TODO("assertTargetIsSacrificial");
export const buildSessionStartRecord = (
  _sessionId: string,
  _cwd: string,
  _runRoot: string,
): Record<string, unknown> => TODO("buildSessionStartRecord");
export const buildHookEnv = (_input: { home: string; claudePid: number }): Record<string, string> =>
  TODO("buildHookEnv");
export const hookArgs = (_runtimeDir: string): string[] => TODO("hookArgs");
export const runHook = async (_input: HookRunInput): Promise<void> => TODO("runHook");
export const spawnSacrificialChild = async (_deps: SacrificialDeps): Promise<SacrificialChild> =>
  TODO("spawnSacrificialChild");
export const ledgerPidsOf = (_registry: readonly SacrificialChild[]): number[] => TODO("ledgerPidsOf");
export const reapSacrificialChildren = async (_registry: SacrificialChild[]): Promise<number> =>
  TODO("reapSacrificialChildren");
export const recordedPidFor = (
  _rows: ReadonlyArray<Record<string, unknown>>,
  _sessionId: string,
): number | null => TODO("recordedPidFor");
export const checkAuditSequence = (_events: readonly string[]): { ok: boolean; reason: string } =>
  TODO("checkAuditSequence");
export const bannerRegion = (_screen: {
  width: number;
  height: number;
}): { x: number; y: number; w: number; h: number } => TODO("bannerRegion");
export const checkNotificationRecord = (
  _record: NotificationFacts,
  _options?: { forbidden?: readonly string[] },
): { ok: boolean; problems: string[] } => TODO("checkNotificationRecord");
export const checkNoNotificationWhileFocused = (
  _records: readonly unknown[],
): { ok: boolean; problems: string[] } => TODO("checkNoNotificationWhileFocused");
export const activateAllowlistedApp = async (
  _name: string,
  _run?: (file: string, args: readonly string[]) => Promise<void>,
): Promise<void> => TODO("activateAllowlistedApp");
