import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { ClaudePipeline } from "./pipeline.js";
import type { ProcessFacts } from "./process-facts.js";

// RED scaffold (05-11 Task 1): the real sweeper replaces this body.

export interface LivenessConfig {
  readonly sweepMs: number;
  readonly graceMs: number;
  readonly startTimeoutMs: number;
  readonly pidlessInactivityMs: number;
}

export const DEFAULT_LIVENESS_CONFIG: LivenessConfig = {
  sweepMs: 5000,
  graceMs: 10_000,
  startTimeoutMs: 60_000,
  pidlessInactivityMs: 1_800_000,
};

export interface SweepReport {
  readonly checked: number;
  readonly gone: number;
  readonly revived: number;
}

export interface LivenessSweeperDeps {
  readonly db: Database.Database;
  readonly pipeline: Pick<ClaudePipeline, "apply">;
  readonly processFacts: Pick<ProcessFacts, "isAlive" | "readStartTimes">;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly config: LivenessConfig;
}

export interface LivenessSweeper {
  sweepNow(): Promise<SweepReport>;
  start(): void;
  stop(): Promise<void>;
}

export function createLivenessSweeper(_deps: LivenessSweeperDeps): LivenessSweeper {
  return {
    sweepNow: async () => ({ checked: 0, gone: 0, revived: 0 }),
    start() {},
    stop: async () => {},
  };
}
