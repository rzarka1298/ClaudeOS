import type { Evidence, KnownHookRecord, SessionFacts } from "@ccc/collectors";
import type { KnownHookEvent, RunId, SessionRun, SessionView } from "@ccc/domain";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { EventBus } from "../events/event-bus.js";

/** Resolves the process and project facts behind one known hook record (05-08 Task 2). */
export interface SessionFactsProvider {
  factsFor(record: KnownHookRecord): Promise<SessionFacts>;
}

export interface ClaudePipelineDeps {
  readonly db: Database.Database;
  readonly bus: Pick<EventBus, "publish">;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly mintRunId: () => RunId;
  readonly facts: SessionFactsProvider;
}

export type IngestOutcome =
  | "applied"
  | "duplicate"
  | "unknown-event"
  | "shape-invalid"
  | "envelope-invalid";

export interface PipelineHealth {
  readonly lastEventAt: string | null;
  readonly unknownEventCount: number;
  readonly rejectedEdgeCount: number;
  readonly shapeChanged: KnownHookEvent | null;
}

export interface ClaudePipeline {
  ingest(input: unknown, via: "socket" | "spool"): Promise<IngestOutcome>;
  apply(evidence: Evidence): Promise<void>;
  listSessionViews(): SessionView[];
  health(): PipelineHealth;
  onRunSettled(listener: (run: SessionRun) => void): () => void;
}

// RED stub (05-08 Task 1): the real pipeline lands in the GREEN commit.
export function createClaudePipeline(_deps: ClaudePipelineDeps): ClaudePipeline {
  return {
    ingest: () => Promise.reject(new Error("not implemented")),
    apply: () => Promise.reject(new Error("not implemented")),
    listSessionViews: () => [],
    health: () => ({
      lastEventAt: null,
      unknownEventCount: 0,
      rejectedEdgeCount: 0,
      shapeChanged: null,
    }),
    onRunSettled: () => () => {},
  };
}
