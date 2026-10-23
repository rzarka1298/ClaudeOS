/**
 * The frozen mirror of the plugin copy and class names the Overview slice spec asserts (plan
 * 08-19, T-05.2-37 carried forward). The e2e package must not import the plugin, so each value is
 * copied here with the plugin module that owns it, and overview-copy.test.ts reads those modules
 * as text and fails when a mirrored value is no longer in its owner. A reworded label therefore
 * fails in CI, not in a live run. The spec reads values from OVERVIEW_TEXT and OVERVIEW_CLASSES,
 * never from a literal.
 */

import type { CopyTable } from "./tasks-copy.js";

const WIDGETS = "packages/plugin/src/widgets/";
const PANELS = `${WIDGETS}panels.tsx`;
const FRAME = `${WIDGETS}frame.tsx`;
const FOOTER = `${WIDGETS}footer.tsx`;
const TOOLBAR = `${WIDGETS}launch-toolbar.tsx`;
const SESSIONS = `${WIDGETS}active-sessions.tsx`;
const LIST = `${WIDGETS}list-body.tsx`;
const FEEDS = "packages/plugin/src/overview/overview-feeds.ts";
const LAUNCH_COPY = "packages/plugin/src/projects/launch-copy.ts";
const DESTINATIONS = "packages/plugin/src/view/destinations.ts";
const SHELL = "packages/plugin/src/view/shell.tsx";
const TABS = "packages/plugin/src/view/destination-tabs.tsx";

export const OVERVIEW_TEXT_TABLE = {
  // The four cards of the slice.
  projectShortcutsTitle: ["Project shortcuts", PANELS, "literal"],
  activeSessionsTitle: ["Active Claude sessions", SESSIONS, "literal"],
  todayTitle: ["Today", PANELS, "literal"],
  techIntelTitle: ["Technology and market intelligence", PANELS, "literal"],
  overviewTabId: ["overview", DESTINATIONS, "literal"],
  researchTabId: ["research", DESTINATIONS, "literal"],
  // Today.
  dueTodayHeading: ["Due today", PANELS, "fragment"],
  nextOpenHeading: ["Next open task", PANELS, "fragment"],
  automationHeading: ["Automation", PANELS, "fragment"],
  nothingDue: ["Nothing is due today.", PANELS, "fragment"],
  noFailures: ["No automation failures.", PANELS, "fragment"],
  failedStem: ["Research run failed ", PANELS, "fragment"],
  openTaskPrefix: ["Open task: ", PANELS, "fragment"],
  calendarGmailNote: ["Google Calendar and Gmail: not part of this version.", PANELS, "fragment"],
  notInVersionSummary: ["Google Calendar and Gmail aren't part of this version", FEEDS, "literal"],
  nextDuePrefix: ["Next due ", FEEDS, "fragment"],
  mostRecentOpen: ["Most recent open task", FEEDS, "literal"],
  // The footer.
  calendarSource: ["Google Calendar", PANELS, "literal"],
  gmailSource: ["Gmail", PANELS, "literal"],
  taskSource: ["Managed task store", PANELS, "literal"],
  automationSource: ["Automation runs", PANELS, "literal"],
  notPartOfThisVersion: ["not part of this version", FOOTER, "literal"],
  noResponse: ["no response", FOOTER, "literal"],
  freshnessLive: ["Live", FOOTER, "literal"],
  freshnessCached: ["Cached", FOOTER, "literal"],
  freshnessStale: ["Stale", FOOTER, "literal"],
  freshnessUnavailable: ["Unavailable", FOOTER, "literal"],
  partialLabel: ["Partial", FOOTER, "fragment"],
  // The disconnected card.
  serviceDisconnected: ["Service disconnected", FRAME, "fragment"],
  // Technology.
  noReportsYet: ["No reports yet", PANELS, "literal"],
  openReport: ["Open report", PANELS, "fragment"],
  openReportNamePrefix: ["Open report: ", PANELS, "fragment"],
  aiLine: ["AI-generated summary. Not verified by a person.", PANELS, "fragment"],
  openResearchView: ["Open the research view", PANELS, "fragment"],
  // The launch control and its typed not-set-up outcome.
  antigravityLabel: ["Antigravity", TOOLBAR, "literal"],
  antigravityNameInfix: [" in Antigravity", TOOLBAR, "fragment"],
  claudeCodeLabel: ["Claude Code", TOOLBAR, "literal"],
  claudeCodeNamePrefix: ["Start Claude Code in ", TOOLBAR, "fragment"],
  launcherNotSetUp: ["{Launcher} isn't set up yet.", LAUNCH_COPY, "literal"],
  launcherNextStep: ["Set it up in Settings → Launchers, then try again.", LAUNCH_COPY, "literal"],
  serviceUnreachable: ["Couldn't reach the command center service.", LAUNCH_COPY, "literal"],
  toolbarRole: ["toolbar", TOOLBAR, "fragment"],
} as const satisfies CopyTable;

