import type { SessionTerminator } from "@ccc/domain";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { ClaudePipeline } from "./pipeline.js";
import type { ProcessFacts } from "./process-facts.js";

// RED scaffold (05-14 Task 3): the signal sequence lands in GREEN.

export const DEFAULT_TERMINATE_GRACE_MS = 10_000;

export type TerminateSignal = "SIGTERM" | "SIGKILL";

export interface TerminateExecutorDeps {
  readonly db: Database.Database;
  readonly pipeline: Pick<ClaudePipeline, "apply">;
  readonly processFacts: Pick<ProcessFacts, "isAlive" | "readStartTimes">;
  readonly kill: (pid: number, signal: TerminateSignal) => void;
  readonly graceMs?: number;
  readonly pollMs?: number;
  readonly now: () => Date;
  readonly logger: Logger;
}

export function createTerminateExecutor(_deps: TerminateExecutorDeps): SessionTerminator {
  return {
    async terminate() {
      return { ok: false, reason: "run-not-found" };
    },
  };
}
