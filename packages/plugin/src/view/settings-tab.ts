import type { ClaudeIntegrationStatus } from "@ccc/domain";
import { type App, Notice, type Plugin, PluginSettingTab } from "obsidian";
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

// --- Claude section (UI-SPEC S5, D-48) ------------------------------------
// A "Claude" group appended to the settings tab: hook status, the owner-run
// install/uninstall commands, the status-line wrapper status, the
// transcript-analysis toggle (service-owned, never persisted here) and
// "Delete cached usage analytics". The service is the source of truth for
// every status row and for the toggle -- this file never writes any of it
// to `CommandCenterSettings` (PLUG-07's `assertNoCredentialFields` stays the
// only write guard on that shape).

export const CLAUDE_GROUP_HEADING = "Claude";

// Row 1 -- hook status (SettingDefinitionEmpty).
export const CLAUDE_HOOKS_NAME = "Claude Code hooks";
export const CLAUDE_HOOKS_CHECKING_TEXT = "Checking…";
export const CLAUDE_STATUS_UNAVAILABLE_TEXT =
  "Status unavailable — the companion service isn't running.";
export const CLAUDE_HOOKS_NOT_INSTALLED_TEXT =
  "Not installed. Session tracking and waiting-for-approval states need them.";
const CLAUDE_HOOKS_SILENT_SUFFIX =
  " Claude Code skips hooks in folders you haven't trusted and when hooks are turned off in its settings.";
/** The silence threshold before "Last event …" gives way to "no events have arrived since …". */
const HOOK_SILENT_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * A Claude Code version shape safe to render: dotted digits only (mirrors
 * `widgets/frame.tsx`'s `claudeCodeVersion` -- kept local rather than
 * imported because that module is plugin-harness-reachable and this one is
 * not; duplicating four lines is cheaper than coupling their bundling
 * constraints together).
 */
const VERSION_SHAPE = /^\d{1,6}(?:\.\d{1,6}){0,3}$/;
function claudeCodeVersionLabel(version: string | null): string {
  return version !== null && VERSION_SHAPE.test(version)
    ? `Claude Code ${version}`
    : "Your Claude Code version";
}

// Row 2 -- copy install command (action).
export const CLAUDE_COPY_INSTALL_NAME = "Copy install command";
export const CLAUDE_INSTALL_COMMAND = "./scripts/claude-hooks/install.sh";
export const CLAUDE_COPY_INSTALL_DESC =
  `From the Claude command center repository folder, run: ${CLAUDE_INSTALL_COMMAND} — add ` +
  "--dry-run to preview the change first, or --with-statusline to also install the status-line wrapper.";
export const CLAUDE_INSTALL_COPIED_NOTICE = "Install command copied. Run it in Terminal.";

// Row 3 -- copy uninstall command (action).
export const CLAUDE_COPY_UNINSTALL_NAME = "Copy uninstall command";
export const CLAUDE_UNINSTALL_COMMAND = "./scripts/claude-hooks/uninstall.sh";
export const CLAUDE_COPY_UNINSTALL_DESC =
  "Removes the hooks and the status-line wrapper and restores your previous settings: " +
  CLAUDE_UNINSTALL_COMMAND;
export const CLAUDE_UNINSTALL_COPIED_NOTICE = "Uninstall command copied. Run it in Terminal.";
/** Rows 2 and 3 when the clipboard write is refused; the command is still in the row's description. */
export const CLAUDE_COPY_FAILED_NOTICE =
  "Couldn't copy the command. It's shown in the setting's description; copy it from there.";

// Row 4 -- status-line wrapper status (SettingDefinitionEmpty).
export const CLAUDE_STATUSLINE_NAME = "Status-line wrapper";
export const CLAUDE_STATUSLINE_INSTALLED_AVAILABLE_TEXT = "Installed. Plan usage is available.";
export const CLAUDE_STATUSLINE_INSTALLED_WAITING_TEXT =
  "Installed. Waiting for the first response in a Claude Code session.";
export const CLAUDE_STATUSLINE_NOT_INSTALLED_TEXT =
  'Not installed. Plan usage reads "Account capacity unavailable". The wrapper keeps your current status line exactly as it is.';

// Row 5 -- transcript analysis (toggle, default off, service-owned).
export const TRANSCRIPT_ANALYSIS_KEY = "claude.transcriptAnalysis";
export const CLAUDE_TRANSCRIPT_ANALYSIS_NAME = "Transcript analysis";
export const CLAUDE_TRANSCRIPT_ANALYSIS_DESC =
  "Count tokens from Claude Code's local transcripts. Only counts, model names and timestamps " +
  "are stored — never prompts, replies or file contents. Hook telemetry keeps working when this is off.";
export const CLAUDE_TRANSCRIPT_ANALYSIS_FAILED_NOTICE =
  "Couldn't change transcript analysis. The companion service didn't respond.";

