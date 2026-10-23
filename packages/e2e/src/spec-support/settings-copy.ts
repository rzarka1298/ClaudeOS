/**
 * The frozen mirror of the plugin copy, class names and attribute names the Settings specs assert
 * (plan 08-22, T-05.2-37 carried forward). The e2e package must not import the plugin, so each
 * value is copied here with the plugin module that owns it, and settings-copy.test.ts reads those
 * modules as text and fails when a mirrored value is no longer in its owner. A reworded label
 * therefore fails in CI, not in a live run. The specs read values from SETTINGS_TEXT,
 * SETTINGS_CLASSES and SETTINGS_ATTRS, never from a literal.
 */

import type { CopyTable } from "./tasks-copy.js";

const VIEW = "packages/plugin/src/view/";
const SECTIONS = `${VIEW}settings-sections.ts`;
const DEST = `${VIEW}settings-destination.tsx`;
const CONTROLS = `${VIEW}settings-controls.tsx`;
const INTEGRATIONS = `${VIEW}settings-integrations.tsx`;
const SECURITY = `${VIEW}settings-security.tsx`;
const PATHS = `${VIEW}settings-paths.tsx`;
const PROJECTS = `${VIEW}settings-projects.tsx`;
const SCHEDULES = `${VIEW}settings-schedules.tsx`;
const REGISTER = `${VIEW}register-flow.tsx`;
const SCAN = `${VIEW}scan-folders.tsx`;
const LAUNCHERS = `${VIEW}launchers-settings.tsx`;
const CLAUDE_PANEL = `${VIEW}claude-code-panel.tsx`;
const PANEL_KIT = `${VIEW}launcher-panel-kit.tsx`;
const MODEL = `${VIEW}settings-model.ts`;
const DESTINATIONS = `${VIEW}destinations.ts`;
const TABS = `${VIEW}destination-tabs.tsx`;
const SHELL = `${VIEW}shell.tsx`;
const ROW = `${VIEW}diagnostics-row.tsx`;

/** The nine sections in the plugin's fixed nav order: the deep-link id and the label the nav shows. */
export const SETTINGS_SECTION_IDS = [
  "projects",
  "launchers",
  "integrations",
  "approvals-tasks",
  "paths",
  "visual",
  "security",
  "schedules",
  "diagnostics",
] as const;

export type SettingsSectionKey = (typeof SETTINGS_SECTION_IDS)[number];

