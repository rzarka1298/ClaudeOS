import type { CodexIntegrationStatus } from "@ccc/domain/codex-integration.js";
import { formatAbsoluteTime, formatRelativeTime } from "../widgets/relative-time.js";

/**
 * The locked Codex copy and status texts (05.1 UI-SPEC S4-a, plan 05.1-19; D-12, D-19, D-30;
 * CODEX-06), read by the Integrations section of the Settings destination.
 *
 * The native Obsidian settings tab used to build a seven-row "Codex" group from these; plan 08-18
 * moved every row into the destination and deleted the group builder and its state class, so what
 * remains is the text itself: names, descriptions, the three fixed repository-relative steps, the
 * copy notices and the two status sentences. Nothing here is Obsidian chrome or a design token.
 * The dashboard INSTALLS NOTHING (D-12): a copy row only writes one of the fixed strings below to
 * the clipboard, and the notify row says plainly that Codex's notify slot is never touched (D-19).
 * No text renders an absolute or home path; the one permitted slash in a status text is `/hooks`,
 * Codex's own screen name.
 */

export const CODEX_GROUP_HEADING = "Codex";

// Row 1 -- hook status.
export const CODEX_HOOKS_NAME = "Codex hooks";
export const CODEX_CHECKING_TEXT = "Checking…";
export const CODEX_STATUS_UNAVAILABLE_TEXT =
  "Status unavailable — the companion service didn't respond.";
export const CODEX_HOOKS_NOT_INSTALLED_TEXT =
  "Not installed. Live status for interactive Codex sessions needs the optional hook package. Sessions and usage still appear from Codex's own records.";
export const CODEX_HOOKS_UNKNOWN_TEXT =
  "Status unknown. This app couldn't tell whether the hook package is installed.";
const CODEX_HOOKS_TRUST_SUFFIX =
  "Codex asks you to trust a new hook on its hooks screen (type /hooks in Codex), and skips hooks in folders it hasn't trusted.";

// Row 2 -- copy the hook install step.
export const CODEX_COPY_INSTALL_NAME = "Copy install step";
export const CODEX_HOOKS_INSTALL_STEP = "./scripts/codex-hooks/install.sh";
export const CODEX_COPY_INSTALL_DESC =
  `From the Claude command center repository folder, run: ${CODEX_HOOKS_INSTALL_STEP} — add --dry-run to preview the change first. ` +
  "It adds to Codex's hooks file only and never touches its config file or notify setting. " +
  "Then type /hooks in Codex and trust the new hook.";
export const CODEX_INSTALL_COPIED_NOTICE = "Install step copied. Run it in Terminal.";

// Row 3 -- copy the hook uninstall step.
export const CODEX_COPY_UNINSTALL_NAME = "Copy uninstall step";
export const CODEX_HOOKS_UNINSTALL_STEP = "./scripts/codex-hooks/uninstall.sh";
export const CODEX_COPY_UNINSTALL_DESC =
  "Removes the Codex hooks this app added and leaves everything else as it was: " +
  CODEX_HOOKS_UNINSTALL_STEP;
export const CODEX_UNINSTALL_COPIED_NOTICE = "Uninstall step copied. Run it in Terminal.";

// Row 4 -- Antigravity terminal bridge status.
export const CODEX_BRIDGE_NAME = "Antigravity terminal bridge";
export const CODEX_BRIDGE_IDLE_TEXT =
  "Installed, but Antigravity hasn't reported a window recently. It opens when you launch.";
export const CODEX_BRIDGE_NOT_INSTALLED_TEXT = "Not installed. Launches fall back to Terminal.";
export const CODEX_BRIDGE_OUTDATED_TEXT = "Out of date. Run its install step again.";
export const CODEX_BRIDGE_DIFFERENT_FOLDER_TEXT =
  "Installed, but it writes to a different state folder than this app reads. Run its install step again.";

// Row 5 -- copy the bridge install step.
export const CODEX_COPY_BRIDGE_NAME = "Copy bridge install step";
export const CODEX_BRIDGE_INSTALL_STEP = "node scripts/codex/install-user-kit.mjs";
export const CODEX_COPY_BRIDGE_DESC =
  `From the Claude command center repository folder, run: ${CODEX_BRIDGE_INSTALL_STEP} — ` +
  "it installs the Antigravity terminal bridge for your user account only. Restart Antigravity afterwards.";

// Row 6 -- the launcher.
export const CODEX_LAUNCHER_NAME = "Launcher";
export const CODEX_LAUNCHER_DESC =
  "Antigravity terminal is the default. It falls back to Terminal when the bridge isn't installed. " +
  "A Terminal setup you already saved stays as it is until you save a new one.";

// Row 7 -- the notify note.
export const CODEX_NOTIFY_NAME = "Codex notify setting";
export const CODEX_NOTIFY_DESC =
  "Left untouched. This app never takes over Codex's notify setting.";

/**
 * Everything the Codex rows need from the wiring (D-30), behind one typed seam like the Claude
 * one: production builds it in `main.ts`, tests pass plain functions. The Launchers hand-off is a
 * deep link (`requestSettingsSection("launchers")`), not a host member.
 */
export interface SettingsCodexSeam {
  readonly getIntegration: () => Promise<CodexIntegrationStatus>;
  readonly copyText: (text: string) => Promise<void>;
}

/** The status the rows render: the service's answer, or one of the two states before one exists. */
export type CodexStatusInput = CodexIntegrationStatus | "checking" | "unavailable";

/** Row 1: the ONE fixed sentence every hook state resolves to (UI-SPEC S4-a). */
export function codexHookStatusText(status: CodexStatusInput, nowMs: number): string {
  if (status === "checking") return CODEX_CHECKING_TEXT;
  if (status === "unavailable") return CODEX_STATUS_UNAVAILABLE_TEXT;
  const { state, lastEventAt, installedSince } = status.hooks;
  if (state === "not-installed") return CODEX_HOOKS_NOT_INSTALLED_TEXT;
  if (state === "unknown") return CODEX_HOOKS_UNKNOWN_TEXT;
  if (state === "installed" && lastEventAt !== null) {
    return `Installed. Last event ${formatRelativeTime(lastEventAt, nowMs)}.`;
  }
  const since = installedSince === null ? "yet" : `since ${formatAbsoluteTime(installedSince)}`;
  return `Installed, but no events have arrived ${since}. ${CODEX_HOOKS_TRUST_SUFFIX}`;
}

/** Row 4: the ONE fixed sentence every bridge state resolves to (UI-SPEC S4-a). */
export function codexBridgeStatusText(status: CodexStatusInput, nowMs: number): string {
  if (status === "checking") return CODEX_CHECKING_TEXT;
  if (status === "unavailable") return CODEX_STATUS_UNAVAILABLE_TEXT;
  const { state, lastWindowAt } = status.bridge;
  switch (state) {
    case "installed":
      return lastWindowAt === null
        ? CODEX_BRIDGE_IDLE_TEXT
        : `Installed. Antigravity reported a window ${formatRelativeTime(lastWindowAt, nowMs)}.`;
    case "installed-idle":
      return CODEX_BRIDGE_IDLE_TEXT;
    case "not-installed":
      return CODEX_BRIDGE_NOT_INSTALLED_TEXT;
    case "outdated":
      return CODEX_BRIDGE_OUTDATED_TEXT;
    case "different-folder":
      return CODEX_BRIDGE_DIFFERENT_FOLDER_TEXT;
  }
}
