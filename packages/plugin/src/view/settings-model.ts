import {
  applyMotionPreference,
  type MediaQueryListLike,
  type MotionPreference,
} from "../motion.js";

/**
 * The Obsidian-free half of the Settings logic (plan 08-02, research B Pitfall 1).
 *
 * Everything here used to live in `settings-tab.ts`, which imports `obsidian`. The Settings
 * destination is Preact and is also rendered by the no-externals visual harness, which fails
 * loudly on a transitive `obsidian` import, so the decisions and the words they use moved here
 * unchanged. Nothing in this file constructs an Obsidian `Notice`: each apply function takes
 * its outcome channel as a required `notify` parameter (UI-SPEC R-17), which the native tab
 * points at a `Notice` and the destination points at its status line. `settings-tab.ts`
 * re-exports the moved names, so existing importers are unaffected.
 *
 * `settings-model.test.ts` pins this file's import graph (no `obsidian`, no `Notice`).
 */

/** Where an apply function reports a failure. Required: the model never picks a channel itself. */
export type Notify = (message: string) => void;

export const REDUCED_MOTION_KEY = "reducedMotion";

/** Sentence case throughout — `obsidianmd/ui/sentence-case` runs at error. */
export const REDUCED_MOTION_NAME = "Reduced motion";
export const REDUCED_MOTION_DESC =
  "Turn off number easing, the background twinkle and decorative transitions. " +
  "System follows the macOS accessibility setting.";
export const REDUCED_MOTION_SAVE_FAILED = "Couldn't save the reduced motion setting.";

/** The two option labels, exactly as the owner reads them. */
export const REDUCED_MOTION_OPTIONS: Readonly<Record<MotionPreference, string>> = {
  auto: "System",
  reduced: "Always reduced",
};

/**
 * What the apply functions need from the plugin: the persisted preferences, the save, and the
 * OS media query. The native tab's host and the destination's host both satisfy it.
 */
export interface SettingsModelHost {
  readonly settings: { reducedMotion: MotionPreference; notifyApprovals?: boolean };
  // Property-style (not method-shorthand) signatures: these are handed
  // around as standalone values, so `this` must never be implied by the
  // call site (`@typescript-eslint/unbound-method` at error).
  readonly saveSettings: () => Promise<void>;
  readonly mql: Pick<MediaQueryListLike, "matches">;
}

/** What `applyReducedMotionChange` did, so a caller can revert its own control. */
export type ReducedMotionOutcome = "saved" | "reverted";

/**
 * The whole decision, extracted from the renderer so it is testable without
 * Obsidian's DOM.
 *
 * Ordering is the point: the setting is persisted FIRST and the root attribute
 * is rewritten only after the save resolves. A UI that changed first and saved
 * second would show the owner a state the next reload silently discards. On
 * failure the in-memory setting is restored to what is actually on disk, `notify`
 * says so, and the motion mode is left exactly as it was — the caller
 * reverts its own control to match (UI-SPEC E8 error row).
 */
export async function applyReducedMotionChange(
  host: SettingsModelHost,
  value: MotionPreference,
  notify: Notify,
): Promise<ReducedMotionOutcome> {
  const previous = host.settings.reducedMotion;
  host.settings.reducedMotion = value;
  try {
    await host.saveSettings();
  } catch {
    host.settings.reducedMotion = previous;
    notify(REDUCED_MOTION_SAVE_FAILED);
    return "reverted";
  }
  applyMotionPreference(value, host.mql);
  return "saved";
}

/** Narrows an arbitrary persisted value; anything unrecognised is `auto` (T-03-12). */
export function asMotionPreference(value: unknown): MotionPreference {
  return value === "reduced" ? "reduced" : "auto";
}