export const SETTINGS_TEXT_TABLE = {
  // Reaching the destination.
  settingsTabId: ["settings", DESTINATIONS, "literal"],
  overviewTabId: ["overview", DESTINATIONS, "literal"],
  settingsHeading: ["Settings", DEST, "fragment"],
  settingsDescription: ["Plugin configuration and diagnostics.", DEST, "fragment"],
  navLabel: ["Settings sections", DEST, "fragment"],
  // The nine section labels (the nav shows exactly these, in this order).
  navProjects: ["Projects", SECTIONS, "literal"],
  navLaunchers: ["Launchers", SECTIONS, "literal"],
  navIntegrations: ["Integrations", SECTIONS, "literal"],
  navApprovalsTasks: ["Approvals and tasks", SECTIONS, "literal"],
  navPaths: ["Paths", SECTIONS, "literal"],
  navVisual: ["Visual", SECTIONS, "literal"],
  navSecurity: ["Security", SECTIONS, "literal"],
  navSchedules: ["Schedules", SECTIONS, "literal"],
  navDiagnostics: ["Diagnostics", SECTIONS, "literal"],
  // Destination links the specs press.
  goToLaunchers: ["Go to the launchers section", INTEGRATIONS, "literal"],
  goToApprovals: ["Go to the approvals and tasks section", SECURITY, "literal"],
  // The service-away reason every service-bound control is described by.
  serviceAway: ["The companion service isn't running.", CONTROLS, "literal"],
  serviceOwnedAway: [
    "Projects, launchers and paths are managed by the companion service, which isn't running. They are read-only until it is back.",
    PROJECTS,
    "literal",
  ],
  // Security and Paths facts (names of the dl rows).
  factInstallSecret: ["Install secret in keychain", SECURITY, "fragment"],
  factResearchKey: ["Research key in keychain", SECURITY, "fragment"],
  factServiceConnection: ["Service connection", SECURITY, "fragment"],
  factNetworkListener: ["Network listener", SECURITY, "fragment"],
  factConnectionTokens: ["Connection tokens", SECURITY, "fragment"],
  factAlwaysAllow: ["Always allow", SECURITY, "fragment"],
  securityConnection: ["A local socket that only you can read (mode 0600).", SECURITY, "fragment"],
  securityNetwork: [
    "None. The companion service doesn't listen on any network port.",
    SECURITY,
    "fragment",
  ],
  securityTokens: ["Each lasts", SECURITY, "fragment"],
  securityAlways: ["No always-allow control exists.", SECURITY, "fragment"],
  chipPresent: ["Present", SECURITY, "literal"],
  chipMissing: ["Missing", SECURITY, "literal"],
  chipUnknown: ["Unknown", `packages/domain/src/diagnostics.ts`, "literal"],
  chipNeedsSetup: ["Needs setup", `packages/domain/src/diagnostics.ts`, "literal"],
  copyKeySetup: ["Copy key setup command", SECURITY, "literal"],
  factManagedVault: ["Managed vault", PATHS, "fragment"],
  factDataFolder: ["Service data folder", PATHS, "fragment"],
  factSocket: ["Service socket", PATHS, "fragment"],
  unknownWord: ["Unknown", PATHS, "fragment"],
  // Schedules.
  factTopic: ["Topic", SCHEDULES, "fragment"],
  factSources: ["Sources", SCHEDULES, "fragment"],
  factScheduling: ["Scheduling", SCHEDULES, "fragment"],
  manualOnly: ["Manual trigger only in this version.", SCHEDULES, "literal"],
  noSources: [
    "No sources are configured. A run would fail with no source to fetch.",
    SCHEDULES,
    "literal",
  ],
  openResearchView: ["Open the research view", SCHEDULES, "literal"],
  // Projects: register a folder and add a scan folder by typed path.
  registerOpen: ["Register a project", REGISTER, "fragment"],
  typePath: ["Type a path instead", REGISTER, "fragment"],
  folderPath: ["Folder path", REGISTER, "fragment"],
  registerFolder: ["Register folder", REGISTER, "fragment"],
  registeredPrefix: ["Registered ", REGISTER, "fragment"],
  addScanOpen: ["Add a scan folder", SCAN, "fragment"],
  typeScanPath: ["Type a path instead for a scan folder", SCAN, "literal"],
  addScanSubmit: ["Add scan folder", SCAN, "fragment"],
  goToProjects: ["Go to the projects view", PROJECTS, "literal"],
  // Launchers.
  detectApps: ["Detect apps", LAUNCHERS, "fragment"],
  detectedPrefix: ["Detected ", LAUNCHERS, "fragment"],
  detectFailed: ["Couldn't detect apps.", LAUNCHERS, "fragment"],
  launcherBanner: [
    "Reconnect the service to detect, save or test launchers.",
    LAUNCHERS,
    "fragment",
  ],
  saveLauncher: ["Save launcher", CLAUDE_PANEL, "fragment"],
  useDifferentPath: ["Use a different path", CLAUDE_PANEL, "fragment"],
  pathToClaude: ["Path to claude", CLAUDE_PANEL, "fragment"],
  panelAntigravity: ["Antigravity", PANEL_KIT, "literal"],
  panelClaudeCode: ["Claude Code", PANEL_KIT, "literal"],
  panelClaudeDesktop: ["Claude Desktop", PANEL_KIT, "literal"],
  setUpCommand: ["set-up-launchers", `packages/plugin/src/projects/commands.ts`, "literal"],
  openOverviewCommand: ["open-overview", "packages/plugin/src/main.ts", "literal"],
  // Setting rows and their options.
  rowReducedMotion: ["Reduced motion", MODEL, "literal"],
  optionSystem: ["System", MODEL, "literal"],
  optionAlwaysReduced: ["Always reduced", MODEL, "literal"],
  rowTranscript: ["Transcript analysis", MODEL, "literal"],
  rowDeleteUsage: ["Delete cached usage analytics", MODEL, "literal"],
  rowNotifyApprovals: ["Approval notifications", MODEL, "literal"],
  rowSendTest: ["Send a test approval", MODEL, "literal"],
  rowRebuild: ["Rebuild task index", MODEL, "literal"],
  // Integrations.
  statusUnavailable: [
    "Status unavailable — the companion service isn't running.",
    MODEL,
    "literal",
  ],
  copyInstall: ["Copy install command", INTEGRATIONS, "literal"],
} as const satisfies CopyTable;