// Row 6 -- delete cached usage analytics (destructive action, Task 3 wires the click).
export const CLAUDE_DELETE_USAGE_NAME = "Delete cached usage analytics";
export const CLAUDE_DELETE_USAGE_DESC =
  "Removes stored token counts, cost estimates, plan usage history and coverage records. Session history stays.";
export const CLAUDE_DELETE_USAGE_RETAINED_NOTE = "Existing totals are kept until you delete them.";
export const CLAUDE_USAGE_DELETED_NOTICE = "Cached usage analytics deleted.";
export const CLAUDE_USAGE_DELETE_FAILED_NOTICE =
  "Couldn't delete cached usage analytics. Check the service in Settings → Diagnostics, then try again.";

/**
 * Everything the settings tab needs from `@ccc/service-api-client`'s Claude
 * routes, behind one typed seam -- the same shape as {@link SettingsTabHost}
 * itself. Production builds it in `main.ts` from the authenticated client;
 * tests pass plain functions.
 */
export interface SettingsClaudeSeam {
  readonly getIntegration: () => Promise<ClaudeIntegrationStatus>;
  readonly setTranscriptAnalysis: (enabled: boolean) => Promise<{ enabled: boolean }>;
  readonly deleteUsageAnalytics: () => Promise<void>;
  readonly copyText: (text: string) => Promise<void>;
}

/** What a Claude-service-backed setting change did (mirrors {@link ReducedMotionOutcome}). */
export type ClaudeSettingOutcome = "saved" | "reverted";

type HookStatusInput =
  | "checking"
  | "unavailable"
  | Pick<ClaudeIntegrationStatus, "hooks" | "lastEventAt" | "telemetry">;

type StatusLineStatusInput =
  | "checking"
  | "unavailable"
  | Pick<ClaudeIntegrationStatus, "statusLine" | "statusLineReported">;

/**
 * UI-SPEC S5 row 1: the ONE fixed string every state resolves to (E10
 * empty). Telemetry problems (an unsupported Claude Code version, or a
 * hook-event shape change) take priority over the plain install state,
 * because they mean session tracking is paused even when hooks ARE
 * installed. A `lastEventAt` of `null` (installed, but never once heard
 * from) falls into the same silent-since bucket as a stale one, worded
 * without a timestamp there is none to give -- never a blank row.
 */
export function hookStatusText(status: HookStatusInput, now: number): string {
  if (status === "checking") return CLAUDE_HOOKS_CHECKING_TEXT;
  if (status === "unavailable") return CLAUDE_STATUS_UNAVAILABLE_TEXT;
  if (status.telemetry.kind === "unsupported-version") {
    return `${claudeCodeVersionLabel(status.telemetry.version)} is older than the minimum supported 2.1.214.`;
  }
  if (status.telemetry.kind === "shape-changed") {
    return `${claudeCodeVersionLabel(status.telemetry.version)} changed its hook event format. Session tracking is paused rather than guessed.`;
  }
  if (status.hooks !== "installed") return CLAUDE_HOOKS_NOT_INSTALLED_TEXT;
  if (status.lastEventAt === null) {
    return `Installed, but no events have arrived yet.${CLAUDE_HOOKS_SILENT_SUFFIX}`;
  }
  const elapsedMs = now - Date.parse(status.lastEventAt);
  if (elapsedMs <= HOOK_SILENT_THRESHOLD_MS) {
    return `Installed. Last event ${formatRelativeTime(status.lastEventAt, now)}.`;
  }
  return `Installed, but no events have arrived since ${formatAbsoluteTime(status.lastEventAt)}.${CLAUDE_HOOKS_SILENT_SUFFIX}`;
}

/** UI-SPEC S5 row 4: the ONE fixed string every state resolves to (E10 empty). */
export function statusLineStatusText(status: StatusLineStatusInput, _now: number): string {
  if (status === "checking") return CLAUDE_HOOKS_CHECKING_TEXT;
  if (status === "unavailable") return CLAUDE_STATUS_UNAVAILABLE_TEXT;
  if (status.statusLine !== "installed") return CLAUDE_STATUSLINE_NOT_INSTALLED_TEXT;
  return status.statusLineReported
    ? CLAUDE_STATUSLINE_INSTALLED_AVAILABLE_TEXT
    : CLAUDE_STATUSLINE_INSTALLED_WAITING_TEXT;
}

/**
 * The transcript-analysis toggle's whole decision (mirrors
 * `applyReducedMotionChange`'s shape, UI-SPEC S5 row 5). The SERVICE is the
 * source of truth here, not `host.saveSettings` -- a failed write reverts
 * with a fixed Notice and never reaches `host.settings` at all, so the
 * plugin's own settings object gains no transcript key (USAGE-07: it must
 * never be persisted in `data.json`).
 */
