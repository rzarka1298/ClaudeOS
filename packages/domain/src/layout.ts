import { z } from "zod";

/**
 * The Overview's entire layout vocabulary (UI-04, ADR-0023 "Layout rules").
 *
 * Four values, each with an exact grid consequence: `small` and `medium`
 * occupy one column and one row, `wide` spans two columns, `tall` spans two
 * rows. There are no coordinates and no breakpoint-keyed layouts — order plus
 * a size hint is the whole language, which is why `D-10`'s optional JSON
 * layout override can never express something the in-code default cannot.
 *
 * This const is the single source: the plugin's `SizeHint` is re-exported from
 * here rather than re-declared (`packages/plugin/src/widgets/contract.ts`), and
 * plan 03-07's layout-override schema validates against {@link sizeHintSchema},
 * so a fifth hint cannot appear on one side of that boundary only.
 */
export const SIZE_HINTS = ["small", "medium", "wide", "tall"] as const;
export type SizeHint = (typeof SIZE_HINTS)[number];

/** Runtime validator for a persisted or user-authored size hint. */
export const sizeHintSchema = z.enum(SIZE_HINTS);
