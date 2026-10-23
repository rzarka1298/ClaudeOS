import { type App, Notice, type Plugin, PluginSettingTab } from "obsidian";
import type { MotionPreference } from "../motion.js";
import {
  CODEX_BRIDGE_NAME,
  CODEX_COPY_BRIDGE_NAME,
  CODEX_COPY_INSTALL_NAME,
  CODEX_COPY_UNINSTALL_NAME,
  CODEX_HOOKS_NAME,
  CODEX_LAUNCHER_NAME,
  CODEX_NOTIFY_NAME,
} from "./codex-settings.js";
import { requestDestination } from "./navigation-request.js";
import {
  asMotionPreference,
  CLAUDE_COPY_INSTALL_NAME,
  CLAUDE_COPY_UNINSTALL_NAME,
  CLAUDE_DELETE_USAGE_NAME,
  CLAUDE_HOOKS_NAME,
  CLAUDE_STATUSLINE_NAME,
  CLAUDE_TRANSCRIPT_ANALYSIS_NAME,
  applyReducedMotionChange as modelApplyReducedMotionChange,
  NOTIFY_APPROVALS_NAME,
  REBUILD_NAME,
  REDUCED_MOTION_DESC,
  REDUCED_MOTION_KEY,
  REDUCED_MOTION_NAME,
  REDUCED_MOTION_OPTIONS,
  type ReducedMotionOutcome,
  SEND_TEST_APPROVAL_NAME,
  type SettingsModelHost,
} from "./settings-model.js";
import { requestSettingsSection } from "./settings-sections.js";

/**
 * The plugin's native Obsidian settings tab (A11Y-03, 08-UI-SPEC S5, D-18, OD-1): exactly two
 * items. The Reduced motion dropdown stays here so it is findable in Obsidian's own settings
 * search, and a `Command center settings` pointer row opens the command center's Settings
 * destination, which is the one complete place for every other setting (plan 08-18).
 *
 * Built on Obsidian's declarative settings API (`getSettingDefinitions()` plus
 * `getControlValue`/`setControlValue`, public since 1.13.0) rather than an imperative
 * `display()`: the manifest's `minAppVersion` is 1.13.0, so
 * `obsidianmd/settings-tab/prefer-setting-definitions` requires the declarative form,
 * `require-display` is a no-op at that floor, and `no-deprecated-display` would flag a leftover
 * `display()` as dead code that Obsidian bypasses. This is also the only shape whose settings
 * appear in Obsidian's own settings search.
 *
 * This tab is the one place in the plugin that renders through Obsidian's own builder, so it is
 * deliberately NOT inside the command center's root container and deliberately carries no design
 * token: the Settings pane is Obsidian's chrome, and D-18 says the plugin does not restyle chrome
 * it does not own.
 */

/** The pointer row's name and description (08-UI-SPEC S5, verbatim). */
export const POINTER_NAME = "Command center settings";
export const POINTER_DESC =
  "Projects, launchers, integrations, approvals, security and diagnostics are in the Settings tab of the command center.";
/**
 * The pointer's action. Obsidian's declarative action row has no separate button label (the whole
 * row is the control), so the action's own name is kept findable as a search alias instead.
 */
export const POINTER_ACTION_LABEL = "Open settings";
/** The old Codex Launcher row's own action label, still findable (it was an alias on that row). */
const OLD_LAUNCHER_ACTION_LABEL = "Open launcher settings";

/**
 * Every setting that moved to the destination, by the name the owner knew it as, so searching
 * Obsidian's settings for one still finds a route to it. Built from the destination's own name
 * constants, never a second copy of the words.
 */
export const POINTER_ALIASES: string[] = [
  CLAUDE_TRANSCRIPT_ANALYSIS_NAME,
  CLAUDE_DELETE_USAGE_NAME,
  NOTIFY_APPROVALS_NAME,
  SEND_TEST_APPROVAL_NAME,
  REBUILD_NAME,
  CODEX_HOOKS_NAME,
  CLAUDE_HOOKS_NAME,
  CLAUDE_STATUSLINE_NAME,
  CODEX_BRIDGE_NAME,
  CLAUDE_COPY_INSTALL_NAME,
  CLAUDE_COPY_UNINSTALL_NAME,
  CODEX_COPY_INSTALL_NAME,
  CODEX_COPY_UNINSTALL_NAME,
  CODEX_COPY_BRIDGE_NAME,
  CODEX_LAUNCHER_NAME,
  CODEX_NOTIFY_NAME,
  OLD_LAUNCHER_ACTION_LABEL,
  POINTER_ACTION_LABEL,
];

/**
 * Everything the tab needs from the plugin, behind one typed seam. Production passes the plugin's
 * one `SettingsHost`, which is structurally a superset; tests pass a plain object.
 */
export interface SettingsTabHost extends SettingsModelHost {
  /** Shows a transient message. Defaults to Obsidian's `Notice` in production. */
  readonly notify?: (message: string) => void;
  /** Opens (or reveals) the command center view. */
  readonly revealView: () => void;
}

/** The outcome channel the native tab hands the model: the host's notifier, else Obsidian's `Notice`. */
function tabNotifier(host: SettingsTabHost): (message: string) => void {
  return (message) => {
    if (host.notify) host.notify(message);
    else new Notice(message);
  };
}

/**
 * The native tab's reduced-motion decision: the model's, with failures posted through the host's
 * notifier or, when it has none, Obsidian's own `Notice`.
 */
export function applyReducedMotionChange(
  host: SettingsTabHost,
  value: MotionPreference,
): Promise<ReducedMotionOutcome> {
  return modelApplyReducedMotionChange(host, value, tabNotifier(host));
}

export class CommandCenterSettingTab extends PluginSettingTab {
  private readonly host: SettingsTabHost;

  constructor(app: App, plugin: Plugin, host: SettingsTabHost) {
    super(app, plugin);
    this.host = host;
  }

  /**
   * `Open settings`: asks the destination for the visual section (where Reduced motion also
   * lives), asks the shell for the Settings tab, then reveals the view. The requests come first so
   * a view that is created by the reveal finds them waiting when it mounts.
   */
  private openCommandCenterSettings(): void {
    requestSettingsSection("visual");
    requestDestination("settings");
    this.host.revealView();
  }

  getSettingDefinitions() {
    const reducedMotionItem = {
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
    };
    const pointerItem = {
      name: POINTER_NAME,
      desc: POINTER_DESC,
      aliases: [...POINTER_ALIASES],
      action: (_el: HTMLElement, _index: number) => {
        this.openCommandCenterSettings();
      },
    };
    // A tuple (not an array literal) keeps each element's own literal shape distinct -- callers
    // can index a specific position (`definitions[0].control`) without a type guard.
    return [reducedMotionItem, pointerItem] as [typeof reducedMotionItem, typeof pointerItem];
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
