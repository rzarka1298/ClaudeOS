import type { ClaudeIntegrationStatus } from "@ccc/domain";
import { effect } from "@preact/signals";
import { type App, Notice, type Plugin, PluginSettingTab } from "obsidian";
import type { MotionPreference } from "../motion.js";
import { codexIntegration, codexSnapshotEpoch } from "../widgets/codex-signals.js";
import { buildCodexGroup, CodexSettingsState, type SettingsCodexSeam } from "./codex-settings.js";
import {
  APPROVALS_GROUP_HEADING,
  asMotionPreference,
  CLAUDE_COPY_FAILED_NOTICE,
  CLAUDE_COPY_INSTALL_DESC,
  CLAUDE_COPY_INSTALL_NAME,
  CLAUDE_COPY_UNINSTALL_DESC,
  CLAUDE_COPY_UNINSTALL_NAME,
  CLAUDE_DELETE_USAGE_DESC,
  CLAUDE_DELETE_USAGE_NAME,
  CLAUDE_DELETE_USAGE_RETAINED_NOTE,
  CLAUDE_GROUP_HEADING,
  CLAUDE_HOOKS_NAME,
  CLAUDE_INSTALL_COMMAND,
  CLAUDE_INSTALL_COPIED_NOTICE,
  CLAUDE_STATUSLINE_NAME,
  CLAUDE_TRANSCRIPT_ANALYSIS_DESC,
  CLAUDE_TRANSCRIPT_ANALYSIS_NAME,
  CLAUDE_UNINSTALL_COMMAND,
  CLAUDE_UNINSTALL_COPIED_NOTICE,
  CLAUDE_USAGE_DELETE_FAILED_NOTICE,
  CLAUDE_USAGE_DELETED_NOTICE,
  type ClaudeSettingOutcome,
  hookStatusText,
  applyNotifyApprovalsChange as modelApplyNotifyApprovalsChange,
  applyReducedMotionChange as modelApplyReducedMotionChange,
  applyTranscriptAnalysisChange as modelApplyTranscriptAnalysisChange,
  NOTIFY_APPROVALS_DESC,
  NOTIFY_APPROVALS_KEY,
  NOTIFY_APPROVALS_NAME,
  REBUILD_DESC,
  REBUILD_FAILED_NOTICE,
  REBUILD_NAME,
  REBUILD_NEEDS_SERVICE,
  REBUILD_STARTED_NOTICE,
  REDUCED_MOTION_DESC,
  REDUCED_MOTION_KEY,
  REDUCED_MOTION_NAME,
  REDUCED_MOTION_OPTIONS,
  type ReducedMotionOutcome,
  rebuildSuccessNotice,
  SEND_TEST_APPROVAL_DESC,
  SEND_TEST_APPROVAL_NAME,
  SEND_TEST_APPROVAL_NEEDS_SERVICE,
  type SettingsApprovalsSeam,
  type SettingsModelHost,
  type SettingsTasksSeam,
  statusLineStatusText,
  TASKS_GROUP_HEADING,
  TRANSCRIPT_ANALYSIS_KEY,
} from "./settings-model.js";

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

// Every text constant, seam type and decision that does not need Obsidian lives in
// `settings-model.ts` (plan 08-02) and is re-exported here under the same names, so existing
// importers keep working. The three `apply*Change` functions below shadow the model's
// three-argument versions with the tab's two-argument ones (the tab supplies the notifier).
export * from "./settings-model.js";

/**
 * Everything the tab needs from the plugin, behind one typed seam — the same
 * shape `setup-command.ts` uses. Production passes the plugin; tests pass a
 * plain object, and neither needs a cast.
 */
