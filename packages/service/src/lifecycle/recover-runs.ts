import { listNonTerminalRuns, recoverRunToStale } from "@ccc/operational-store";
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
 * work to a terminal state it did not earn. Idempotent by construction: a
 * Run already `stale` is not among `listNonTerminalRuns()`'s four
 * non-terminal members, so a second call finds nothing left to reconcile.
 *
 * Called from `main.ts` after `applyMigrations` and before the socket
 * begins accepting connections, so nothing observes a Run's pre-recovery
 * state over the API.
 */
export function recoverInterruptedRuns(db: Database.Database, logger: Logger): number {
  const interrupted = listNonTerminalRuns(db);
  for (const run of interrupted) {
    recoverRunToStale(db, run.runId);
  }
  logger.info({ count: interrupted.length }, "reconciled interrupted runs to stale");
  return interrupted.length;
}
