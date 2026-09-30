import {
  type Evidence,
  type KnownHookRecord,
  type ReduceResult,
  type RunIndex,
  reduce,
  type SessionFacts,
} from "@ccc/collectors";
import {
  classifyHookRecord,
  isTerminalRunState,
  type KnownHookEvent,
  type LaunchSource,
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

/**
 * The slow, metadata-only facts behind a hook record (wave 4): the
 * SessionStart launch source and project attribution. Null means unknown
 * and never clears a known value.
 */
export interface DeferredSessionFacts {
  readonly launchSource: LaunchSource | null;
  readonly projectId: string | null;
  readonly worktreeRoot: string | null;
}

/** Resolves the process and project facts behind one known hook record (05-08 Task 2). */
export interface SessionFactsProvider {
  /** The facts the reducer needs now; awaited on the serial ingest queue, so kept cheap. */
  factsFor(record: KnownHookRecord): Promise<SessionFacts>;
  /**
   * Facts that need several process spawns (launch-source ancestry, git
   * attribution). The pipeline starts this after the record is applied and
   * never awaits it on the ingest queue; the result is written as a
   * metadata-only follow-up (revision + 1). Null when nothing is pending.
   */
  deferredFactsFor?(record: KnownHookRecord): Promise<DeferredSessionFacts> | null;
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

/** The project facts a re-attribution writes (05-11). */
export interface RunAttribution {
  readonly projectId: string | null;
  readonly worktreeRoot: string | null;
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
  /**
   * Metadata-only re-attribution (05-11, D-23): writes the Run's project
   * facts at revision + 1 and publishes it once, never touching its state.
   * A null fact never clears a known one. Queued with ingest and apply;
   * resolves false when the Run is unknown or nothing changed.
   */
  reattribute(runId: RunId, attribution: RunAttribution): Promise<boolean>;
  /**
   * Metadata-only identity backfill (wave 4): records the process start of
   * a Run that has a pid but no `pidStartedAt` (its hooks were installed
   * mid-session, or the SessionStart `ps` failed), at revision + 1, never
   * touching its state. Never replaces a known start. Queued with ingest;
   * resolves false when the Run is unknown, terminal or already has one.
   */
  backfillPidStart(runId: RunId, pidStartedAt: string): Promise<boolean>;
  /** Synchronous: non-terminal Runs plus terminal Runs that ended within 7 days. */
  listSessionViews(): SessionView[];
  health(): PipelineHealth;
  /** Fires after an upsert caused by Stop or SessionEnd; returns an unsubscribe. */
  onRunSettled(listener: (run: SessionRun) => void): () => void;
  /**
   * Cancels every flush timer, waits for every queued ingest and apply to
   * finish, then writes any pending coalesced activity. Resolves only once
   * the queue is empty, so the caller may close the store afterwards. After
   * stop, activity-only changes are written at once instead of held.
   */
  stop(): Promise<void>;
}

/** How far back a terminal Run stays in the views (UI-SPEC R-08). */
const VIEW_ENDED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The hook events after which a Run's transcript has settled (05-12's trigger). */
const SETTLING_EVENTS: ReadonlySet<KnownHookEvent> = new Set<KnownHookEvent>([
  "Stop",
  "SessionEnd",
]);

/** How many applied eventIds the replay guard remembers (D-08). */
const APPLIED_EVENT_ID_CAPACITY = 10_000;

/**
 * The fields a coalesced write may differ in (PR-05): activity time, the
 * revision, and the subagent set. A change in anything else (state,
 * activity, model, a link, an ending) is written and published at once.
 */
const COALESCIBLE_FIELDS: ReadonlySet<keyof SessionRun> = new Set<keyof SessionRun>([
  "lastActivityAt",
  "revision",
  "subagentActiveIds",
  "subagentLastType",
]);

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  return a === b;
}