export interface SettingsTabHost extends SettingsModelHost {
  /** Shows a transient message. Defaults to Obsidian's `Notice` in production. */
  readonly notify?: (message: string) => void;
  /** The Codex group's seam (plan 05.1-19, D-30). Absent means the group shows "Checking…" and copy is a no-op. */
  readonly codex?: SettingsCodexSeam | undefined;
  /** The Approvals group's seam (plan 06-23). Absent means the test action is unavailable. */
  readonly approvals?: SettingsApprovalsSeam | undefined;
  /** The Tasks group's seam (plan 06-23). Absent means Rebuild task index is unavailable. */
  readonly tasks?: SettingsTasksSeam | undefined;
  /**
   * Opens the delete-usage confirmation modal (UI-SPEC S4-d), resolving
   * `true` only on an explicit confirm. Behind a seam -- like every other
   * modal opener in this plugin -- so `settings-tab.ts` stays importable and
   * testable under Vitest without Obsidian's DOM (`obsidian-stub.ts`'s
   * `Modal`/`ButtonComponent` are deliberately inert).
   */
  readonly openDeleteUsageModal?:
    | ((horizonDate: string | null, analysisOn: boolean) => Promise<boolean>)
    | undefined;
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

/** The approval notifications toggle's decision with the tab's notifier (see the model). */
export function applyNotifyApprovalsChange(
  host: SettingsTabHost,
  value: boolean,
): Promise<"saved" | "reverted"> {
  return modelApplyNotifyApprovalsChange(host, value, tabNotifier(host));
}

/** The transcript-analysis toggle's decision with the tab's notifier (see the model). */
export function applyTranscriptAnalysisChange(
  host: SettingsTabHost,
  value: boolean,
): Promise<ClaudeSettingOutcome> {
  return modelApplyTranscriptAnalysisChange(host, value, tabNotifier(host));
}

export class CommandCenterSettingTab extends PluginSettingTab {
  private readonly host: SettingsTabHost;
  /** True while a task index rebuild is running, so a second press is ignored. */
  private rebuilding = false;
  /** `"checking"` until the service answers; `"unavailable"` after a failed fetch (UI-SPEC S5). */
  private claudeStatus: ClaudeIntegrationStatus | "checking" | "unavailable" = "checking";
  /** True while a `getIntegration()` call is in flight; a display during it starts no second one. */
  private claudeStatusInFlight = false;
  /** True while this tab's OWN `update()` runs, whose `getSettingDefinitions()` must not refetch. */
  private selfUpdating = false;
  /** The Codex group's status and fetch rule (plan 05.1-19): same behaviour as the Claude status above. */
  private readonly codexState: CodexSettingsState;
  private stopCodexLive: (() => void) | undefined;
  /** R-15: set once a successful write turns transcript analysis off; row 6 reflects it. */
  private transcriptJustDisabled = false;

  constructor(app: App, plugin: Plugin, host: SettingsTabHost) {
    super(app, plugin);
    this.host = host;
    this.codexState = new CodexSettingsState(host.codex?.getIntegration, () => {
      this.rerender();
    });
  }

  /**
   * F4: while the tab is shown, a snapshot after a reconnect (epoch bump) re-reads
   * the Codex status, and a pushed integration status replaces the shown one.
   */
  private armCodexLiveRefresh(): void {
    if (this.stopCodexLive) return;
    let first = true;
    let lastIntegration = codexIntegration.peek();
    this.stopCodexLive = effect(() => {
      codexSnapshotEpoch.value;
      const integration = codexIntegration.value;
      if (first) {
        first = false;
        return;
      }
      if (integration !== null && integration !== lastIntegration) {
        lastIntegration = integration;
        this.codexState.adopt(integration);
      } else {
        this.codexState.refresh();
      }
    });
  }

  hide(): void {
    this.stopCodexLive?.();
    this.stopCodexLive = undefined;
    super.hide();
  }

