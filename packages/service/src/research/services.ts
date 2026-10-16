import {
  newRunId,
  RESEARCH_JOB_ID,
  type ResearchSourcesConfig,
  type ResearchUpdatedPayload,
  type RunId,
} from "@ccc/domain";
import {
  getResearchRunStatus,
  getRun,
  recoverJobRunsToStale,
  recoverRunToStale,
  startJobRun,
} from "@ccc/operational-store";
import { manualJobRunKey } from "@ccc/scheduler";
import type Database from "better-sqlite3";
import type { EventBus } from "../events/event-bus.js";
import type { SafeFetcher } from "./fetch/index.js";
import { newNonce } from "./hash.js";
import {
  createRunTrace,
  executeResearchRun,
  finishRun,
  type PipelineLog,
  type ResearchPipelineDeps,
  recordRunNote,
  type SummariserChoice,
  type Watchdog,
} from "./pipeline.js";
import { nameEffect, PIPELINE_EFFECTS, type PipelineEffect } from "./pipeline-effects.js";
import { loadResearchSources, type ResearchSourcesFs } from "./sources-config.js";

/**
 * The research run services (plan 07-12; D-18, D-19, D-25, RSRCH-06). `runNow` is the one entry
 * point: it refuses when no vault is set up, answers the run already in flight when there is one
 * (a second press starts nothing), and otherwise starts a paired job run under the manual key,
 * announces it and launches the pipeline WITHOUT awaiting it. The promise is tracked so shutdown
 * and tests can wait for it (`idle`).
 *
 * Construct once per process, at boot, after the migrations and the startup recovery: creating
 * the services sweeps any job run still marked in flight (a previous process cannot be running it)
 * to `stale`, never to a terminal state it did not earn.
 */

/** How long a run may take before the watchdog ends it: fetches are bounded at 15 s each, the model call at 120 s. */
export const RESEARCH_WATCHDOG_MS = 5 * 60 * 1000;

export type ResearchResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: "vault-not-set-up" };

export interface RunNowValue {
  readonly runId: RunId;
  /** True when a run was already in flight: nothing was started. */
  readonly alreadyRunning: boolean;
  readonly state: "running";
}

export interface ConfiguredSources {
  readonly topicLabel: string;
  readonly sources: readonly { readonly label: string; readonly host: string }[];
}

export interface ResearchServicesDeps {
  readonly db: Database.Database;
  /** The managed vault root, or null when no vault has been set up. */
  readonly getVaultRoot: () => string | null;
  /** Where `research-sources.json` lives. */
  readonly runtimeDir: string;
  readonly eventBus: Pick<EventBus, "publish">;
  readonly fetcher: Pick<SafeFetcher, "fetchSources">;
  readonly chooseSummariser: (
    config: ResearchSourcesConfig,
  ) => SummariserChoice | Promise<SummariserChoice>;
  readonly now: () => Date;
  readonly log: PipelineLog;
  readonly newNonce?: () => string;
  /** Default {@link RESEARCH_WATCHDOG_MS}. */
  readonly watchdogMs?: number;
  /** Starts a timer and returns its cancel function. Default: a real, unref'd timer. */
  readonly scheduleTimeout?: Watchdog["schedule"];
  readonly sourcesFs?: ResearchSourcesFs;
  /** Observes each classified effect step as it happens (diagnostics and tests). */
  readonly audit?: (operation: PipelineEffect) => void;
}

export interface ResearchServices {
  runNow(): ResearchResult<RunNowValue>;
  /** Resolves when no run is in flight in this process. */
  idle(): Promise<void>;
  /** The owner's configured topic and sources (host names only), or null when the file is unusable. */
  configuredSources(): ConfiguredSources | null;
}

const NON_TERMINAL_RUN_STATES: ReadonlySet<string> = new Set([
  "queued",
  "starting",
  "running",
  "waiting-for-approval",
]);

/**
 * Moves every research job run still marked in flight to `stale` (and its paired run, when that
 * is still non-terminal). Used at startup and when a press finds an in-flight row this process
 * does not own. Writes `stale` only: no outcome, no end time, nothing invented. Returns how many
 * job runs changed.
 */
export function recoverStuckResearchRuns(db: Database.Database, log: PipelineLog): number {
  const sweep = db.transaction((): number => {
    const stuck = getResearchRunStatus(db, RESEARCH_JOB_ID).inFlight;
    if (stuck === null) return 0;
    const run = getRun(db, stuck.jobRunId);
    if (run !== null && NON_TERMINAL_RUN_STATES.has(run.state))
      recoverRunToStale(db, stuck.jobRunId);
    return recoverJobRunsToStale(db, [stuck.jobRunId]);
  });
  const changed = sweep.immediate();
  if (changed > 0) {
    try {
      log.warn({ event: "research-stuck-runs-recovered", count: changed });
    } catch {
      // A broken log sink never stops a run from starting.
    }
  }
  return changed;
}

