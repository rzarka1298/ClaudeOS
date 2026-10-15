import {
  listNonTerminalRuns,
  recoverJobRunsToStale,
  recoverRunToStale,
} from "@ccc/operational-store";
import type Database from "better-sqlite3";
import type { Logger } from "pino";

/**
 * Reconciles every non-terminal Run left behind by a process that died
 * mid-execution: each is moved to `stale` (CONTEXT.md — the state of a Run
 * whose ending was never observed, distinct from `failed`, which is
 * evidence). `recoverRunToStale` writes the `state` column (and, for a
 * session Run, bumps `revision` so subscribers see the change — wave 2
 * review), so `endedAt` is left exactly as it was — null, since a
 * non-terminal Run has never ended and this recovery has no observed ending
 * to record. Session Runs are recovered too, not only automation Runs: D-22
 * puts every Run through stale at restart, and the liveness sweep
 * (`listRevivableRuns`) then revives the ones whose process is still alive.
 *
 * SVC-11: interrupted work must never be marked complete. This module
 * writes exactly one state, `stale`, and never `completed`, `failed`, or
 * `cancelled` — there is no code path here that could promote interrupted
 * work to a terminal state it did not earn. That covers `job_runs` too: no code here writes
 * a job run outcome. Idempotent by construction: a
 * Run already `stale` is not among `listNonTerminalRuns()`'s four
 * non-terminal members, so a second call finds nothing left to reconcile.
 *
 * A research Run (Phase 7) also has a `job_runs` row under the same id. Recovery moves that
 * row to `stale` in the same transaction (`recoverJobRunsToStale`, D-18), leaving its outcome
 * and end time null, for the same SVC-11 reason: an interrupted report generation is Unknown,
 * never failed, and a stale job run no longer blocks the next one.
 *
 * Called from `main.ts` after `applyMigrations` and before the socket
 * begins accepting connections, so nothing observes a Run's pre-recovery
 * state over the API.
 */
export function recoverInterruptedRuns(db: Database.Database, logger: Logger): number {
  // One immediate transaction: a Run and its paired job run (research Pitfall 9) move to stale
  // together or not at all, so a crash here can never leave `job_runs` running behind a stale
  // `runs` row, which the one-in-flight index would turn into a permanent block on the job.
  const recover = db.transaction((): number => {
    const interrupted = listNonTerminalRuns(db);
    for (const run of interrupted) {
      recoverRunToStale(db, run.runId);
    }
    recoverJobRunsToStale(
      db,
      interrupted.map((run) => run.runId),
    );
    return interrupted.length;
  });
  const count = recover.immediate();
  logger.info({ count }, "reconciled interrupted runs to stale");
  return count;
}
