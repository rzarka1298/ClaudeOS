import {
  type Evidence,
  type KnownHookRecord,
  type ReduceResult,
  reduce,
  type SessionFacts,
} from "@ccc/collectors";
import {
  classifyHookRecord,
  type KnownHookEvent,
  type RunId,
  type SessionRun,
  type SessionView,
  toSessionView,
} from "@ccc/domain";
import {
  listRegisteredProjects,
  listSessionRunsForView,
  sessionRunIndex,
  upsertSessionRun,
} from "@ccc/operational-store";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { EventBus } from "../events/event-bus.js";

/**
 * The Claude session pipeline (D-17, D-54): the service half of the
 * hook → reducer → SQLite → event stream path. Every hook record, from the
 * socket or the spool, and every liveness or terminate evidence goes
 * through here, one at a time and in arrival order. The pure collectors
 * reducer decides; this module owns every side effect (the store write,
 * the `session.upserted` publish, the log line).
 */

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
  /** Schedules `fn` after `ms`; returns a cancel. Defaults to an unref'd `setTimeout`. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

/** A Run whose only change is activity time is written and published at most once per window (PR-05). */
export const COALESCE_WINDOW_MS = 5000;

/** What one ingest did. The route maps it to 202 or a constant 400. */
export type IngestOutcome =
  | "applied"
  | "duplicate"
  | "unknown-event"
  | "shape-invalid"
  | "envelope-invalid";

export interface PipelineHealth {
  /** When the last known record was accepted, or null before the first. */
  readonly lastEventAt: string | null;
  readonly unknownEventCount: number;
  readonly rejectedEdgeCount: number;
  /** A known event whose latest record failed its schema, or null (D-12). */
  readonly shapeChanged: KnownHookEvent | null;
}

export interface ClaudePipeline {
  /** Validates and applies one forwarded hook record. Never throws for a bad record. */
  ingest(input: unknown, via: "socket" | "spool"): Promise<IngestOutcome>;
  /** Applies liveness, launch or terminate evidence (05-11, 05-14), queued with ingest. */
  apply(evidence: Evidence): Promise<void>;
  /** Synchronous: non-terminal Runs plus terminal Runs that ended within 7 days. */
  listSessionViews(): SessionView[];
  health(): PipelineHealth;
  /** Fires after an upsert caused by Stop or SessionEnd; returns an unsubscribe. */
  onRunSettled(listener: (run: SessionRun) => void): () => void;
  /** Writes any pending coalesced activity now and cancels every timer. */
  stop(): void;
}

/** How far back a terminal Run stays in the views (UI-SPEC R-08). */
const VIEW_ENDED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The hook events after which a Run's transcript has settled (05-12's trigger). */
const SETTLING_EVENTS: ReadonlySet<KnownHookEvent> = new Set<KnownHookEvent>([
  "Stop",
  "SessionEnd",
]);

export function createClaudePipeline(deps: ClaudePipelineDeps): ClaudePipeline {
  const { db, bus, logger } = deps;
  const settledListeners = new Set<(run: SessionRun) => void>();
  let lastEventAt: string | null = null;
  let unknownEventCount = 0;
  let rejectedEdgeCount = 0;

  // One promise chain serializes every ingest and apply, so the events of
  // one session are reduced in arrival order even across awaits.
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue<T>(work: () => Promise<T> | T): Promise<T> {
    const next = tail.then(work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function projectNames(): Map<string, string> {
    return new Map(listRegisteredProjects(db).map((project) => [project.projectId, project.name]));
  }

  function viewOf(run: SessionRun, names: Map<string, string>): SessionView {
    return toSessionView(run, run.projectId === null ? null : (names.get(run.projectId) ?? null));
  }

  /** Runs the reducer, persists every upsert in one transaction, publishes, and logs rejections. */
  function applyNow(evidence: Evidence): ReduceResult {
    const result = reduce(sessionRunIndex(db), evidence, deps.now().toISOString(), deps.mintRunId);
    for (const edge of result.rejected) {
      rejectedEdgeCount += 1;
      // Ids and labels only: never a value from the record (D-49).
      logger.info(
        { runId: edge.runId, from: edge.from, evidence: edge.evidence, reason: edge.reason },
        "session evidence rejected",
      );
    }
    if (result.upserts.length === 0) return result;
    db.transaction(() => {
      for (const run of result.upserts) upsertSessionRun(db, run);
    })();
    const names = projectNames();
    for (const run of result.upserts) {
      bus.publish("session.upserted", { session: viewOf(run, names) });
    }
    if (evidence.kind === "hook" && SETTLING_EVENTS.has(evidence.record.hook_event_name)) {
      for (const run of result.upserts) notifySettled(run);
    }
    return result;
  }

  function notifySettled(run: SessionRun): void {
    for (const listener of settledListeners) {
      try {
        listener(run);
      } catch (err: unknown) {
        logger.warn({ runId: run.runId, err }, "run-settled listener failed");
      }
    }
  }

  async function ingestNow(input: unknown, via: "socket" | "spool"): Promise<IngestOutcome> {
    const classified = classifyHookRecord(input);
    switch (classified.kind) {
      case "envelope-invalid":
        logger.warn({ via }, "hook record envelope invalid; ignored");
        return "envelope-invalid";
      case "unknown":
        unknownEventCount += 1;
        logger.info({ via, event: classified.eventName }, "unknown hook event; counted");
        return "unknown-event";
      case "shape-invalid":
        logger.warn(
          { via, event: classified.event, issuePaths: classified.issuePaths },
          "hook record shape changed; not applied",
        );
        return "shape-invalid";
      case "known": {
        // Stored timestamps are always `toISOString()` form, whatever offset
        // the record was stamped with, so string comparisons in the store hold.
        const record = {
          ...classified.record,
          observedAt: new Date(classified.record.observedAt).toISOString(),
        } as KnownHookRecord;
        const facts = await deps.facts.factsFor(record);
        applyNow({ kind: "hook", record, facts });
        lastEventAt = deps.now().toISOString();
        return "applied";
      }
    }
  }

  return {
    ingest: (input, via) => enqueue(() => ingestNow(input, via)),
    apply: (evidence) =>
      enqueue(() => {
        applyNow(evidence);
      }),
    listSessionViews() {
      const endedSince = new Date(deps.now().getTime() - VIEW_ENDED_WINDOW_MS).toISOString();
      const names = projectNames();
      return listSessionRunsForView(db, { endedSince }).map((run) => viewOf(run, names));
    },
    health: () => ({
      lastEventAt,
      unknownEventCount,
      rejectedEdgeCount,
      shapeChanged: null,
    }),
    stop() {},
    onRunSettled(listener) {
      settledListeners.add(listener);
      return () => {
        settledListeners.delete(listener);
      };
    },
  };
}