export const OVERVIEW_CLASSES_TABLE = {
  card: ["ccc-card", FRAME, "fragment"],
  cardBody: ["ccc-card-body", FRAME, "fragment"],
  stateHeading: ["ccc-state-heading", FRAME, "fragment"],
  stateBody: ["ccc-state-body", FRAME, "fragment"],
  footer: ["ccc-card-footer", FOOTER, "fragment"],
  footerTime: ["ccc-footer-time", FOOTER, "fragment"],
  badge: ["ccc-badge", FOOTER, "fragment"],
  badgeLabel: ["ccc-badge-label", FOOTER, "fragment"],
  hidden: ["ccc-visually-hidden", FOOTER, "fragment"],
  sourceButton: ["ccc-source-button", FOOTER, "fragment"],
  sourceRow: ["ccc-source-row", FOOTER, "fragment"],
  listRow: ["ccc-list-row", LIST, "fragment"],
  listPrimary: ["ccc-list-primary", LIST, "fragment"],
  listMeta: ["ccc-list-meta", LIST, "fragment"],
  listMore: ["ccc-list-more", LIST, "fragment"],
  todaySection: ["ccc-today-section", PANELS, "fragment"],
  todayNote: ["ccc-today-note", PANELS, "fragment"],
  errorGlyph: ["ccc-error-glyph", PANELS, "fragment"],
  intelLatest: ["ccc-intel-latest", PANELS, "fragment"],
  connectButton: ["ccc-connect-button", PANELS, "fragment"],
  launchToolbar: ["ccc-launch-toolbar", TOOLBAR, "fragment"],
  launchStatus: ["ccc-launch-status", TOOLBAR, "fragment"],
  quickAction: ["ccc-quick-action", TOOLBAR, "fragment"],
  tabPrefix: ["ccc-tab-", TABS, "fragment"],
  root: ["ccc-command-center", SHELL, "fragment"],
} as const satisfies CopyTable;

type Values<T extends CopyTable> = { readonly [K in keyof T]: T[K][0] };

function values<T extends CopyTable>(table: T): Values<T> {
  return Object.fromEntries(
    Object.entries(table).map(([key, entry]) => [key, entry[0]]),
  ) as Values<T>;
}

export const OVERVIEW_TEXT: Values<typeof OVERVIEW_TEXT_TABLE> = Object.freeze(
  values(OVERVIEW_TEXT_TABLE),
);
export const OVERVIEW_CLASSES: Values<typeof OVERVIEW_CLASSES_TABLE> = Object.freeze(
  values(OVERVIEW_CLASSES_TABLE),
);

/** The four cards of the slice by title, in the order the page lists them (SLICE-01, D-22). */
export const SLICE_CARD_TITLES: readonly string[] = Object.freeze([
  OVERVIEW_TEXT.projectShortcutsTitle,
  OVERVIEW_TEXT.activeSessionsTitle,
  OVERVIEW_TEXT.todayTitle,
  OVERVIEW_TEXT.techIntelTitle,
]);

/**
 * Wording that would present Calendar or Gmail as an empty or zero source (D-20, D-48). The first
 * is the retired Phase 3 line; the others are the shapes a count of zero would take. The honest
 * note ("not part of this version") matches none of them.
 */
export const CALENDAR_ZERO_PATTERNS: readonly RegExp[] = Object.freeze([
  /Nothing else on the calendar/i,
  /\b0\s+(?:calendar\s+)?(?:events?|meetings?)\b/i,
  /\bcalendar\b[^.\n]{0,20}:\s*0\b/i,
]);
