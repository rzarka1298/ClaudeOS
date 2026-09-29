import type { VNode } from "preact";

/**
 * RED scaffold (05-10 Task 2, TDD). `source-disclosure.test.tsx` resolves
 * its import against this file and fails on real assertions — the
 * component below renders an inert placeholder. GREEN replaces this with
 * the real disclosure, mirroring `footer.tsx`'s mechanics exactly.
 */

export interface SourceDisclosureRow {
  readonly numberLabel: string;
  readonly source: string;
  readonly range: string;
  readonly observed: string;
  readonly freshness: string;
  readonly partial?: string | undefined;
}

export interface SourceDisclosureProps {
  readonly srSuffix: string;
  readonly rows: readonly SourceDisclosureRow[];
  readonly disabled?: boolean;
}

export function SourceDisclosure(_props: SourceDisclosureProps): VNode {
  return <span />;
}