  getSettingDefinitions() {
    this.ensureClaudeStatusLoaded();
    if (!this.selfUpdating) this.codexState.load();
    this.armCodexLiveRefresh();
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
    const hookStatusItem = {
      name: CLAUDE_HOOKS_NAME,
      desc: hookStatusText(this.claudeStatus, Date.now()),
    };
    const copyInstallItem = {
      name: CLAUDE_COPY_INSTALL_NAME,
      desc: CLAUDE_COPY_INSTALL_DESC,
      action: (_el: HTMLElement, _index: number) => {
        void this.copyCommand(CLAUDE_INSTALL_COMMAND, CLAUDE_INSTALL_COPIED_NOTICE);
      },
    };
    const copyUninstallItem = {
      name: CLAUDE_COPY_UNINSTALL_NAME,
      desc: CLAUDE_COPY_UNINSTALL_DESC,
      action: (_el: HTMLElement, _index: number) => {
        void this.copyCommand(CLAUDE_UNINSTALL_COMMAND, CLAUDE_UNINSTALL_COPIED_NOTICE);
      },
    };
    const statusLineItem = {
      name: CLAUDE_STATUSLINE_NAME,
      desc: statusLineStatusText(this.claudeStatus, Date.now()),
    };
    const transcriptItem = {
      name: CLAUDE_TRANSCRIPT_ANALYSIS_NAME,
      desc: CLAUDE_TRANSCRIPT_ANALYSIS_DESC,
      control: {
        type: "toggle" as const,
        key: TRANSCRIPT_ANALYSIS_KEY,
        defaultValue: false,
        // Off-looking while the service's value is unknown would be a guess:
        // the toggle is only live once a status has actually been read.
        disabled: () => typeof this.claudeStatus !== "object",
      },
    };
    const deleteUsageItem = {
      name: CLAUDE_DELETE_USAGE_NAME,
      desc: this.deleteUsageDescription(),
      action: (_el: HTMLElement, _index: number) => {
        void this.handleDeleteUsage();
      },
    };
    const claudeGroup = {
      type: "group" as const,
      heading: CLAUDE_GROUP_HEADING,
      // A tuple cast keeps each item's own literal shape distinct (see the
      // note on the outer return below) -- row 1 and row 4 have no
      // `action`/`control` at all (matching Obsidian's `SettingDefinitionEmpty`),
      // rows 2/3/6 have `action` only, and row 5 has `control` only, exactly
      // as UI-SPEC S5 declares each row's kind.
      items: [
        hookStatusItem,
        copyInstallItem,
        copyUninstallItem,
        statusLineItem,
        transcriptItem,
        deleteUsageItem,
      ] as [
        typeof hookStatusItem,
        typeof copyInstallItem,
        typeof copyUninstallItem,
        typeof statusLineItem,
        typeof transcriptItem,
        typeof deleteUsageItem,
      ],
    };
    const serviceUp = (): boolean => this.host.approvals?.serviceAvailable() === true;
    const notifyItem = {
      name: NOTIFY_APPROVALS_NAME,
      desc: NOTIFY_APPROVALS_DESC,
      control: {
        type: "toggle" as const,
        key: NOTIFY_APPROVALS_KEY,
        defaultValue: true,
      },
    };
    const testApprovalItem = {
      name: SEND_TEST_APPROVAL_NAME,
      desc: serviceUp()
        ? SEND_TEST_APPROVAL_DESC
        : `${SEND_TEST_APPROVAL_DESC}${SEND_TEST_APPROVAL_NEEDS_SERVICE}`,
      disabled: () => !serviceUp(),
      action: (_el: HTMLElement, _index: number) => {
        if (serviceUp()) this.host.approvals?.sendTestApproval();
      },
    };
    const approvalsGroup = {
      type: "group" as const,
      heading: APPROVALS_GROUP_HEADING,
      items: [notifyItem, testApprovalItem] as [typeof notifyItem, typeof testApprovalItem],
    };
    // A tuple cast (not `as const`, which would widen the array to
    // `readonly` and break assignability against the base class's mutable
    // `SettingDefinitionItem[]`) keeps each element's own literal shape
    // distinct -- callers can index a specific position
    // (`definitions[0].control`, `definitions[1].items`) without a type
    // guard, exactly like the pre-existing reduced-motion test does.
    const tasksUp = (): boolean => this.host.tasks?.serviceAvailable() === true;
    const rebuildItem = {
      name: REBUILD_NAME,
      desc: tasksUp() ? REBUILD_DESC : `${REBUILD_DESC}${REBUILD_NEEDS_SERVICE}`,
      disabled: () => !tasksUp(),
      action: (_el: HTMLElement, _index: number) => {
        void this.handleRebuild();
      },
    };
    const tasksGroup = {
      type: "group" as const,
      heading: TASKS_GROUP_HEADING,
      items: [rebuildItem] as [typeof rebuildItem],
    };
    // The Codex group (plan 05.1-19) is appended after every existing group, in
    // its own section: never inserted by index, never reordering another group.
    const codexGroup = buildCodexGroup({
      status: this.codexState.status,
      nowMs: Date.now(),
      copy: (text, notice) => {
        void this.copyCodexStep(text, notice);
      },
      openLauncherSettings: () => {
        this.host.codex?.openLauncherSettings();
      },
    });
    return [reducedMotionItem, claudeGroup, approvalsGroup, tasksGroup, codexGroup] as [
      typeof reducedMotionItem,
      typeof claudeGroup,
      typeof approvalsGroup,
      typeof tasksGroup,
      typeof codexGroup,
    ];
  }

