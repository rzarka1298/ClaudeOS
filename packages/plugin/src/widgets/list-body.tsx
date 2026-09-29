import type { SizeHint } from "@ccc/domain";
import { Fragment, type VNode } from "preact";
import type { DestinationId } from "../view/destinations.js";

/**
 * The one list body every list-bearing panel renders (UI-SPEC surface E4).
 *
 * Two rules live here rather than in each panel, because each panel getting
 * them right independently is exactly the discipline that decays:
 *
 * 1. **A card never grows past its grid span.** The row budget is a function
 *    of the size hint, so a panel handed 400 rows renders the same height as
 *    one handed 7, and the grid's `wide`/`tall` spans stay the honest
 *    description of a card's footprint.
 * 2. **Nothing is silently dropped.** Rows past the budget are reported by a
 *    `+{n} more` control that focuses the destination that owns the full
 *    list — the owner is told what is hidden and given the way to it.
 *
 * Zero rows render NOTHING: `resolveCardPresentation` has already turned an
 * empty observation into the `empty` presentation, and the frame owns that
 * copy (`Nothing here yet`). A list that rendered its own empty state would
 * be a second, drifting answer to the same question.
 */

/**
 * Rows that fit a card at each size (UI-SPEC "Layout and Grid Contract":
 * 3–6 rows for `medium`, up to 10 for `tall`). `wide` spans two COLUMNS, not
 * two rows, so it gets `medium`'s budget — its extra room is horizontal.
 */
export const ROW_BUDGET: Readonly<Record<SizeHint, number>> = {
  small: 3,
  medium: 6,
  wide: 6,
  tall: 10,
};

/** One meta-line segment: a decorative glyph (optional) plus its meaning as text. */
export interface MetaSegment {
  readonly glyph?: string;
  readonly text: string;
}

/** A visible glyph plus a screen-reader-only label, prepended to a row's primary line (S1 pinned marker). */
export interface PrimaryBadge {
  readonly hiddenLabel: string;
  readonly glyph: string;
}

export interface ListBodyProps<Row> {
  readonly rows: readonly Row[];
  readonly size: SizeHint;
  /** A stable identity per row, so Preact keys the list rather than the index. */
  readonly keyOf: (row: Row) => string;
  /** The row's Body-size line. Returns TEXT so the full value can reach `title`. */
  readonly renderPrimary: (row: Row) => string;
  /** The row's single Label-size meta line. Ignored when {@link renderMetaSegments} is given. */
  readonly renderMeta: (row: Row) => string;
  /**
   * The structured form of the meta line (UI-SPEC S1): one span per segment,
   * each optional glyph rendered `aria-hidden="true"` beside its own text
   * (A11Y-04), segments joined by " · ". Takes priority over `renderMeta`
   * when present; existing callers that pass only `renderMeta` are
   * unaffected (plan 04-07).
   */
  readonly renderMetaSegments?: (row: Row) => readonly MetaSegment[];
  /**
   * An optional visible glyph plus a visually-hidden label prepended to a
   * row's primary line (the S1 pinned marker: a visible `★` and a hidden
   * `Pinned: ` prefix, RA11Y-04's "every glyph is aria-hidden with a text
   * sibling" applied to the primary line, not just the meta line).
   */
  readonly primaryBadge?: (row: Row) => PrimaryBadge | null;
  /** Where the full list lives — the `+{n} more` control focuses it. */
  readonly moreDestination: DestinationId;
  /** The shell's destination focus, threaded from the frame via `WidgetBodyProps.onNavigate`. */
  readonly onMore?: ((destination: DestinationId) => void) | undefined;
}

/** The meta line as segments — `renderMetaSegments`' contract (UI-SPEC S1, A11Y-04). */
function MetaSegments({ segments }: { readonly segments: readonly MetaSegment[] }): VNode {
  return (
    <p className="ccc-list-meta ccc-meta-segments">
      {segments.map((segment, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are a fixed-order render output, never reordered or filtered independently.
        <Fragment key={index}>
          {index > 0 ? " · " : ""}
          {segment.glyph === undefined ? null : (
            <span className="ccc-meta-glyph" aria-hidden="true">
              {segment.glyph}
            </span>
          )}
          {segment.glyph === undefined ? "" : " "}
          {segment.text}
        </Fragment>
      ))}
    </p>
  );
}

export function ListBody<Row>({
  rows,
  size,
  keyOf,
  renderPrimary,
  renderMeta,
  renderMetaSegments,
  primaryBadge,
  moreDestination,
  onMore,
}: ListBodyProps<Row>): VNode | null {
  if (rows.length === 0) return null;

  const budget = ROW_BUDGET[size];
  const visible = rows.slice(0, budget);
  const hidden = rows.length - visible.length;

  return (
    <ul className="ccc-list">
      {visible.map((row) => {
        const primary = renderPrimary(row);
        const badge = primaryBadge?.(row) ?? null;
        const segments = renderMetaSegments?.(row);
        return (
          <li className="ccc-list-row" key={keyOf(row)}>
            {/* The clamp is CSS-only, so the full value stays in the DOM and
                therefore in the accessible name; `title` surfaces it on hover.
                No `aria-label` here — assistive technology ignores it on a
                role=paragraph element, and biome rejects it outright. */}
            <p className="ccc-list-primary ccc-clamp-2" title={primary}>
              {badge === null ? null : (
                <>
                  <span className="ccc-visually-hidden">{badge.hiddenLabel}</span>
                  <span className="ccc-meta-glyph" aria-hidden="true">
                    {badge.glyph}
                  </span>{" "}
                </>
              )}
              {primary}
            </p>
            {segments === undefined ? (
              <p className="ccc-list-meta">{renderMeta(row)}</p>
            ) : (
              <MetaSegments segments={segments} />
            )}
          </li>
        );
      })}
      {hidden > 0 && (
        // Not a `.ccc-list-row`: it reports rows, it is not one of them.
        <li className="ccc-list-overflow">
          {/* Plural-safe by construction: `+1 more` and `+3 more` are the same
              string, so `1 mores` cannot be written (UI-SPEC zero-one-many). */}
          <button type="button" className="ccc-list-more" onClick={() => onMore?.(moreDestination)}>
            {`+${hidden} more`}
          </button>
        </li>
      )}
    </ul>
  );
}
