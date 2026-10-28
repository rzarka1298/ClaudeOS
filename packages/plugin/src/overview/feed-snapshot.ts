/** What one feed currently knows. */
export interface FeedSnapshot<T> {
  /** True once at least one attempt has finished, whatever its outcome. */
  readonly settled: boolean;
  /** The last answer that arrived. Kept when a later refresh fails, so a stale view stays readable. */
  readonly value: T | null;
  /** When `value` arrived (epoch ms), or `null` when none has. */
  readonly fetchedAt: number | null;
  /** True when the most recent attempt failed. */
  readonly failed: boolean;
}
