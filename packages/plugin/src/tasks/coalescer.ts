/**
 * The pure path coalescer for vault change events (plan 06-18, research Pattern
 * 13, T-06-23). Paths are added from an O(1) handler; a flush happens a trailing
 * delay after the LAST event, but never later than a maximum wait after the
 * FIRST, so a steady stream cannot postpone it forever. More distinct paths than
 * the cap, or an explicit rescan request, collapse into one `{ rescan: true }`
 * batch: a sync tool or a git checkout becomes one request, not thousands.
 *
 * Time and timers are injected (`schedule` returns its own cancel function), so
 * the host registry can own the real timer and a test can drive a manual clock.
 * Nothing here reads the clock or touches a vault, a network or a module-level
 * variable.
 */
export type CoalescedBatch = { readonly paths: readonly string[] } | { readonly rescan: true };

export interface PathCoalescerDeps {
  /** Runs `callback` after `ms`; returns a function that cancels it. */
  readonly schedule: (callback: () => void, ms: number) => () => void;
  readonly now: () => number;
  readonly flush: (batch: CoalescedBatch) => void;
  /** Quiet period after the last event. Default 400 ms. */
  readonly trailingMs?: number;
  /** Longest a batch may wait after its first event. Default 2000 ms. */
  readonly maxWaitMs?: number;
  /** Distinct paths above this become a rescan. Default 200. */
  readonly maxPaths?: number;
}

export interface PathCoalescer {
  add(path: string): void;
  /** Requests a full rescan in place of any path list. */
  addRescan(): void;
  /** Drops everything buffered and any pending flush. */
  cancel(): void;
}

export const COALESCE_TRAILING_MS = 400;
export const COALESCE_MAX_WAIT_MS = 2000;
export const COALESCE_MAX_PATHS = 200;

export function createPathCoalescer(deps: PathCoalescerDeps): PathCoalescer {
  const trailingMs = deps.trailingMs ?? COALESCE_TRAILING_MS;
  const maxWaitMs = deps.maxWaitMs ?? COALESCE_MAX_WAIT_MS;
  const maxPaths = deps.maxPaths ?? COALESCE_MAX_PATHS;
  const paths = new Set<string>();
  let rescan = false;
  let firstAt: number | null = null;
  let cancelTimer: (() => void) | null = null;

  function reset(): void {
    paths.clear();
    rescan = false;
    firstAt = null;
    cancelTimer?.();
    cancelTimer = null;
  }

  function flushNow(): void {
    const batch: CoalescedBatch = rescan ? { rescan: true } : { paths: [...paths] };
    reset();
    deps.flush(batch);
  }

  function arm(): void {
    const now = deps.now();
    if (firstAt === null) firstAt = now;
    const untilMaxWait = Math.max(0, firstAt + maxWaitMs - now);
    cancelTimer?.();
    cancelTimer = deps.schedule(flushNow, Math.min(trailingMs, untilMaxWait));
  }

  return {
    add(path) {
      if (!rescan) {
        paths.add(path);
        if (paths.size > maxPaths) {
          rescan = true;
          paths.clear();
        }
      }
      arm();
    },
    addRescan() {
      rescan = true;
      paths.clear();
      arm();
    },
    cancel: reset,
  };
}
