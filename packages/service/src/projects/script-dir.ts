import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";

// RED-phase stub (plan 04-09 Task 1): the real lifecycle lands in GREEN.

export const SCRIPT_DIR_NAME = "launch";
export const SCRIPT_MAX_AGE_MS = 10 * 60 * 1000;

export type SweepOptions =
  | { readonly all: true }
  | { readonly olderThanMs: number; readonly now?: number };

export function ensureScriptDir(runtimeDir: string, _logger?: Pick<Logger, "warn">): string {
  const dir = join(runtimeDir, SCRIPT_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeLaunchScript(dir: string, _body: string): string {
  return join(dir, "stub.command");
}

export function sweepStaleScripts(_dir: string, _options: SweepOptions = { all: true }): number {
  return 0;
}
