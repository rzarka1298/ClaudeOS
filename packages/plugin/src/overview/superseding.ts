import type { Signal } from "@preact/signals";
import type { FeedSnapshot } from "./overview-feeds.js";

/**
 * One owner of a feed's sequence token (09-06, D-13).
 *
 * `refresh()` asks `fetcher` and writes the answer into `feed`. A later `refresh()` supersedes an
 * earlier one still in flight, so a slow answer can never overwrite a newer one. A failure keeps
 * the last good value and marks the feed settled and failed. `invalidate()` makes every answer
 * still in flight land nowhere (teardown, tests).
 *
 * This is the rule the three Overview refreshers each carried a copy of; a new feed gets it by
 * construction.
 */
export function superseding<T>(
  feed: Signal<FeedSnapshot<T>>,
  fetcher: () => Promise<T>,
): { refresh(): Promise<void>; invalidate(): void } {
  let seq = 0;
  return {
    async refresh(): Promise<void> {
      const mine = ++seq;
      let answer: T | null = null;
      try {
        answer = await fetcher();
      } catch {
        answer = null;
      }
      if (mine !== seq) return;
      const previous = feed.peek();
      feed.value =
        answer === null
          ? { ...previous, settled: true, failed: true }
          : { settled: true, value: answer, fetchedAt: Date.now(), failed: false };
    },
    invalidate(): void {
      seq += 1;
    },
  };
}
