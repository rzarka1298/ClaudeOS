/**
 * Support for the real-process Codex tests (plan 05.1-29). RED stub: every function throws until
 * the support is implemented; only the budgets are real.
 */

/** The PRD budget for a session change to reach a subscriber (and the default poll cadence's ceiling). */
export const ROLLOUT_BUDGET_MS = 10_000;
/** The budget for a hook-delivered event to reach a subscriber (UI-SPEC realtime). */
export const HOOK_BUDGET_MS = 2_000;

export interface CodexHomeOnDisk {
  readonly root: string;
  readonly threadId: string;
  readonly rolloutFile: string;
  readonly dbPath: string;
}

const notYet = (name: string): never => {
  throw new Error(`not implemented: ${name}`);
};

export function createCodexHomeOnDisk(_parent: string, _nowMs: number): CodexHomeOnDisk {
  return notYet("createCodexHomeOnDisk");
}
export function markThreadRunning(_home: CodexHomeOnDisk, _atMs: number): void {
  notYet("markThreadRunning");
}
export function writeBridgeState(_xdgStateHome: string): void {
  notYet("writeBridgeState");
}
export function installCodexHook(_codexHome: string, _runtimeDir: string): number | null {
  return notYet("installCodexHook");
}
export async function runInstalledCodexHook(
  _runtimeDir: string,
  _payload: Record<string, unknown>,
): Promise<void> {
  notYet("runInstalledCodexHook");
}
export function entryNames(_root: string): string[] {
  return notYet("entryNames");
}
export function accessTimeMs(_path: string): number {
  return notYet("accessTimeMs");
}
