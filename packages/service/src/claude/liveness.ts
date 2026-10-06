import { createHash } from "node:crypto";
import type { RunId, SessionRun } from "@ccc/domain";
import {
  listRegisteredProjects,
  listRevivableRuns,
  listSessionRunsForView,
} from "@ccc/operational-store";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { AttributeFn } from "./attribution.js";
import type { ClaudePipeline } from "./pipeline.js";
import { type ProcessFacts, startInstantMs } from "./process-facts.js";

/**
 * The process-liveness sweeper (D-19, D-22, RESEARCH Pattern 4 and Q5).
 * Every sweep reads the revivable Runs (`listRevivableRuns`: every active
 * session Run plus stale ones with a pid seen in the last 24 h), checks
 * their pids with one `kill(pid, 0)` pass, then reads the start times of the
 * pids that answered in ONE batched C-locale `ps`, and turns what it saw
 * into evidence for the pipeline's reducer:
 *
 * - A pid that is gone, or alive with an `lstart` different from the one
 *   stored at SessionStart (the PID was reused: another process), is
 *   remembered as first-seen-gone. Only after the grace period, when no
 *   SessionEnd has ended the Run meanwhile, does the sweep apply `pid-gone`.
 * - A pid alive with exactly the stored `lstart` applies `pid-alive` to a
 *   stale Run (revival). An unknown read `lstart` proves nothing either
 *   way, so it neither revives nor ends a Run.
 * - A Run with a pid but no stored start (hooks installed mid-session, or
 *   a failed SessionStart `ps`) is judged by the read start against its
 *   last hook activity (wave 4): a process that started no later than that
 *   activity held the pid then, so it is the Run's own process and its start
 *   is backfilled through `pipeline.backfillPidStart`; one that started
 *   after it is a reused pid and is treated as gone.
 * - A queued or starting Run with no SessionStart after the start timeout
 *   applies `start-timeout`; a PID-less running Run idle past the
 *   inactivity threshold applies `inactivity-timeout` (it has no process to
 *   check). Both make the Run `stale`.
 * - When the registered project set changes (a fingerprint of every
 *   project's id and root, checked each sweep), every unclassified Run that
 *   is non-terminal or ended within 7 days is attributed again, and a Run
 *   that now matches is re-published through `pipeline.reattribute`
 *   (metadata only, revision + 1, D-23).
 *
 * Nothing here ever infers an ending (SESS-06). `pid-gone` makes a Run
 * `stale` — unknown — and the reducer writes `cancelled` only when a
 * terminate was requested. This module never writes `completed` or
 * `failed`, never writes the store itself, and never signals a process:
 * signal 0 only asks whether the pid exists.
 */

export interface LivenessConfig {
  /** How often the sweep runs (`CCC_LIVENESS_SWEEP_MS`, default 5 s). */
  readonly sweepMs: number;
  /** How long a pid must stay gone before `pid-gone` (`CCC_LIVENESS_GRACE_MS`, default 10 s). */
  readonly graceMs: number;
  /** A queued/starting Run with no SessionStart for this long goes stale (`CCC_START_TIMEOUT_MS`, 60 s). */
  readonly startTimeoutMs: number;
  /** A PID-less Run idle this long goes stale (`CCC_PIDLESS_INACTIVITY_MS`, 30 min). */
  readonly pidlessInactivityMs: number;
}

export const DEFAULT_LIVENESS_CONFIG: LivenessConfig = {
  sweepMs: 5000,
  graceMs: 10_000,
  startTimeoutMs: 60_000,
  pidlessInactivityMs: 30 * 60 * 1000,
};