/** Whether `next` differs from the persisted Run only in coalescible fields. */
function onlyActivityChanged(persisted: SessionRun, next: SessionRun): boolean {
  return (Object.keys(next) as (keyof SessionRun)[]).every(
    (key) => COALESCIBLE_FIELDS.has(key) || sameValue(persisted[key], next[key]),
  );
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

/** Per-event-name shape history, as an ingest sequence number (D-12). */
interface ShapeHistory {
  lastValid: number;
  lastInvalid: number;
}

export function createClaudePipeline(deps: ClaudePipelineDeps): ClaudePipeline {
  const { db, bus, logger } = deps;
  const schedule = deps.schedule ?? defaultSchedule;
  const store = sessionRunIndex(db);
  const settledListeners = new Set<(run: SessionRun) => void>();
  const shapes = new Map<KnownHookEvent, ShapeHistory>();
  /** Insertion-ordered: the oldest id is evicted first once over capacity. */
  const appliedEventIds = new Set<string>();
  /** The latest reduced state of a Run whose write is being coalesced, never yet persisted. */
  const pending = new Map<RunId, SessionRun>();
  const flushTimers = new Map<RunId, () => void>();
  /** When each Run was last written and published, by `deps.now()`. */
  const lastWriteAt = new Map<RunId, number>();
  /** Deferred-facts follow-ups still resolving; stop() waits for them. */
  const followUps = new Set<Promise<void>>();
  let sequence = 0;
  let lastEventAt: string | null = null;
  let unknownEventCount = 0;
  let rejectedEdgeCount = 0;
  let stopped = false;

  // One promise chain serializes every ingest, apply and coalesced flush,
  // so the events of one session are reduced in arrival order even across
  // the awaits in facts resolution.
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue<T>(work: () => Promise<T> | T): Promise<T> {
    const next = tail.then(work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * The Run as the reducer must see it: the stored row with any pending
   * coalesced fields laid over it, at the STORED revision, so the next
   * write is exactly one revision past the last published one. Pending
   * Runs differ only in activity fields, so the store's identity and state
   * queries still select the right row.
   */
  function overlay(run: SessionRun | null): SessionRun | null {
    if (run === null) return null;
    const held = pending.get(run.runId);
    return held === undefined ? run : { ...held, revision: run.revision };
  }

  const index: RunIndex = {
    byRunId: (runId) => overlay(store.byRunId(runId)),
    byIdentity: (claudeSessionId, pid) => overlay(store.byIdentity(claudeSessionId, pid)),
    latestBySession: (claudeSessionId) => overlay(store.latestBySession(claudeSessionId)),
    liveByPid: (pid) => overlay(store.liveByPid(pid)),
    latestByPid: (pid) => overlay(store.latestByPid(pid)),
  };

  function projectNames(): Map<string, string> {
    return new Map(listRegisteredProjects(db).map((project) => [project.projectId, project.name]));
  }

  function viewOf(run: SessionRun, names: Map<string, string>): SessionView {
    return toSessionView(run, run.projectId === null ? null : (names.get(run.projectId) ?? null));
  }

  function cancelFlush(runId: RunId): void {
    flushTimers.get(runId)?.();
    flushTimers.delete(runId);
  }

  /** Persists `runs` in one transaction, then publishes each; clears their pending state. */
  function writeAndPublish(runs: readonly SessionRun[]): void {
    if (runs.length === 0) return;
    db.transaction(() => {
      for (const run of runs) upsertSessionRun(db, run);
    })();
    const writtenAt = deps.now().getTime();
    const names = projectNames();
    for (const run of runs) {
      pending.delete(run.runId);
      cancelFlush(run.runId);
      // A terminal Run takes no more activity, so its window is forgotten.
      if (isTerminalRunState(run.state)) lastWriteAt.delete(run.runId);
      else lastWriteAt.set(run.runId, writtenAt);
      bus.publish("session.upserted", { session: viewOf(run, names) });
    }
  }

  function flush(runId: RunId): void {
    flushTimers.delete(runId);
    const held = pending.get(runId);
    if (held !== undefined) writeAndPublish([held]);
  }

  /**
   * Schedules the coalesced write of `runId` after `delay`. A failed write
   * (a SQLite error) leaves the held Run in `pending` — `writeAndPublish`
   * clears it only after its transaction commits — so the failure is logged
   * and the flush re-armed one window later rather than escaping as an
   * unhandled rejection and stranding the activity (wave 3 review).
   */
  function armFlush(runId: RunId, delay: number): void {
    flushTimers.set(
      runId,
      schedule(() => {
        enqueue(() => flush(runId)).catch((err: unknown) => {
          logger.error({ runId, err }, "coalesced session write failed; retrying");
          if (!stopped && pending.has(runId) && !flushTimers.has(runId)) {
            armFlush(runId, COALESCE_WINDOW_MS);
          }
        });
      }, delay),
    );
  }

  /**
   * Holds an activity-only change until its Run's window closes (PR-05).
   * The first held change schedules the flush; later ones only replace
   * the held Run, so the flush carries the latest activity time.
   */
  function hold(run: SessionRun, nowMs: number, lastMs: number): void {
    pending.set(run.runId, run);
    if (flushTimers.has(run.runId)) return;
    armFlush(run.runId, Math.max(0, lastMs + COALESCE_WINDOW_MS - nowMs));
  }

  /** Runs the reducer, logs rejections, then writes (or holds) every upsert. */
  function applyNow(evidence: Evidence): ReduceResult {
    const result = reduce(index, evidence, deps.now().toISOString(), deps.mintRunId);
    for (const edge of result.rejected) {
      rejectedEdgeCount += 1;
      // Ids and labels only: never a value from the record (D-49).
      logger.info(
        { runId: edge.runId, from: edge.from, evidence: edge.evidence, reason: edge.reason },
        "session evidence rejected",
      );
    }
    const nowMs = deps.now().getTime();
    const immediate: SessionRun[] = [];
    for (const run of result.upserts) {
      const persisted = store.byRunId(run.runId);
      const lastMs = lastWriteAt.get(run.runId);
      // Once stopped nothing is held: no timer would ever flush it.
      const coalesce =
        !stopped &&
        persisted !== null &&
        lastMs !== undefined &&
        nowMs - lastMs < COALESCE_WINDOW_MS &&
        onlyActivityChanged(persisted, run);
      if (coalesce) hold(run, nowMs, lastMs);
      else immediate.push(run);
    }
    writeAndPublish(immediate);
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

  function shapeOf(event: KnownHookEvent): ShapeHistory {
    let history = shapes.get(event);
    if (history === undefined) {
      history = { lastValid: 0, lastInvalid: 0 };
      shapes.set(event, history);
    }
    return history;
  }

  function rememberApplied(eventId: string): void {
    appliedEventIds.add(eventId);
    if (appliedEventIds.size > APPLIED_EVENT_ID_CAPACITY) {
      const oldest = appliedEventIds.values().next().value;
      if (oldest !== undefined) appliedEventIds.delete(oldest);
    }
  }

  /** The Run a record was applied to, as the reducer found it (identity, else the session's latest). */
  function runOfRecord(record: KnownHookRecord): SessionRun | null {
    const raw = record.env?.CLAUDE_PID;
    const pid = raw === undefined ? null : Number.parseInt(raw, 10);
    if (pid !== null && Number.isFinite(pid)) return index.byIdentity(record.session_id, pid);
    return index.byIdentity(record.session_id, null) ?? index.latestBySession(record.session_id);
  }

  /** Writes deferred metadata onto the record's Run (null never clears a known value). */
  function applyFollowUp(record: KnownHookRecord, facts: DeferredSessionFacts): void {
    const run = runOfRecord(record);
    if (run === null) return;
    // Attribution belongs to the record's working directory: once a later
    // record moved the Run to another cwd, this answer is superseded and
    // must not overwrite the newer project (Codex 3). The launch source is
    // a fact of the process, not the cwd, so it still applies.
    const current = record.cwd === undefined || record.cwd === run.cwd;
    const next = {
      launchSource: facts.launchSource ?? run.launchSource,
      projectId: current ? (facts.projectId ?? run.projectId) : run.projectId,
      worktreeRoot: current ? (facts.worktreeRoot ?? run.worktreeRoot) : run.worktreeRoot,
    };
    if (
      next.launchSource === run.launchSource &&
      next.projectId === run.projectId &&
      next.worktreeRoot === run.worktreeRoot
    ) {
      return;
    }
    writeAndPublish([{ ...run, ...next, revision: run.revision + 1 }]);
  }

  /**
   * Starts the record's deferred facts OFF the queue (wave 4 review): the
   * state change is already written and published, so the 10 s state target
   * never waits on process spawns; the metadata follows when it resolves.
   */
  function startFollowUp(record: KnownHookRecord): void {
    if (stopped) return;
    let pending: Promise<DeferredSessionFacts> | null;
    try {
      pending = deps.facts.deferredFactsFor?.(record) ?? null;
    } catch (err: unknown) {
      logger.warn({ err }, "deferred session facts failed");
      return;
    }
    if (pending === null) return;
    const work = pending
      .then((facts) => enqueue(() => applyFollowUp(record, facts)))
      .catch((err: unknown) => {
        logger.warn({ err }, "deferred session facts failed");
      });
    followUps.add(work);
    void work.finally(() => followUps.delete(work));
  }

  async function ingestNow(input: unknown, via: "socket" | "spool"): Promise<IngestOutcome> {
    sequence += 1;
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
        // Never applied and never defaulted: the source reads as changed
        // until a later valid record of the same event (D-12, SESS-18).
        shapeOf(classified.event).lastInvalid = sequence;
        logger.warn(
          { via, event: classified.event, issuePaths: classified.issuePaths },
          "hook record shape changed; not applied",
        );
        return "shape-invalid";
      case "known": {
        shapeOf(classified.event).lastValid = sequence;
        const { eventId } = classified.record;
        if (appliedEventIds.has(eventId)) {
          logger.debug({ via, event: classified.event }, "hook record replayed; ignored");
          return "duplicate";
        }
        // Stored timestamps are always `toISOString()` form, whatever offset
        // the record was stamped with, so string comparisons in the store hold.
        const record = {
          ...classified.record,
          observedAt: new Date(classified.record.observedAt).toISOString(),
        } as KnownHookRecord;
        const facts = await deps.facts.factsFor(record);
        applyNow({ kind: "hook", record, facts });
        rememberApplied(eventId);
        lastEventAt = deps.now().toISOString();
        startFollowUp(record);
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
    reattribute: (runId, attribution) =>
      enqueue(() => {
        const run = index.byRunId(runId);
        if (run === null) return false;
        const projectId = attribution.projectId ?? run.projectId;
        const worktreeRoot = attribution.worktreeRoot ?? run.worktreeRoot;
        if (projectId === run.projectId && worktreeRoot === run.worktreeRoot) return false;
        writeAndPublish([{ ...run, projectId, worktreeRoot, revision: run.revision + 1 }]);
        return true;
      }),
    backfillPidStart: (runId, pidStartedAt) =>
      enqueue(() => {
        const run = index.byRunId(runId);
        if (run === null || run.pidStartedAt !== null || isTerminalRunState(run.state)) {
          return false;
        }
        writeAndPublish([{ ...run, pidStartedAt, revision: run.revision + 1 }]);
        return true;
      }),
    listSessionViews() {
      const endedSince = new Date(deps.now().getTime() - VIEW_ENDED_WINDOW_MS).toISOString();
      const names = projectNames();
      return listSessionRunsForView(db, { endedSince }).map((run) => viewOf(run, names));
    },
    health() {
      let shapeChanged: KnownHookEvent | null = null;
      let newest = 0;
      for (const [event, history] of shapes) {
        if (history.lastInvalid > history.lastValid && history.lastInvalid > newest) {
          shapeChanged = event;
          newest = history.lastInvalid;
        }
      }
      return { lastEventAt, unknownEventCount, rejectedEdgeCount, shapeChanged };
    },
    onRunSettled(listener) {
      settledListeners.add(listener);
      return () => {
        settledListeners.delete(listener);
      };
    },
    async stop() {
      stopped = true;
      for (const cancel of flushTimers.values()) cancel();
      flushTimers.clear();
      // Follow-ups started before stop still write through the queue; wait
      // for them (none start after stop), so none runs against a closed store.
      await enqueue(() => undefined);
      while (followUps.size > 0) await Promise.allSettled([...followUps]);
      // Queued behind every in-flight ingest and apply, so their writes land
      // before this final flush and before the caller closes the store.
      await enqueue(() => writeAndPublish([...pending.values()]));
    },
  };
}
