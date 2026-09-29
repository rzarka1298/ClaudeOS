import type { ClaudeIntegrationStatus } from "@ccc/domain";
import { type App, Notice, type Plugin, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import {
  applyMotionPreference,
  type MediaQueryListLike,
  type MotionPreference,
} from "../motion.js";
import { formatAbsoluteTime, formatRelativeTime } from "../widgets/relative-time.js";

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

// --- Claude section (UI-SPEC S5, D-48) -- RED scaffold, Task 1 -----------
// Exports the right shapes so settings-tab.test.ts resolves and fails on
// real assertions rather than a module-resolution crash. GREEN replaces
// every body below with the real implementation.

export const CLAUDE_GROUP_HEADING = "Claude";
export const CLAUDE_HOOKS_NAME = "Claude Code hooks";
export const CLAUDE_HOOKS_NOT_INSTALLED_TEXT =
  "Not installed. Session tracking and waiting-for-approval states need them.";
export const CLAUDE_STATUS_UNAVAILABLE_TEXT =
  "Status unavailable — the companion service isn't running.";
export const CLAUDE_COPY_INSTALL_NAME = "Copy install command";
export const CLAUDE_COPY_INSTALL_DESC = "TODO";
export const CLAUDE_COPY_UNINSTALL_NAME = "Copy uninstall command";
export const CLAUDE_COPY_UNINSTALL_DESC = "TODO";
export const CLAUDE_STATUSLINE_NAME = "Status-line wrapper";
export const CLAUDE_TRANSCRIPT_ANALYSIS_NAME = "Transcript analysis";
export const CLAUDE_TRANSCRIPT_ANALYSIS_DESC = "TODO";
export const CLAUDE_TRANSCRIPT_ANALYSIS_FAILED_NOTICE =
  "Couldn't change transcript analysis. The companion service didn't respond.";
export const CLAUDE_DELETE_USAGE_NAME = "Delete cached usage analytics";
export const CLAUDE_DELETE_USAGE_DESC = "TODO";
export const TRANSCRIPT_ANALYSIS_KEY = "claude.transcriptAnalysis";

export interface SettingsClaudeSeam {
  readonly getIntegration: () => Promise<ClaudeIntegrationStatus>;
  readonly setTranscriptAnalysis: (enabled: boolean) => Promise<{ enabled: boolean }>;
  readonly deleteUsageAnalytics: () => Promise<void>;
  readonly copyText: (text: string) => Promise<void>;
}

export type ClaudeSettingOutcome = "saved" | "reverted";

type HookStatusInput =
  | "checking"
  | "unavailable"
  | Pick<ClaudeIntegrationStatus, "hooks" | "lastEventAt" | "telemetry">;

type StatusLineStatusInput =
  | "checking"
  | "unavailable"
  | Pick<ClaudeIntegrationStatus, "statusLine" | "statusLineReported">;

/** RED stub -- always wrong, so Test 4 fails on a real assertion. */
export function hookStatusText(_status: HookStatusInput, _now: number): string {
  return "";
}

/** RED stub -- always wrong, so Test 4 fails on a real assertion. */
export function statusLineStatusText(_status: StatusLineStatusInput, _now: number): string {
  return "";
}

/** RED stub -- never calls the seam, so Test 5 fails on a real assertion. */
export async function applyTranscriptAnalysisChange(
  _host: SettingsTabHost,
  _value: boolean,
): Promise<ClaudeSettingOutcome> {
  return "saved";
}

// --- end Claude section RED scaffold --------------------------------------

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
  /** The Claude settings section's service seam (UI-SPEC S5). Absent means not wired yet. */
  readonly claude?: SettingsClaudeSeam | undefined;
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