export async function applyTranscriptAnalysisChange(
  host: SettingsTabHost,
  value: boolean,
): Promise<ClaudeSettingOutcome> {
  try {
    if (!host.claude) throw new Error("no Claude service seam configured");
    await host.claude.setTranscriptAnalysis(value);
    return "saved";
  } catch {
    if (host.notify) host.notify(CLAUDE_TRANSCRIPT_ANALYSIS_FAILED_NOTICE);
    else new Notice(CLAUDE_TRANSCRIPT_ANALYSIS_FAILED_NOTICE);
    return "reverted";
  }
}

// --- end Claude section ----------------------------------------------------

// --- Approvals group (UI-SPEC S5, plan 06-23) -------------------------------
// Native settings rows, no custom styling. `notifyApprovals` is the only
// approval value persisted in plugin settings (D-21, D-26); the test action's
// timer and call live in `approvals/wiring.ts` behind {@link SettingsApprovalsSeam}.

export const APPROVALS_GROUP_HEADING = "Approvals";
export const NOTIFY_APPROVALS_KEY = "notifyApprovals";
export const NOTIFY_APPROVALS_NAME = "Approval notifications";
export const NOTIFY_APPROVALS_DESC =
  "Show a macOS notification when a new approval request arrives while Obsidian isn't focused. " +
  "It shows a generic message and can't approve anything.";
export const NOTIFY_APPROVALS_SAVE_FAILED = "Couldn't save the approval notifications setting.";
export const SEND_TEST_APPROVAL_NAME = "Send a test approval";
export const SEND_TEST_APPROVAL_DESC =
  "Creates a request that does nothing when approved. It arrives after 5 seconds, " +
  "so you can switch to another app and see the notification.";
export const SEND_TEST_APPROVAL_NEEDS_SERVICE =
  " Needs the companion service, which isn't running.";

/** What the Approvals rows need from the wiring: start a test request, and whether the service is reachable. */
export interface SettingsApprovalsSeam {
  readonly sendTestApproval: () => void;
  readonly serviceAvailable: () => boolean;
}

/**
 * Everything the tab needs from the plugin, behind one typed seam — the same
 * shape `setup-command.ts` uses. Production passes the plugin; tests pass a
 * plain object, and neither needs a cast.
 */
export interface SettingsTabHost {
  readonly settings: { reducedMotion: MotionPreference; notifyApprovals?: boolean };
  // Property-style (not method-shorthand) signatures: these are handed
  // around as standalone values, so `this` must never be implied by the
  // call site (`@typescript-eslint/unbound-method` at error).
  readonly saveSettings: () => Promise<void>;
  readonly mql: Pick<MediaQueryListLike, "matches">;
  /** Shows a transient message. Defaults to Obsidian's `Notice` in production. */
  readonly notify?: (message: string) => void;
  /** The Claude settings section's service seam (UI-SPEC S5). Absent means not wired yet. */
  readonly claude?: SettingsClaudeSeam | undefined;
  /** The Approvals group's seam (plan 06-23). Absent means the test action is unavailable. */
  readonly approvals?: SettingsApprovalsSeam | undefined;
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

/**
 * The approval notifications toggle's whole decision (persist first, apply
 * second, revert on failure; the E8 precedent). The notifier reads the setting
 * live, so "apply" is the in-memory value once the save has resolved; on
 * failure the previous value is restored and a fixed Notice says so.
 */
export async function applyNotifyApprovalsChange(
  host: SettingsTabHost,
  value: boolean,
): Promise<"saved" | "reverted"> {
  const previous = host.settings.notifyApprovals ?? true;
  host.settings.notifyApprovals = value;
  try {
    await host.saveSettings();
  } catch {
    host.settings.notifyApprovals = previous;
    if (host.notify) host.notify(NOTIFY_APPROVALS_SAVE_FAILED);
    else new Notice(NOTIFY_APPROVALS_SAVE_FAILED);
    return "reverted";
  }
  return "saved";
}

/** Narrows an arbitrary persisted value; anything unrecognised is `auto` (T-03-12). */
export function asMotionPreference(value: unknown): MotionPreference {
  return value === "reduced" ? "reduced" : "auto";
}

export class CommandCenterSettingTab extends PluginSettingTab {
  private readonly host: SettingsTabHost;
  /** `"checking"` until the service answers; `"unavailable"` after a failed fetch (UI-SPEC S5). */
  private claudeStatus: ClaudeIntegrationStatus | "checking" | "unavailable" = "checking";
  /** True while a `getIntegration()` call is in flight; a display during it starts no second one. */
  private claudeStatusInFlight = false;
  /** True while this tab's OWN `update()` runs, whose `getSettingDefinitions()` must not refetch. */
  private selfUpdating = false;
  /** R-15: set once a successful write turns transcript analysis off; row 6 reflects it. */
  private transcriptJustDisabled = false;

  constructor(app: App, plugin: Plugin, host: SettingsTabHost) {
    super(app, plugin);
    this.host = host;
  }

  getSettingDefinitions() {
    this.ensureClaudeStatusLoaded();
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
    return [reducedMotionItem, claudeGroup, approvalsGroup] as [
      typeof reducedMotionItem,
      typeof claudeGroup,
      typeof approvalsGroup,
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
