/**
 * Feature flags are a typed IN-CODE constant (ADR-0023 "Feature flags",
 * research OQ3). There is no flag UI and no persisted flag state.
 *
 * The rejected alternative was a toggle per widget in plugin settings, which
 * turns an internal kill-switch into a user-editable contract — the same
 * reversibility trap `D-10` flags for the layout override — for a single-user
 * tool where editing this file and reloading is already the fastest path.
 *
 * Every registered widget is `true`. Flags exist so a LATER phase can land a
 * widget dark, not so the owner gets a control panel; plan 03-07's
 * `composeLayout` skips a layout entry whose widget is flagged off and records
 * it in diagnostics, exactly as it treats an unknown id (`D-13`).
 */
export const FEATURE_FLAGS = {
  "widget.service-health": true,
  "widget.today": true,
  "widget.active-sessions": true,
  "widget.project-shortcuts": true,
  "widget.claude-usage": true,
  "widget.tech-intel": true,
  "widget.github-discoveries": true,
  "widget.quick-actions": true,
} as const satisfies Record<string, boolean>;

/** Every flag name registered above, whatever its value. */
export type FeatureFlag = keyof typeof FEATURE_FLAGS;

/**
 * The flags currently ON, as a set — the shape `composeLayout` wants at its
 * call site, derived from {@link FEATURE_FLAGS} rather than listed a second
 * time, so the two can never disagree.
 */
export const ENABLED_FLAGS: ReadonlySet<string> = new Set(
  Object.entries(FEATURE_FLAGS)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name),
);
