import type { Logger } from "pino";
import type { ClaudePipeline } from "./pipeline.js";

export interface SpoolPollerOptions {
  readonly spoolPath: string;
  readonly statusLinePath: string;
  readonly dropPath: string;
  readonly pipeline: Pick<ClaudePipeline, "ingest">;
  readonly logger: Logger;
  readonly intervalMs: number;
  readonly onStatusLine?: (snapshot: unknown) => void;
}

export interface SpoolPollerStats {
  readonly fragmentsDiscarded: number;
  readonly unparsableLines: number;
  readonly statusLineDropped: number;
}

export interface SpoolPoller {
  drainNow(): Promise<number>;
  tick(): Promise<number>;
  dropCount(): number;
  stats(): SpoolPollerStats;
  setStatusLineSink(sink: (snapshot: unknown) => void): void;
  stop(): void;
}

// RED stub (05-08 Task 3).
export function startSpoolPoller(_options: SpoolPollerOptions): SpoolPoller {
  return {
    drainNow: async () => 0,
    tick: async () => 0,
    dropCount: () => 0,
    stats: () => ({ fragmentsDiscarded: 0, unparsableLines: 0, statusLineDropped: 0 }),
    setStatusLineSink: () => {},
    stop: () => {},
  };
}
