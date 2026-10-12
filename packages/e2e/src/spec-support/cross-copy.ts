/**
 * Literal mirror for the cross-cutting specs (05.2-08). The specs may not import from the
 * plugin (e2e leaf element), so every string they match is copied here with its owner named;
 * cross-copy.test.ts reads the owning source file and fails when a literal drifts.
 */
export interface OwnedLiteral {
  readonly name: string;
  readonly value: string;
  /** Repository-relative file that owns the literal. */
  readonly file: string;
}

export const OWNED_LITERALS: readonly OwnedLiteral[] = [];

/** Constants the spec itself owns (not read from a product file); listed so the test can name them. */
export const SPEC_OWNED_NAMES: readonly string[] = [];

export const SYNTHETIC_MARKERS: readonly string[] = [];
export const NOTIFICATION_TITLE = "";
export const DENY_LABEL = "";
export const APPROVE_LABEL = "";
export const ALWAYS_ALLOW_PHRASES: readonly string[] = [];
