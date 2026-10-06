// A hand-driven clock for the approval tests (06-08). Folder-private: never
// exported from the approval public entry. The engine reads time only through
// the `Clock` port, so a test moves "now" explicitly and every expiry, token
// age and ordering assertion is deterministic.
import type { Clock } from "@ccc/domain";

/** The default instant the tests start at: a fixed, round, ISO 8601 UTC millisecond string. */
export const TEST_EPOCH = "2026-10-06T12:00:00.000Z";

export interface TestClock extends Clock {
  /** Moves time forward by `ms` milliseconds. */
  advance(ms: number): void;
  /** Sets the clock to an exact instant. */
  set(iso: string): void;
}

export function createTestClock(start: string = TEST_EPOCH): TestClock {
  let current = Date.parse(start);
  return {
    now: () => new Date(current).toISOString(),
    advance(ms: number) {
      current += ms;
    },
    set(iso: string) {
      current = Date.parse(iso);
    },
  };
}
