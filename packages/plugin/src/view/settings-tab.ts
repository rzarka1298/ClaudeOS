import { type App, Notice, type Plugin, PluginSettingTab } from "obsidian";
import {
  applyMotionPreference,
  type MediaQueryListLike,
  type MotionPreference,
} from "../motion.js";

/**
 * The plugin's Settings tab — the owner's override for reduced motion
 * (A11Y-03, UI-SPEC E8).
 *
 * Built on Obsidian's declarative settings API (`getSettingDefinitions()` plus
 * `getControlValue`/`setControlValue`, public since 1.13.0) rather than an
 * imperative `display()`: the manifest's `minAppVersion` is 1.13.0, so
 * `obsidianmd/settings-tab/prefer-setting-definitions` requires the
 * declarative form, `require-display` is a no-op at that floor, and
 * `no-deprecated-display` would flag a leftover `display()` as dead code that
 * Obsidian bypasses. This is also the only shape whose settings appear in
 * Obsidian's own settings search.
 *
 * This tab is the one place in the plugin that renders through Obsidian's own
 * builder, so it is deliberately NOT inside `.ccc-command-center` and
 * deliberately carries no `--ccc-*` token: the Settings pane is Obsidian's
 * chrome, and D-18 says the plugin does not restyle chrome it does not own.
 */

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
 * Everything the tab needs from the plugin, behind one typed seam — the same
 * shape `setup-command.ts` uses. Production passes the plugin; tests pass a
 * plain object, and neither needs a cast.
 */
export interface SettingsTabHost {
  readonly settings: { reducedMotion: MotionPreference };
  // Property-style (not method-shorthand) signatures: these are handed
  // around as standalone values, so `this` must never be implied by the
  // call site (`@typescript-eslint/unbound-method` at error).
  readonly saveSettings: () => Promise<void>;
  readonly mql: Pick<MediaQueryListLike, "matches">;
  /** Shows a transient message. Defaults to Obsidian's `Notice` in production. */
  readonly notify?: (message: string) => void;
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
 * failure the in-memory setting is restored to what is actually on disk, a
 * `Notice` says so, and the motion mode is left exactly as it was — the caller
 * reverts its own control to match (UI-SPEC E8 error row).
 */
export async function applyReducedMotionChange(
  host: SettingsTabHost,
  value: MotionPreference,
): Promise<ReducedMotionOutcome> {
  const previous = host.settings.reducedMotion;
  host.settings.reducedMotion = value;
  try {
    await host.saveSettings();
  } catch {
    host.settings.reducedMotion = previous;
    if (host.notify) host.notify(REDUCED_MOTION_SAVE_FAILED);
    else new Notice(REDUCED_MOTION_SAVE_FAILED);
    return "reverted";
  }
  applyMotionPreference(value, host.mql);
  return "saved";
}

/** Narrows an arbitrary persisted value; anything unrecognised is `auto` (T-03-12). */
export function asMotionPreference(value: unknown): MotionPreference {
  return value === "reduced" ? "reduced" : "auto";
}

export class CommandCenterSettingTab extends PluginSettingTab {
  private readonly host: SettingsTabHost;

  constructor(app: App, plugin: Plugin, host: SettingsTabHost) {
    super(app, plugin);
    this.host = host;
  }

  getSettingDefinitions() {
    return [
      {
        name: REDUCED_MOTION_NAME,
        desc: REDUCED_MOTION_DESC,
        control: {
          type: "dropdown" as const,
          key: REDUCED_MOTION_KEY,
          // A `data.json` written before this key existed already resolved to
          // `auto` through DEFAULT_SETTINGS, so the partial case needs no
          // special handling here (UI-SPEC E8 partial row).
          defaultValue: "auto",
          options: { ...REDUCED_MOTION_OPTIONS },
        },
      },
    ];
  }

  getControlValue(key: string): unknown {
    if (key === REDUCED_MOTION_KEY) return this.host.settings.reducedMotion;
    return super.getControlValue(key);
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key !== REDUCED_MOTION_KEY) {
      await super.setControlValue(key, value);
      return;
    }
    const outcome = await applyReducedMotionChange(this.host, asMotionPreference(value));
    // `update()` re-reads every control through `getControlValue`, so a
    // reverted save puts the dropdown back on the persisted value without the
    // tab tracking a second copy of it. `display()` would not refresh a
    // declarative setting on 1.13+.
    if (outcome === "reverted") this.update();
  }
}
