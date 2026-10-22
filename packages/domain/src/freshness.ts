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
  /**
   * A plain, slash-free sentence for the Partial chip's hidden description
   * (plan 08-14, UI-SPEC R-12). When present it replaces the description the
   * footer would generate from `missingSources` (`N sources didn't respond: …`),
   * which falsely implies a failed attempt for a source that is simply not part
   * of this version. The visible chip word stays `Partial`. A display string
   * built by the widget; it never travels on the wire (`PartialitySchema` does
   * not carry it).
   */
  readonly summary?: string;
}
