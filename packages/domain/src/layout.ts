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

/**
 * The version of the layout-override document shape. A literal, not a range:
 * a file written for a future shape fails validation and the typed in-code
 * default renders instead, rather than half-applying (D-10, UI-SPEC E3 error row).
 */
export const LAYOUT_SCHEMA_VERSION = 1;

/**
 * One entry of an owner-authored layout override (D-10, threat T-03-02).
 *
 * UNTRUSTED INPUT: this arrives from a user-editable JSON file in the plugin
 * data folder. `widgetId` is only ever a LOOKUP KEY into the plugin's in-code
 * widget registry — never a path, never a module specifier, never a component
 * name to construct — so an entry can select a registered widget and nothing
 * else; an id the registry does not know is skipped and recorded, not rendered.
 * The bounded length here, and the bounded entry count below, are the
 * denial-of-service limits on that file.
 *
 * `.strict()` so an unknown key (a typo such as `sise`) is a validation error
 * the diagnostics can name, not a silently ignored field.
 */
export const layoutEntrySchema = z
  .object({
    widgetId: z.string().min(1).max(64),
    size: sizeHintSchema.optional(),
  })
  .strict();

/**
 * The whole override document. When present, its `entries` are the COMPLETE
 * ordered list — the plugin never merges default entries back in, so an owner
 * can hide a card by leaving it out. At most 64 entries (T-03-02).
 */
export const layoutOverrideSchema = z
  .object({
    schemaVersion: z.literal(LAYOUT_SCHEMA_VERSION),
    entries: z.array(layoutEntrySchema).max(64),
  })
  .strict();

export type LayoutOverride = z.infer<typeof layoutOverrideSchema>;