function positiveMs(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** The sweeper's timings, each overridable by its env knob (tests shrink them). */
export function livenessConfigFromEnv(env: NodeJS.ProcessEnv): LivenessConfig {
  return {
    sweepMs: positiveMs(env.CCC_LIVENESS_SWEEP_MS, DEFAULT_LIVENESS_CONFIG.sweepMs),
    graceMs: positiveMs(env.CCC_LIVENESS_GRACE_MS, DEFAULT_LIVENESS_CONFIG.graceMs),
    startTimeoutMs: positiveMs(env.CCC_START_TIMEOUT_MS, DEFAULT_LIVENESS_CONFIG.startTimeoutMs),
    pidlessInactivityMs: positiveMs(
      env.CCC_PIDLESS_INACTIVITY_MS,
      DEFAULT_LIVENESS_CONFIG.pidlessInactivityMs,
    ),
  };
}

/** What one sweep saw and did. Counts only: never a path or a pid. */
export interface SweepReport {
  /** Runs that carried a pid and were checked. */
  readonly checked: number;
  /** `pid-gone` evidence applied this sweep. */
  readonly gone: number;
  /** `pid-alive` evidence applied to stale Runs this sweep (revival). */
  readonly revived: number;
  /** Runs seen gone whose grace has not ended yet. */
  readonly pendingGone: number;
  /** `start-timeout` evidence applied this sweep. */
  readonly startTimeouts: number;
  /** `inactivity-timeout` evidence applied this sweep. */
  readonly inactivityTimeouts: number;
  /** Unclassified Runs given a project after a project-set change. */
  readonly reattributed: number;
  /** Runs whose missing process start was backfilled this sweep (wave 4). */
  readonly backfilled: number;
}

export interface LivenessSweeperDeps {
  readonly db: Database.Database;
  readonly pipeline: Pick<ClaudePipeline, "apply" | "reattribute" | "backfillPidStart">;
  readonly processFacts: Pick<ProcessFacts, "isAlive" | "readStartTimes">;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly config: LivenessConfig;
  /** Schedules `fn` after `ms`; returns a cancel. Defaults to an unref'd `setTimeout`. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  /** Attribution for re-evaluating unclassified Runs; absent, project changes are not watched. */
  readonly attribute?: AttributeFn;
}

export interface LivenessSweeper {
  /** Runs one sweep now (serialized with any timer sweep) and reports it. */
  sweepNow(): Promise<SweepReport>;
  /** Starts the periodic sweep. Idempotent. */
  start(): void;
  /** Stops the timer and waits for an in-flight sweep, so the store may close afterwards. */
  stop(): Promise<void>;
}

/**
 * What one sweep can say about a Run's process (D-19, T-05-47): `same` only
 * when the pid answered and its `lstart` equals the stored one exactly;
 * `gone` when it did not answer, or answered with a different `lstart` (a
 * reused PID is another process); `unknown` when it answered but either
 * start time is unknown (a failed `ps`, or none stored) — no evidence.
 */
function identityOf(
  run: SessionRun,
  answered: boolean,
  lstart: string | undefined,
): "same" | "backfill" | "gone" | "unknown" {
  if (!answered) return "gone";
  if (lstart === undefined) return "unknown";
  if (run.pidStartedAt === null) return ownProcessWithoutStart(run, lstart);
  return sameStart(lstart, run.pidStartedAt) ? "same" : "gone";
}

/**
 * A Run with no stored start (wave 4): the pid's process is the Run's own
 * when it started no later than the Run's last hook activity (a pid names
 * one process at a time, and a reuse can only start after the original
 * died, which is after that activity). A later start is a reused pid.
 */
function ownProcessWithoutStart(run: SessionRun, lstart: string): "backfill" | "gone" | "unknown" {
  const startMs = startInstantMs(lstart);
  const lastMs = Date.parse(run.lastActivityAt ?? run.startedAt);
  if (startMs === null || Number.isNaN(lastMs)) return "unknown";
  return startMs <= lastMs ? "backfill" : "gone";
}

/**
 * Two start times name the same process start when they are the same
 * instant (wave 4): `ps` now reports UTC ISO instants, while a Run stored
 * before that holds a local-time `lstart`. Unparsable values fall back to
 * exact text equality.
 */
function sameStart(read: string, stored: string): boolean {
  const a = startInstantMs(read);
  const b = startInstantMs(stored);
  return a !== null && b !== null ? a === b : read === stored;
}

/** How far back a terminal Run is still re-attributed (the views' 7-day window, UI-SPEC R-08). */
const REATTRIBUTE_ENDED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const START_PENDING_STATES: ReadonlySet<SessionRun["state"]> = new Set<SessionRun["state"]>([
  "queued",
  "starting",
]);

const PIDLESS_ACTIVE_STATES: ReadonlySet<SessionRun["state"]> = new Set<SessionRun["state"]>([
  "running",
  "waiting-for-approval",
]);

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

export function createLivenessSweeper(deps: LivenessSweeperDeps): LivenessSweeper {
  const { db, pipeline, processFacts, logger, config } = deps;
  const schedule = deps.schedule ?? defaultSchedule;
  /** When each Run's pid was first seen gone (ms, by `deps.now()`). In memory only. */
  const firstSeenGone = new Map<RunId, number>();
  let running = false;
  let stopped = false;
  let cancelTimer: (() => void) | null = null;
  /** Serializes sweeps: a timer sweep and a `sweepNow` never overlap. */
  let tail: Promise<unknown> = Promise.resolve();
  /** The project set last seen; undefined before the first sweep sets the baseline. */
  let projectFingerprint: string | undefined;

  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** A hash of every registered project's id and root, in a stable order. Never logged. */
  function fingerprintProjects(): string {
    const pairs = listRegisteredProjects(db)
      .map((project) => `${project.projectId}\u0000${project.root}`)
      .sort();
    return createHash("sha256").update(pairs.join("\u0001")).digest("hex");
  }

  /** Re-attributes unclassified live and 7-day-recent Runs; returns how many gained a project. */
  async function reattributeUnclassified(attribute: AttributeFn, nowMs: number): Promise<number> {
    const endedSince = new Date(nowMs - REATTRIBUTE_ENDED_WINDOW_MS).toISOString();
    const unclassified = listSessionRunsForView(db, { endedSince }).filter(
      (run) => run.projectId === null && run.cwd !== null,
    );
    let count = 0;
    for (const run of unclassified) {
      try {
        const attribution = await attribute({
          cwd: run.cwd,
          claudeSessionId: run.claudeSessionId,
        });
        if (attribution.projectId === null) continue;
        if (await pipeline.reattribute(run.runId, attribution)) count += 1;
      } catch (err: unknown) {
        logger.warn({ runId: run.runId, err }, "re-attribution failed; run left unclassified");
      }
    }
    return count;
  }

  /** Checks the project set; on a change, re-attributes. The first sweep only sets the baseline. */
  async function watchProjects(nowMs: number): Promise<number> {
    const attribute = deps.attribute;
    if (attribute === undefined) return 0;
    const fingerprint = fingerprintProjects();
    const previous = projectFingerprint;
    projectFingerprint = fingerprint;
    if (previous === undefined || previous === fingerprint) return 0;
    return reattributeUnclassified(attribute, nowMs);
  }

  async function sweep(): Promise<SweepReport> {
    const nowMs = deps.now().getTime();
    const observedAt = new Date(nowMs).toISOString();
    const candidates = listRevivableRuns(db, observedAt);

    // Runs with no process to check: a launch that never started, or a
    // PID-less session gone quiet (D-19).
    let startTimeouts = 0;
    let inactivityTimeouts = 0;
    for (const run of candidates) {
      if (
        START_PENDING_STATES.has(run.state) &&
        nowMs - Date.parse(run.startedAt) >= config.startTimeoutMs
      ) {
        await pipeline.apply({ kind: "start-timeout", runId: run.runId, observedAt });
        startTimeouts += 1;
      } else if (
        run.pid === null &&
        PIDLESS_ACTIVE_STATES.has(run.state) &&
        nowMs - Date.parse(run.lastActivityAt ?? run.startedAt) >= config.pidlessInactivityMs
      ) {
        await pipeline.apply({ kind: "inactivity-timeout", runId: run.runId, observedAt });
        inactivityTimeouts += 1;
      }
    }

    const withPid = candidates.filter(
      (run): run is SessionRun & { pid: number } =>
        run.pid !== null && !START_PENDING_STATES.has(run.state),
    );

    // One kill(0) pass, then one batched ps for the pids that answered.
    const answered = new Set(
      withPid.filter((run) => processFacts.isAlive(run.pid)).map((run) => run.pid),
    );
    const starts =
      answered.size > 0
        ? await processFacts.readStartTimes([...answered])
        : new Map<number, string>();

    const seen = new Set<RunId>();
    let gone = 0;
    let revived = 0;
    let backfilled = 0;
    for (const run of withPid) {
      seen.add(run.runId);
      const lstart = starts.get(run.pid);
      let identity = identityOf(run, answered.has(run.pid), lstart);
      if (identity === "backfill" && lstart !== undefined) {
        await pipeline.backfillPidStart(run.runId, lstart);
        backfilled += 1;
        identity = "same";
      }
      if (identity === "same") {
        firstSeenGone.delete(run.runId);
        if (run.state === "stale") {
          await pipeline.apply({ kind: "pid-alive", runId: run.runId, observedAt });
          revived += 1;
        }
        continue;
      }
      if (identity === "unknown") {
        firstSeenGone.delete(run.runId);
        continue;
      }
      // A stale Run is already unknown; only a pending terminate still has
      // an ending (cancelled) for its vanished process to prove.
      if (run.state === "stale" && run.terminateRequestedAt === null) {
        firstSeenGone.delete(run.runId);
        continue;
      }
      const first = firstSeenGone.get(run.runId);
      if (first === undefined) {
        firstSeenGone.set(run.runId, nowMs);
        continue;
      }
      if (nowMs - first >= config.graceMs) {
        firstSeenGone.delete(run.runId);
        await pipeline.apply({ kind: "pid-gone", runId: run.runId, observedAt });
        gone += 1;
      }
    }
    // A Run that ended (or left the candidate set) during its grace is forgotten.
    for (const runId of [...firstSeenGone.keys()]) {
      if (!seen.has(runId)) firstSeenGone.delete(runId);
    }

    const reattributed = await watchProjects(nowMs);

    const report: SweepReport = {
      checked: withPid.length,
      gone,
      revived,
      pendingGone: firstSeenGone.size,
      startTimeouts,
      inactivityTimeouts,
      reattributed,
      backfilled,
    };
    if (gone + revived + startTimeouts + inactivityTimeouts + reattributed + backfilled > 0) {
      logger.info(report, "liveness sweep applied evidence");
    }
    return report;
  }

  /** The next wake: the sweep interval, or sooner when a grace ends first. */
  function nextDelay(): number {
    const nowMs = deps.now().getTime();
    let delay = config.sweepMs;
    for (const first of firstSeenGone.values()) {
      delay = Math.min(delay, Math.max(0, first + config.graceMs - nowMs));
    }
    return delay;
  }

  function arm(): void {
    if (stopped) return;
    cancelTimer = schedule(() => {
      cancelTimer = null;
      serialized(sweep)
        .catch((err: unknown) => {
          logger.error({ err }, "liveness sweep failed");
        })
        .finally(() => {
          arm();
        });
    }, nextDelay());
  }

  return {
    sweepNow: () => serialized(sweep),
    start() {
      if (running || stopped) return;
      running = true;
      arm();
    },
    async stop() {
      stopped = true;
      cancelTimer?.();
      cancelTimer = null;
      await tail;
    },
  };
}