  getControlValue(key: string): unknown {
    if (key === REDUCED_MOTION_KEY) return this.host.settings.reducedMotion;
    if (key === NOTIFY_APPROVALS_KEY) return this.host.settings.notifyApprovals ?? true;
    if (key === TRANSCRIPT_ANALYSIS_KEY) {
      return typeof this.claudeStatus === "object"
        ? this.claudeStatus.transcriptAnalysis.enabled
        : false;
    }
    return super.getControlValue(key);
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === TRANSCRIPT_ANALYSIS_KEY) {
      const enabled = value === true;
      const wasEnabled =
        typeof this.claudeStatus === "object" && this.claudeStatus.transcriptAnalysis.enabled;
      const outcome = await applyTranscriptAnalysisChange(this.host, enabled);
      // On success, reflect the confirmed value immediately rather than
      // waiting on a fresh fetch; on revert, leave `claudeStatus` untouched
      // so `getControlValue` reports the value still actually in effect.
      if (outcome === "saved" && typeof this.claudeStatus === "object") {
        this.claudeStatus = { ...this.claudeStatus, transcriptAnalysis: { enabled } };
        // R-15: deletion is offered in the SAME flow as turning analysis
        // off, with no extra modal -- row 6 picks this up on its next
        // render via `deleteUsageDescription()`.
        if (wasEnabled && !enabled) this.transcriptJustDisabled = true;
      }
      this.rerender();
      return;
    }
    if (key === NOTIFY_APPROVALS_KEY) {
      const outcome = await applyNotifyApprovalsChange(this.host, value === true);
      if (outcome === "reverted") this.rerender();
      return;
    }
    if (key !== REDUCED_MOTION_KEY) {
      await super.setControlValue(key, value);
      return;
    }
    const outcome = await applyReducedMotionChange(this.host, asMotionPreference(value));
    // `update()` re-reads every control through `getControlValue`, so a
    // reverted save puts the dropdown back on the persisted value without the
    // tab tracking a second copy of it. `display()` would not refresh a
    // declarative setting on 1.13+.
    if (outcome === "reverted") this.rerender();
  }

  /**
   * Re-fetches the integration status each time the tab is displayed
   * (wave 2 review): Obsidian calls `getSettingDefinitions()` on every
   * display, so that is the hook. The last known status stays on screen
   * while the new one loads (only the very first load reads "Checking…"),
   * a display during an in-flight fetch starts no second one, and the
   * tab's own {@link rerender} never triggers a fetch -- Obsidian's
   * `update()` re-reads the definitions, which would otherwise loop. A
   * missing seam or a rejected fetch settles on a definite state --
   * `"unavailable"` on failure -- never "checking" forever.
   */
  private ensureClaudeStatusLoaded(): void {
    if (this.selfUpdating || this.claudeStatusInFlight || !this.host.claude) return;
    this.claudeStatusInFlight = true;
    this.host.claude.getIntegration().then(
      (status) => {
        this.claudeStatusInFlight = false;
        this.claudeStatus = status;
        this.rerender();
      },
      () => {
        this.claudeStatusInFlight = false;
        this.claudeStatus = "unavailable";
        this.rerender();
      },
    );
  }

  /** `update()` without the refetch its `getSettingDefinitions()` call would otherwise start. */
  private rerender(): void {
    this.selfUpdating = true;
    try {
      this.update();
    } finally {
      this.selfUpdating = false;
    }
  }

