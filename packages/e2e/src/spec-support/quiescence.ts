/**
 * A bounded quiescence check for absence claims (Wave 3 WR-09): "nothing else happened" has no
 * event to wait on, so the observed state must stay unchanged for a whole quiet window, sampled
 * repeatedly, within a time limit. A fixed pause passes vacuously when a late effect arrives
 * after it; this does not, as long as the effect arrives inside the window.
 */

export interface QuietOptions<T> {
  /** Reads the observed state; compared by JSON text. */
  sample: () => Promise<T> | T;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** The state must stay unchanged for this long. */
  quietMs: number;
  intervalMs: number;
  /** Give up (not quiet) after this long in total. */
  timeoutMs: number;
}

export interface QuietResult<T> {
  quiet: boolean;
  /** The last sampled state. */
  value: T;
  samples: number;
}

export async function waitUntilQuiet<T>(options: QuietOptions<T>): Promise<QuietResult<T>> {
  const started = options.now();
  let last = await options.sample();
  let lastKey = JSON.stringify(last);
  let quietSince = options.now();
  let samples = 1;
  for (;;) {
    if (options.now() - quietSince >= options.quietMs) return { quiet: true, value: last, samples };
    if (options.now() - started >= options.timeoutMs) return { quiet: false, value: last, samples };
    await options.sleep(options.intervalMs);
    const next = await options.sample();
    samples += 1;
    const nextKey = JSON.stringify(next);
    if (nextKey !== lastKey) {
      last = next;
      lastKey = nextKey;
      quietSince = options.now();
    }
  }
}