function realSchedule(fire: () => void, ms: number): () => void {
  const timer = setTimeout(fire, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

export function createResearchServices(deps: ResearchServicesDeps): ResearchServices {
  const watchdog: Watchdog = {
    ms: deps.watchdogMs ?? RESEARCH_WATCHDOG_MS,
    schedule: deps.scheduleTimeout ?? realSchedule,
  };
  /** The run this process is executing, if any. */
  let current: { readonly runId: RunId } | null = null;
  const tracked = new Set<Promise<void>>();

  recoverStuckResearchRuns(deps.db, deps.log);

  const publish = (payload: ResearchUpdatedPayload): void => {
    deps.eventBus.publish("research.updated", payload);
  };

  function launch(pipelineDeps: ResearchPipelineDeps, runId: RunId, startedAt: string): void {
    const trace = createRunTrace(runId, startedAt);
    current = { runId };
    // If anything before the run is tracked throws, the lock must not stay set: a dead run id
    // would otherwise answer every later press (the row left in flight is swept on the next press).
    let launched = false;
    try {
      // The owner's press is the trigger effect: one press, one run.
      nameEffect(pipelineDeps.audit, PIPELINE_EFFECTS.trigger);
      try {
        publish({ runId, state: "running" });
      } catch {
        // A broken event bus never stops a run.
      }
      recordRunNote(pipelineDeps, trace, null, null);
      const promise: Promise<void> = Promise.resolve()
        .then(() => executeResearchRun(pipelineDeps, trace, watchdog))
        .catch(() => {
          // executeResearchRun does not reject; if it ever did, the run still must not stay in flight.
          finishRun(pipelineDeps, trace, {
            outcome: "failure",
            errorCode: "interrupted",
            sourceCount: 0,
            sourceTotal: trace.sourceTotal,
            reportNoteId: null,
            unavailable: [],
          });
        })
        .finally(() => {
          if (current?.runId === runId) current = null;
          tracked.delete(promise);
        });
      tracked.add(promise);
      launched = true;
    } finally {
      if (!launched && current?.runId === runId) current = null;
    }
  }

  function runNow(): ResearchResult<RunNowValue> {
    const vaultRoot = deps.getVaultRoot();
    if (vaultRoot === null) return { ok: false, code: "vault-not-set-up" };
    if (current !== null) {
      return { ok: true, value: { runId: current.runId, alreadyRunning: true, state: "running" } };
    }

    const pipelineDeps: ResearchPipelineDeps = {
      db: deps.db,
      vaultRoot,
      runtimeDir: deps.runtimeDir,
      fetcher: deps.fetcher,
      chooseSummariser: deps.chooseSummariser,
      now: deps.now,
      newNonce: deps.newNonce ?? newNonce,
      log: deps.log,
      publish,
      ...(deps.sourcesFs === undefined ? {} : { sourcesFs: deps.sourcesFs }),
      ...(deps.audit === undefined ? {} : { audit: deps.audit }),
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const runId = newRunId();
      const startedAt = deps.now().toISOString();
      const started = startJobRun(deps.db, {
        jobRunId: runId,
        jobKey: RESEARCH_JOB_ID,
        idempotencyKey: manualJobRunKey(RESEARCH_JOB_ID, runId),
        trigger: "manual",
        startedAt,
      });
      if (started.started) {
        launch(pipelineDeps, runId, startedAt);
        return { ok: true, value: { runId, alreadyRunning: false, state: "running" } };
      }
      if ("inFlightRunId" in started) {
        if (current !== null || attempt === 1) {
          return {
            ok: true,
            value: { runId: started.inFlightRunId, alreadyRunning: true, state: "running" },
          };
        }
        // A row marked in flight that this process is not running (a run left behind): it would
        // block every later press. Mark it stale and start again once.
        recoverStuckResearchRuns(deps.db, deps.log);
      }
      // duplicate-key cannot happen for a fresh run id; treat it as a retry.
    }
    throw new Error("a research run could not be started");
  }

  return {
    runNow,
    async idle() {
      while (tracked.size > 0) await Promise.allSettled([...tracked]);
    },
    configuredSources() {
      const loaded = loadResearchSources(deps.runtimeDir, deps.sourcesFs);
      if (!loaded.ok) return null;
      return {
        topicLabel: loaded.config.topicLabel,
        sources: loaded.config.sources.map((entry) => ({
          label: entry.label,
          host: new URL(entry.url).hostname,
        })),
      };
    },
  };
}
