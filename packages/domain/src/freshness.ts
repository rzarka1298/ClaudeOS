/**
 * How current a Widget's data is. Exactly one applies at a time — this is
 * an exact four-member union, and `partial` is never a fifth Freshness
 * member (see {@link Partiality} for the orthogonal axis, per CONTEXT.md).
 */
export type Freshness = "live" | "cached" | "stale" | "unavailable";

/**
 * Whether one or more expected sources failed to contribute to a result.
 * Orthogonal to {@link Freshness} — a result can be `cached` and partial at
 * the same time.
 */
export interface Partiality {
  readonly partial: boolean;
  readonly missingSources?: readonly string[];
}
