import type { ClaudeIntegrationStatus } from "@ccc/domain";
import {
  applyMotionPreference,
  type MediaQueryListLike,
  type MotionPreference,
} from "../motion.js";
import { formatAbsoluteTime, formatRelativeTime } from "../widgets/relative-time.js";

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
  "are stored — never prompts, replies or file contents. Hook telemetry keeps working when this is off. " +
  "This also covers Codex session titles, previews and token activity.";
export const CLAUDE_TRANSCRIPT_ANALYSIS_FAILED_NOTICE =
  "Couldn't change transcript analysis. The companion service didn't respond.";

// Row 6 -- delete cached usage analytics (destructive action, Task 3 wires the click).
export const CLAUDE_DELETE_USAGE_NAME = "Delete cached usage analytics";
export const CLAUDE_DELETE_USAGE_DESC =
  "Removes stored token counts, cost estimates, plan usage history and coverage records for Claude Code and Codex. Session history stays.";
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
 * with a fixed notification and never reaches `host.settings` at all, so the
 * plugin's own settings object gains no transcript key (USAGE-07: it must
 * never be persisted in `data.json`).
 */
export async function applyTranscriptAnalysisChange(
  host: SettingsModelHost,
  value: boolean,
  notify: Notify,
): Promise<ClaudeSettingOutcome> {
  try {
    if (!host.claude) throw new Error("no Claude service seam configured");
    await host.claude.setTranscriptAnalysis(value);
    return "saved";
  } catch {
    notify(CLAUDE_TRANSCRIPT_ANALYSIS_FAILED_NOTICE);
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

// --- Tasks group (UI-SPEC S5, plan 06-23) ----------------------------------
export const TASKS_GROUP_HEADING = "Tasks";
export const REBUILD_NAME = "Rebuild task index";
export const REBUILD_DESC =
  "Re-reads every task note in the vault and rebuilds the task lists. Your notes aren't changed.";
export const REBUILD_NEEDS_SERVICE = " Needs the companion service, which isn't running.";
export const REBUILD_STARTED_NOTICE = "Rebuilding the task index…";
export const REBUILD_FAILED_NOTICE =
  "Couldn't rebuild the task index. Check the service in Settings → Diagnostics, then try again.";

const REBUILD_PLURAL = new Intl.PluralRules("en");

/** `Task index rebuilt. 212 tasks found.`, with ` {m} note(s) need attention.` only when any. */
export function rebuildSuccessNotice(tasks: number, attention: number): string {
  const found = `${tasks} ${REBUILD_PLURAL.select(tasks) === "one" ? "task" : "tasks"} found.`;
  const base = `Task index rebuilt. ${found}`;
  if (attention <= 0) return base;
  const note = REBUILD_PLURAL.select(attention) === "one" ? "note needs" : "notes need";
  return `${base} ${attention} ${note} attention.`;
}

/** What the Tasks row needs from the wiring: the rebuild, and whether the service is reachable. */
export interface SettingsTasksSeam {
  readonly rebuildTaskIndex: () => Promise<{ readonly tasks: number; readonly attention: number }>;
  readonly serviceAvailable: () => boolean;
}

/** What the Approvals rows need from the wiring: start a test request, and whether the service is reachable. */
export interface SettingsApprovalsSeam {
  readonly sendTestApproval: () => void;
  readonly serviceAvailable: () => boolean;
}

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
  /** The Claude settings seam (UI-SPEC S5). Absent means not wired yet. */
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

/**
 * The approval notifications toggle's whole decision (persist first, apply
 * second, revert on failure; the E8 precedent). The notifier reads the setting
 * live, so "apply" is the in-memory value once the save has resolved; on
 * failure the previous value is restored and `notify` says so.
 */
export async function applyNotifyApprovalsChange(
  host: SettingsModelHost,
  value: boolean,
  notify: Notify,
): Promise<"saved" | "reverted"> {
  const previous = host.settings.notifyApprovals ?? true;
  host.settings.notifyApprovals = value;
  try {
    await host.saveSettings();
  } catch {
    host.settings.notifyApprovals = previous;
    notify(NOTIFY_APPROVALS_SAVE_FAILED);
    return "reverted";
  }
  return "saved";
}