export const SETTINGS_CLASSES_TABLE = {
  commandCenter: ["ccc-command-center", SHELL, "fragment"],
  settings: ["ccc-settings", DEST, "fragment"],
  settingsHeader: ["ccc-settings-header", DEST, "fragment"],
  settingsNav: ["ccc-settings-nav", DEST, "fragment"],
  settingsNavItem: ["ccc-settings-nav-item", DEST, "fragment"],
  settingsContent: ["ccc-settings-content", DEST, "fragment"],
  settingsStatus: ["ccc-settings-status", CONTROLS, "fragment"],
  settingRow: ["ccc-setting-row", CONTROLS, "fragment"],
  settingRowText: ["ccc-setting-row-text", CONTROLS, "fragment"],
  settingRowControl: ["ccc-setting-row-control", CONTROLS, "fragment"],
  switchControl: ["ccc-switch", CONTROLS, "fragment"],
  selectWrap: ["ccc-select-wrap", CONTROLS, "fragment"],
  detailFields: ["ccc-detail-fields", SECURITY, "fragment"],
  badge: ["ccc-badge", SECURITY, "fragment"],
  badgeLabel: ["ccc-badge-label", SECURITY, "fragment"],
  skeletonLine: ["ccc-skeleton-line", SECURITY, "fragment"],
  mono: ["ccc-mono", SECURITY, "fragment"],
  hidden: ["ccc-visually-hidden", SECURITY, "fragment"],
  settingPath: ["ccc-setting-path", PATHS, "fragment"],
  settingUnknown: ["ccc-setting-unknown", PATHS, "fragment"],
  tabPrefix: ["ccc-tab-", TABS, "fragment"],
} as const satisfies CopyTable;

export const SETTINGS_ATTRS_TABLE = {
  current: ["aria-current", DEST, "fragment"],
  checked: ["aria-checked", CONTROLS, "fragment"],
  disabled: ["aria-disabled", CONTROLS, "fragment"],
  busy: ["aria-busy", CONTROLS, "fragment"],
  describedBy: ["aria-describedby", CONTROLS, "fragment"],
  result: ["data-result", SECURITY, "fragment"],
  status: ["data-status", SECURITY, "fragment"],
  badge: ["data-badge", ROW, "fragment"],
} as const satisfies CopyTable;

type Values<T extends CopyTable> = { readonly [K in keyof T]: T[K][0] };

function values<T extends CopyTable>(table: T): Values<T> {
  return Object.fromEntries(
    Object.entries(table).map(([key, entry]) => [key, entry[0]]),
  ) as Values<T>;
}

export const SETTINGS_TEXT: Values<typeof SETTINGS_TEXT_TABLE> = Object.freeze(
  values(SETTINGS_TEXT_TABLE),
);
export const SETTINGS_CLASSES: Values<typeof SETTINGS_CLASSES_TABLE> = Object.freeze(
  values(SETTINGS_CLASSES_TABLE),
);
export const SETTINGS_ATTRS: Values<typeof SETTINGS_ATTRS_TABLE> = Object.freeze(
  values(SETTINGS_ATTRS_TABLE),
);

/** The nine labels in nav order, from the mirrored text. */
export const SETTINGS_SECTION_LABELS: readonly string[] = Object.freeze([
  SETTINGS_TEXT.navProjects,
  SETTINGS_TEXT.navLaunchers,
  SETTINGS_TEXT.navIntegrations,
  SETTINGS_TEXT.navApprovalsTasks,
  SETTINGS_TEXT.navPaths,
  SETTINGS_TEXT.navVisual,
  SETTINGS_TEXT.navSecurity,
  SETTINGS_TEXT.navSchedules,
  SETTINGS_TEXT.navDiagnostics,
]);

/** The label of one section by its id. */
export function sectionLabel(id: SettingsSectionKey): string {
  const label = SETTINGS_SECTION_LABELS[SETTINGS_SECTION_IDS.indexOf(id)];
  if (label === undefined) throw new Error(`No label for the section ${id}.`);
  return label;
}
