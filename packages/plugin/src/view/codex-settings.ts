import type { CodexIntegrationStatus } from "@ccc/domain/codex-integration.js";
import { formatAbsoluteTime, formatRelativeTime } from "../widgets/relative-time.js";

/**
 * The "Codex" group of the Obsidian settings tab (05.1 UI-SPEC S4-a, plan
 * 05.1-19; D-12, D-19, D-30; CODEX-06). Seven rows in a locked order: hook
 * status, copy install step, copy uninstall step, Antigravity terminal bridge
 * status, copy bridge install step, Launcher, and the Codex notify note.
 *
 * Like the Claude group, this is Obsidian chrome: native rows, no design token,
 * sentence case. The dashboard INSTALLS NOTHING (D-12): the three action rows
 * only write a fixed repository-relative string to the clipboard, and the
 * notify row says plainly that Codex's notify slot is never touched (D-19).
 * No row renders an absolute or home path; the one permitted slash in a status
 * row is `/hooks`, Codex's own screen name.
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
export const CODEX_OPEN_LAUNCHER_LABEL = "Open launcher settings";

// Row 7 -- the notify note.
export const CODEX_NOTIFY_NAME = "Codex notify setting";
export const CODEX_NOTIFY_DESC =
  "Left untouched. This app never takes over Codex's notify setting.";

/**
 * Everything the Codex group needs from the wiring (D-30), behind one typed
 * seam like the Claude one: production builds it in `main.ts`, tests pass plain
 * functions.
 */
export interface SettingsCodexSeam {
  readonly getIntegration: () => Promise<CodexIntegrationStatus>;
  readonly copyText: (text: string) => Promise<void>;
  /** Focuses Settings → Launchers in the command center view (the existing launchers hand-off). */
  readonly openLauncherSettings: () => void;
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

export interface CodexGroupInput {
  readonly status: CodexStatusInput;
  readonly nowMs: number;
  /** Copies `text` to the clipboard and posts `notice` (or the copy-failed Notice). The group never installs anything. */
  readonly copy: (text: string, notice: string) => void;
  readonly openLauncherSettings: () => void;
}

/**
 * The seven-row group definition. A tuple cast (not an array literal) keeps each
 * row's own literal shape distinct, exactly like the Claude group: rows 1, 4 and
 * 7 have no `action` or `control` (Obsidian's `SettingDefinitionEmpty`), rows 2,
 * 3, 5 and 6 have an `action` only.
 */
export function buildCodexGroup(input: CodexGroupInput) {
  const { status, nowMs, copy, openLauncherSettings } = input;
  const hooksItem = { name: CODEX_HOOKS_NAME, desc: codexHookStatusText(status, nowMs) };
  const copyInstallItem = {
    name: CODEX_COPY_INSTALL_NAME,
    desc: CODEX_COPY_INSTALL_DESC,
    action: (_el: HTMLElement, _index: number) => {
      copy(CODEX_HOOKS_INSTALL_STEP, CODEX_INSTALL_COPIED_NOTICE);
    },
  };
  const copyUninstallItem = {
    name: CODEX_COPY_UNINSTALL_NAME,
    desc: CODEX_COPY_UNINSTALL_DESC,
    action: (_el: HTMLElement, _index: number) => {
      copy(CODEX_HOOKS_UNINSTALL_STEP, CODEX_UNINSTALL_COPIED_NOTICE);
    },
  };
  const bridgeItem = { name: CODEX_BRIDGE_NAME, desc: codexBridgeStatusText(status, nowMs) };
  const copyBridgeItem = {
    name: CODEX_COPY_BRIDGE_NAME,
    desc: CODEX_COPY_BRIDGE_DESC,
    action: (_el: HTMLElement, _index: number) => {
      copy(CODEX_BRIDGE_INSTALL_STEP, CODEX_INSTALL_COPIED_NOTICE);
    },
  };
  const launcherItem = {
    name: CODEX_LAUNCHER_NAME,
    desc: CODEX_LAUNCHER_DESC,
    // The declarative action row has no separate button label, so the action's
    // own name stays findable through Obsidian's settings search.
    aliases: [CODEX_OPEN_LAUNCHER_LABEL],
    action: (_el: HTMLElement, _index: number) => {
      openLauncherSettings();
    },
  };
  const notifyItem = { name: CODEX_NOTIFY_NAME, desc: CODEX_NOTIFY_DESC };
  return {
    type: "group" as const,
    heading: CODEX_GROUP_HEADING,
    items: [
      hooksItem,
      copyInstallItem,
      copyUninstallItem,
      bridgeItem,
      copyBridgeItem,
      launcherItem,
      notifyItem,
    ] as [
      typeof hooksItem,
      typeof copyInstallItem,
      typeof copyUninstallItem,
      typeof bridgeItem,
      typeof copyBridgeItem,
      typeof launcherItem,
      typeof notifyItem,
    ],
  };
}

/**
 * The Codex status and its fetch rule, extracted so the tab reuses the Claude
 * group's behaviour without duplicating it: the status is read when the tab is
 * shown, the last known status stays on screen while a refetch is in flight
 * (only the very first load reads "Checking…"), a display during a fetch starts
 * no second one, and a rejected fetch settles on a definite `"unavailable"`.
 * The tab's own re-render never calls {@link CodexSettingsState.load}.
 */
export class CodexSettingsState {
  status: CodexStatusInput = "checking";
  private inFlight = false;
  private readonly getIntegration: (() => Promise<CodexIntegrationStatus>) | undefined;
  private readonly onChange: () => void;

  constructor(
    getIntegration: (() => Promise<CodexIntegrationStatus>) | undefined,
    onChange: () => void,
  ) {
    this.getIntegration = getIntegration;
    this.onChange = onChange;
  }

  /** Starts a read unless one is already in flight or no service seam is wired. */
  load(): void {
    if (this.inFlight || this.getIntegration === undefined) return;
    this.inFlight = true;
    const getIntegration = this.getIntegration;
    // `new Promise` also turns a synchronous throw in the seam into a rejection.
    new Promise<CodexIntegrationStatus>((resolve) => {
      resolve(getIntegration());
    }).then(
      (status) => {
        this.inFlight = false;
        this.status = status;
        this.onChange();
      },
      () => {
        this.inFlight = false;
        this.status = "unavailable";
        this.onChange();
      },
    );
  }
}
