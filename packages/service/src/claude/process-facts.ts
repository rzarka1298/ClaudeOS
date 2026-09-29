import type { SessionFacts } from "@ccc/collectors";
import type { Logger } from "pino";
import type { SessionFactsProvider } from "./pipeline.js";

export type { SessionFactsProvider } from "./pipeline.js";

export type ExecFileRunner = (
  file: string,
  args: readonly string[],
  options: { readonly timeout: number; readonly env: Readonly<Record<string, string>> },
) => Promise<{ readonly stdout: string }>;

export type KillFn = (pid: number, signal: 0) => void;

export interface AncestorEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly comm: string;
}

export interface ProcessFacts {
  isAlive(pid: number): boolean;
  readStartTimes(pids: readonly number[]): Promise<Map<number, string>>;
  readTty(pid: number): Promise<string | null>;
  readAncestry(pid: number): Promise<AncestorEntry[]>;
}

export interface ProcessFactsDeps {
  readonly execFile: ExecFileRunner;
  readonly kill: KillFn;
  readonly logger: Logger;
}

// RED stub (05-08 Task 2).
export function createProcessFacts(_deps: ProcessFactsDeps): ProcessFacts {
  throw new Error("not implemented");
}

export interface SessionFactsProviderOptions {
  readonly processFacts: ProcessFacts;
  readonly claudeProjectsRoot: string;
  readonly logger: Logger;
}

// RED stub (05-08 Task 2).
export function createSessionFactsProvider(
  _options: SessionFactsProviderOptions,
): SessionFactsProvider {
  const none: SessionFacts = {
    pidStartedAt: null,
    launchSource: null,
    projectId: null,
    worktreeRoot: null,
    transcriptPath: null,
  };
  return { factsFor: async () => none };
}
