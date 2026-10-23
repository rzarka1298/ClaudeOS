import { type CommandCenterSettings, DEFAULT_SETTINGS } from "../settings.js";
import type { SettingsCodexSeam } from "./codex-settings.js";
import type {
  SettingsApprovalsSeam,
  SettingsClaudeSeam,
  SettingsModelHost,
  SettingsTasksSeam,
} from "./settings-model.js";

/**
 * The one seam the Settings destination reaches the plugin through (plan 08-11, D-15, D-16).
 *
 * `main.ts` builds ONE of these in `onload` and hands the same instance to the native settings
 * tab and, through the view and the shell, to the destination, so the two surfaces cannot drift
 * (08-RESEARCH B 1.2). It extends {@link SettingsModelHost}, so the Obsidian-free apply functions
 * in `settings-model.ts` take it as it is; it is also structurally a `SettingsTabHost`, so the
 * tab takes the same object.
 *
 * It carries everything any of the nine sections needs, so waves 3 to 5 add section files but
 * never a `main.ts` change: the preferences and their save, the Claude, Codex, approvals and
 * tasks seams, the delete-usage modal opener, the clipboard, the vault-setup command runner and
 * the display inputs. Nothing in the display inputs is ever persisted (`assertNoPrivatePathValues`
 * stays in force): they are read into component state, shown as `~/...` display paths, and gone
 * with the view.
 *
 * Obsidian-free on purpose, like the model: the no-externals visual harness reaches this module.
 */

/** Strings the Paths, Security and Diagnostics sections show or compare; `null` means unknown. */
export interface SettingsDisplayInputs {
  /** The macOS home folder, the base for `~/...` display paths. */
  readonly homeDir: string | null;
  /** The resolved companion service socket path (the override if set, else the default). */
  readonly socketPath: string | null;
  /** The open vault's folder on disk, or `null` for a vault that is not a local folder. */
  readonly vaultBasePath: string | null;
  /** The open vault's name. */
  readonly vaultName: string | null;
  /** The macOS short user name (used by the bundle's privacy denylist, never displayed). */
  readonly userName: string | null;
  readonly pluginVersion: string | null;
  readonly obsidianVersion: string | null;
}

export interface SettingsHost extends SettingsModelHost {
  /** The persisted preferences. Exactly four keys ever reach `data.json` (D-16). */
  readonly settings: CommandCenterSettings;
  /** The Claude settings seam: status, transcript analysis, usage deletion, clipboard. */
  readonly claude: SettingsClaudeSeam;
  /** The Codex seam: status, clipboard, and the launcher hand-off. */
  readonly codex: SettingsCodexSeam;
  /** Send a test approval, and whether the service is reachable. */
  readonly approvals: SettingsApprovalsSeam;
  /** Rebuild the task index, and whether the service is reachable. */
  readonly tasks: SettingsTasksSeam;
  /** Opens the delete-usage confirmation modal; resolves `true` only on an explicit confirm. */
  readonly openDeleteUsageModal: (
    horizonDate: string | null,
    analysisOn: boolean,
  ) => Promise<boolean>;
  /** The clipboard port. Rejects when the clipboard refuses (an unfocused window). */
  readonly copyText: (text: string) => Promise<void>;
  /**
   * Runs the existing vault-setup flow (plan, confirm in its own modal, apply). The `Set up
   * vault` button only invokes it; the confirmation is the flow's own.
   */
  readonly runVaultSetup: () => Promise<void>;
  /**
   * Opens (or reveals) the command center view. The native tab's `Open settings` row uses it after
   * it has asked for the Settings tab and the visual section (plan 08-18).
   */
  readonly revealView: () => void;
  readonly display: SettingsDisplayInputs;
}

const UNAVAILABLE = (): Promise<never> => Promise.reject(new Error("no settings host"));

/**
 * A host that does nothing and reports everything as away: every service call rejects, the
 * service reads as not running, the display inputs are unknown. The shell uses a fresh one when
 * no host is passed, so it renders honestly with no plugin at all (the same idea as
 * `noLaunchersActions`), and the visual harness builds its fixtures from it.
 *
 * A factory, because the preferences are mutable: each caller gets its own copy.
 */
export function createInertSettingsHost(): SettingsHost {
  return {
    settings: { ...DEFAULT_SETTINGS },
    saveSettings: () => Promise.resolve(),
    mql: { matches: false },
    claude: {
      getIntegration: UNAVAILABLE,
      setTranscriptAnalysis: UNAVAILABLE,
      deleteUsageAnalytics: UNAVAILABLE,
      copyText: UNAVAILABLE,
    },
    codex: {
      getIntegration: UNAVAILABLE,
      copyText: UNAVAILABLE,
    },
    approvals: { sendTestApproval: () => {}, serviceAvailable: () => false },
    tasks: { rebuildTaskIndex: UNAVAILABLE, serviceAvailable: () => false },
    openDeleteUsageModal: () => Promise.resolve(false),
    copyText: UNAVAILABLE,
    runVaultSetup: () => Promise.resolve(),
    revealView: () => {},
    display: {
      homeDir: null,
      socketPath: null,
      vaultBasePath: null,
      vaultName: null,
      userName: null,
      pluginVersion: null,
      obsidianVersion: null,
    },
  };
}