  /** Row 6's description: the base copy, plus the R-15 note once analysis has just been turned off. */
  private deleteUsageDescription(): string {
    return this.transcriptJustDisabled
      ? `${CLAUDE_DELETE_USAGE_DESC} ${CLAUDE_DELETE_USAGE_RETAINED_NOTE}`
      : CLAUDE_DELETE_USAGE_DESC;
  }

  /** The Rebuild task index row: start Notice at once, then the counts or the fixed failure. */
  private async handleRebuild(): Promise<void> {
    const seam = this.host.tasks;
    if (!seam?.serviceAvailable() || this.rebuilding) return;
    this.rebuilding = true;
    this.notify(REBUILD_STARTED_NOTICE);
    try {
      const result = await seam.rebuildTaskIndex();
      this.notify(rebuildSuccessNotice(result.tasks, result.attention));
    } catch {
      this.notify(REBUILD_FAILED_NOTICE);
    } finally {
      this.rebuilding = false;
    }
  }

  /** Shows a transient message through the host's notifier, or Obsidian's own `Notice`. */
  private notify(message: string): void {
    if (this.host.notify) this.host.notify(message);
    else new Notice(message);
  }

  /**
   * Rows 2 and 3: copies a fixed, repository-relative command (D-13, R-24 --
   * the dashboard never installs anything itself) and notifies. A missing
   * seam is a no-op rather than a throw, matching every other row here; a
   * refused clipboard write says so instead of claiming a copy.
   */
  private async copyCommand(command: string, copiedNotice: string): Promise<void> {
    if (!this.host.claude) return;
    try {
      await this.host.claude.copyText(command);
    } catch {
      this.notify(CLAUDE_COPY_FAILED_NOTICE);
      return;
    }
    this.notify(copiedNotice);
  }

  /**
   * The Codex copy rows: writes a fixed, repository-relative step (D-12 -- the
   * dashboard never installs anything itself) and notifies. A missing seam is a
   * no-op; a refused clipboard write says so instead of claiming a copy.
   */
  private async copyCodexStep(text: string, copiedNotice: string): Promise<void> {
    if (!this.host.codex) return;
    try {
      await this.host.codex.copyText(text);
    } catch {
      this.notify(CLAUDE_COPY_FAILED_NOTICE);
      return;
    }
    this.notify(copiedNotice);
  }

  /**
   * The oldest calendar date a surviving transcript could still name, from
   * the already-fetched `cleanupPeriodDays` -- never a separate fetch, and
   * never guessed when the status itself is unknown (see the `null` branch
   * at the call site).
   */
  private computeHorizonDate(cleanupPeriodDays: number): string {
    return new Date(Date.now() - cleanupPeriodDays * 24 * 60 * 60 * 1000).toISOString();
  }

  /**
   * Row 6: opens the confirmation modal (UI-SPEC S4-d) through the injected
   * `host.openDeleteUsageModal` seam -- never a widget body, per the single
   * choke-point rule -- and only reaches the service on an explicit
   * confirm. A cancelled modal calls nothing at all.
   */
  private async handleDeleteUsage(): Promise<void> {
    if (!this.host.openDeleteUsageModal || !this.host.claude) return;
    const horizon =
      typeof this.claudeStatus === "object"
        ? this.computeHorizonDate(this.claudeStatus.cleanupPeriodDays)
        : null;
    // While analysis is on the service recounts from the retained
    // transcripts right away (f44c3ae); the modal says so. An unknown status
    // keeps the plain copy rather than guessing.
    const analysisOn =
      typeof this.claudeStatus === "object" && this.claudeStatus.transcriptAnalysis.enabled;
    const confirmed = await this.host.openDeleteUsageModal(horizon, analysisOn);
    if (!confirmed) return;
    try {
      await this.host.claude.deleteUsageAnalytics();
      this.transcriptJustDisabled = false;
      this.notify(CLAUDE_USAGE_DELETED_NOTICE);
    } catch {
      this.notify(CLAUDE_USAGE_DELETE_FAILED_NOTICE);
    }
    this.rerender();
  }
}
