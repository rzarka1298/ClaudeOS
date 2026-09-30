import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FocusResponse, RunId } from "@ccc/domain";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { ProcessFacts } from "./process-facts.js";

// RED scaffold (05-14 Task 3): the focus tiers land in GREEN.

export const FOCUS_TIMEOUT_MS = 5000;
export const TERMINAL_FOCUS_SCRIPT = "";
export const ITERM_FOCUS_SCRIPT = "";

export type FocusFailure =
  | "run-not-found"
  | "process-ended"
  | "terminal-unsupported"
  | "background-session"
  | "automation-denied"
  | "timeout";

export type FocusOutcome =
  | { readonly ok: true; readonly response: FocusResponse }
  | { readonly ok: false; readonly reason: FocusFailure };

export interface FocusService {
  focus(runId: RunId): Promise<FocusOutcome>;
}

export type FocusExecFile = (
  file: string,
  args: readonly string[],
  options: { readonly timeout: number },
) => Promise<{ readonly stdout: string }>;

const execFileAsync = promisify(execFile);

/**
 * The real runner for `/usr/bin/osascript` and `/usr/bin/open`: absolute
 * binary, argv array, no shell, a bounded timeout. A failure rejects with
 * Node's error, which carries `stderr` (osascript's error number) and
 * `killed` (the timeout), for the caller to map.
 */
export const nodeFocusExecFile: FocusExecFile = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, [...args], {
    timeout: options.timeout,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  return { stdout };
};

export interface FocusServiceDeps {
  readonly processFacts: ProcessFacts;
  readonly execFile: FocusExecFile;
  readonly db: Database.Database;
  readonly logger: Logger;
}

export function createFocusService(_deps: FocusServiceDeps): FocusService {
  return {
    async focus() {
      return { ok: false, reason: "terminal-unsupported" };
    },
  };
}
