import type { ApprovalLog } from "@ccc/domain";
import type { SweepSummary } from "./engine.js";

/**
 * The expiry sweeper (APPR-06, D-08, D-09, D-11). It owns only the timer: what
 * a sweep does, and how it is published, belongs to the engine
 * (`sweepExpired`). Expiry is enforced three ways: this periodic sweep, the
 * startup sweep that recovery runs before the socket opens, and the re-check
 * inside the decide transaction. There is no native notification for expiry
 * (D-11): nothing here, and nothing in the engine, can raise one.
 *
 * The timer functions are injected so a test drives time by hand and can see
 * that the handle is `unref`'d. The default wraps the global timers; the
 * composition root (06-21) may pass its own.
 *
 * Element: `approval`. Imports `@ccc/domain` and files in this folder only.
 */

/** Thirty to sixty seconds (D-09); the middle of the band. */
export const DEFAULT_SWEEP_INTERVAL_MS = 45_000;

/** What a timer hands back. `unref` keeps the sweep from holding the process open. */
export interface SweeperTimerHandle {
  unref?(): unknown;
}

export interface SweeperTimers {
  setInterval(fn: () => void, ms: number): SweeperTimerHandle;
  clearInterval(handle: SweeperTimerHandle): void;
}

/** The global timers, as the sweeper's default. */
export const globalSweeperTimers: SweeperTimers = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (handle) => {
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
  },
};

export interface ExpirySweeperDeps {
  /** What a sweep needs from the engine; a sweep may be synchronous or not. */
  readonly engine: { sweepExpired(): SweepSummary | Promise<SweepSummary> };
  /** Defaults to {@link DEFAULT_SWEEP_INTERVAL_MS}. */
  readonly intervalMs?: number;
  readonly timers?: SweeperTimers;
  readonly log: ApprovalLog;
}

export interface ExpirySweeper {
  /** Starts the periodic sweep. Idempotent: a second call does nothing. */
  start(): void;
  /** Stops the timer and waits for a sweep that is running, so the store may close afterwards. */
  stop(): Promise<void>;
  /** Runs one sweep now and reports it. A failing sweep is logged and reported as nothing changed. */
  sweepNow(): Promise<SweepSummary>;
}

const NOTHING: SweepSummary = { expired: 0, lapsed: 0 };

export function createExpirySweeper(deps: ExpirySweeperDeps): ExpirySweeper {
  const { engine, log } = deps;
  const intervalMs = deps.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const timers = deps.timers ?? globalSweeperTimers;
  let handle: SweeperTimerHandle | null = null;
  let running: Promise<SweepSummary> | null = null;

  async function sweepOnce(): Promise<SweepSummary> {
    try {
      return await engine.sweepExpired();
    } catch {
      // The error text is never read: it could name a row. One fixed code is the whole record.
      log.error({ code: "expiry-sweep-failed" });
      return NOTHING;
    }
  }

  function sweepNow(): Promise<SweepSummary> {
    // A sweep that is still running answers for this call too: sweeps never stack.
    if (running !== null) return running;
    // `finally` runs on a later turn, so `running` is always set before it is cleared.
    const current: Promise<SweepSummary> = sweepOnce().finally(() => {
      if (running === current) running = null;
    });
    running = current;
    return current;
  }

  function start(): void {
    if (handle !== null) return;
    handle = timers.setInterval(() => {
      void sweepNow();
    }, intervalMs);
    handle.unref?.();
  }

  async function stop(): Promise<void> {
    if (handle !== null) {
      timers.clearInterval(handle);
      handle = null;
    }
    if (running !== null) await running;
  }

  return { start, stop, sweepNow };
}
