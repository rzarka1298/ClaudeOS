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
  // Security and Paths facts (names of the dl rows).
  factInstallSecret: ["Install secret in keychain", SECURITY, "fragment"],
  factResearchKey: ["Research key in keychain", SECURITY, "fragment"],
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
