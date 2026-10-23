/**
 * The frozen mirror of the plugin copy, class names, attribute names and reason sentences the
 * health specs assert (plan 08-20, T-05.2-37 carried forward). The e2e package must not import the
 * plugin, so each value is copied here with the plugin module that owns it, and health-copy.test.ts
 * reads those modules as text and fails when a mirrored value is no longer in its owner. A
 * reworded label or reason therefore fails in CI, not in a live run. The specs read values from
 * HEALTH_TEXT, HEALTH_CLASSES, HEALTH_ATTRS and `reasonSentence`, never from a literal.
 *
 * Reason sentences follow `view/diagnostics-copy.ts` (`REASON_COPY`): the service sends reason
 * CODES, the plugin owns the sentence. A code whose sentence is built from facts (a count, a time,
 * a Phase 7 failure reason) is mirrored as a PREFIX, which is the fixed start of the sentence.
 */

import type { CopyTable } from "./tasks-copy.js";

const VIEW = "packages/plugin/src/view/";
const DIAG = `${VIEW}diagnostics-copy.ts`;
const ROW = `${VIEW}diagnostics-row.tsx`;
const SECTION = `${VIEW}diagnostics-section.tsx`;
const BUNDLE = `${VIEW}diagnostics-bundle.tsx`;
const SECTIONS = `${VIEW}settings-sections.ts`;
const DEST = `${VIEW}settings-destination.tsx`;
const CONTROLS = `${VIEW}settings-controls.tsx`;
const MODEL = `${VIEW}settings-model.ts`;
const DESTINATIONS = `${VIEW}destinations.ts`;
const TABS = `${VIEW}destination-tabs.tsx`;
const SETUP = "packages/plugin/src/setup-command.ts";
const EXPORT = "packages/plugin/src/health/export.ts";

export const HEALTH_TEXT_TABLE = {
  // Reaching the section.
  settingsTabId: ["settings", DESTINATIONS, "literal"],
  settingsNavLabel: ["Settings sections", DEST, "fragment"],
  navDiagnostics: ["Diagnostics", SECTIONS, "literal"],
  navVisual: ["Visual", SECTIONS, "literal"],
  navLaunchers: ["Launchers", SECTIONS, "literal"],
  navSecurity: ["Security", SECTIONS, "literal"],
  // The toolbar, the states and the summary.
  runChecksLabel: ["Run checks again", DIAG, "literal"],
  runChecksName: ["Run checks again: re-run the read-only checks", DIAG, "literal"],
  checking: ["Checking…", DIAG, "literal"],
  checkedJustNow: ["Checked just now.", DIAG, "fragment"],
  errorHeading: ["Couldn't run the checks.", DIAG, "literal"],
  staleLine: ["These checks are more than 5 minutes old. Press Run checks again.", DIAG, "literal"],
  nothingFailing: ["Nothing is failing.", DIAG, "fragment"],
  schedulerFixedLine: [
    "Manual trigger only in this version. Nothing runs on a timer.",
    DIAG,
    "literal",
  ],
  serviceAway: ["The companion service isn't running.", CONTROLS, "literal"],
  // Row names (the h5 of each row).
  rowService: ["Companion service", DIAG, "literal"],
  rowVault: ["Vault access", DIAG, "literal"],
  rowHooks: ["Claude Code hooks", DIAG, "literal"],
  rowCollectors: ["Usage collectors", DIAG, "literal"],
  rowScheduler: ["Scheduler", DIAG, "literal"],
  rowLaunchers: ["App launchers", DIAG, "literal"],
  chipRunning: ["Running", DIAG, "literal"],
  // Not part of this version.
  notInVersionHeading: ["Not part of this version", DIAG, "literal"],
  notInVersionScope: ["not-in-version", SECTION, "fragment"],
  nameGmail: ["Gmail", DIAG, "literal"],
  nameCalendar: ["Google Calendar", DIAG, "literal"],
  nameGithub: ["GitHub", DIAG, "literal"],
  // Freshness badge words.
  freshnessLive: ["Live", ROW, "literal"],
  freshnessCached: ["Cached", ROW, "literal"],
  freshnessStale: ["Stale", ROW, "literal"],
  freshnessUnavailable: ["Unavailable", ROW, "literal"],
  // Setup action labels and what they copy.
  copyInstall: ["Copy install command", DIAG, "literal"],
  copyKeySetup: ["Copy key setup command", DIAG, "literal"],
  setUpVault: ["Set up vault", DIAG, "literal"],
  goToPrefix: ["Go to the ", DIAG, "fragment"],
  goToSuffix: [" section", DIAG, "fragment"],
  goToApprovals: ["Go to the approvals and tasks section", DIAG, "literal"],
  openResearchView: ["Open the research view", DIAG, "literal"],
  showDetailsFor: ["Show details for ", DIAG, "fragment"],
  hideDetails: ["Hide details", DIAG, "literal"],
  claudeInstallCommand: ["./scripts/claude-hooks/install.sh", MODEL, "literal"],
  claudeInstallCopied: ["Install command copied. Run it in Terminal.", MODEL, "literal"],
  keySetupCommand: ["node scripts/research-key-setup.mjs", DIAG, "literal"],
  keySetupCopied: ["Key setup command copied. Run it in Terminal.", DIAG, "literal"],
  // The existing vault setup confirmation.
  vaultSetupTitle: ["Set up managed vault", SETUP, "literal"],
  confirm: ["Confirm", SETUP, "literal"],
  cancel: ["Cancel", SETUP, "literal"],
  // The diagnostic bundle block.
  bundleHeading: ["Diagnostic bundle", BUNDLE, "fragment"],
  showBundlePreview: ["Show bundle preview", BUNDLE, "literal"],
  hideBundlePreview: ["Hide bundle preview", BUNDLE, "literal"],
  copyBundle: ["Copy bundle", BUNDLE, "fragment"],
  saveBundle: ["Save bundle", BUNDLE, "fragment"],
  bundleCopied: ["Bundle copied.", BUNDLE, "literal"],
  bundleSaved: ["Bundle saved.", BUNDLE, "literal"],
  saveCancelled: ["Save cancelled. Nothing was written.", BUNDLE, "literal"],
  saveFailed: ["Couldn't save the bundle.", BUNDLE, "literal"],
  insideVault: [
    "That location is inside your vault. Choose a folder outside the vault.",
    BUNDLE,
    "literal",
  ],
  saveUnavailable: [
    "The save dialog isn't available here. Use Copy bundle instead.",
    BUNDLE,
    "literal",
  ],
  bundleRefused: ["The bundle was refused by a privacy check.", BUNDLE, "literal"],
  bundleWaiting: ["Waiting for the checks.", BUNDLE, "literal"],
  bundleStale: ["Built from checks older than 5 minutes", BUNDLE, "literal"],
  bundleUnavailable: ["The bundle couldn't be built.", BUNDLE, "literal"],
  bundleNotOffered: ["Bundle not offered", BUNDLE, "fragment"],
  bundlePreviewLabel: ["Diagnostic bundle preview", BUNDLE, "fragment"],
  bundleServiceAway: [
    "The companion service isn't running, so service versions and counts are left out.",
    BUNDLE,
    "literal",
  ],
  bundleFileNamePrefix: ["claude-command-center-diagnostics-", EXPORT, "fragment"],
} as const satisfies CopyTable;

export const HEALTH_CLASSES_TABLE = {
  health: ["ccc-health", SECTION, "fragment"],
  healthToolbar: ["ccc-health-toolbar", SECTION, "fragment"],
  healthSummary: ["ccc-health-summary", SECTION, "fragment"],
  healthStale: ["ccc-health-stale", SECTION, "fragment"],
  healthError: ["ccc-health-error", SECTION, "fragment"],
  healthRow: ["ccc-health-row", ROW, "fragment"],
  healthDetail: ["ccc-health-detail", ROW, "fragment"],
  healthMeta: ["ccc-health-meta", ROW, "fragment"],
  healthPart: ["ccc-health-part", ROW, "fragment"],
  healthPartName: ["ccc-health-part-name", ROW, "fragment"],
  healthCommand: ["ccc-health-command", ROW, "fragment"],
  setupCallout: ["ccc-setup-callout", ROW, "fragment"],
  stateBody: ["ccc-state-body", ROW, "fragment"],
  cardActions: ["ccc-card-actions", ROW, "fragment"],
  badge: ["ccc-badge", ROW, "fragment"],
  badgeLabel: ["ccc-badge-label", ROW, "fragment"],
  hidden: ["ccc-visually-hidden", ROW, "fragment"],
  connectButton: ["ccc-connect-button", ROW, "fragment"],
  settingsItemTitle: ["ccc-settings-item-title", ROW, "fragment"],
  settingsGroupTitle: ["ccc-settings-group-title", SECTION, "fragment"],
  settingsSectionTitle: ["ccc-settings-section-title", SECTION, "fragment"],
  settingsNav: ["ccc-settings-nav", DEST, "fragment"],
  settingsNavItem: ["ccc-settings-nav-item", DEST, "fragment"],
  settingsContent: ["ccc-settings-content", DEST, "fragment"],
  settingsStatus: ["ccc-settings-status", CONTROLS, "fragment"],
  bundlePreview: ["ccc-bundle-preview", BUNDLE, "fragment"],
  tabPrefix: ["ccc-tab-", TABS, "fragment"],
} as const satisfies CopyTable;

export const HEALTH_ATTRS_TABLE = {
  subsystem: ["data-subsystem", ROW, "fragment"],
  status: ["data-status", ROW, "fragment"],
  reason: ["data-reason", ROW, "fragment"],
  part: ["data-part", ROW, "fragment"],
  badge: ["data-badge", ROW, "fragment"],
  scope: ["data-scope", SECTION, "fragment"],
  busy: ["aria-busy", SECTION, "fragment"],
  current: ["aria-current", DEST, "fragment"],
  expanded: ["aria-expanded", ROW, "fragment"],
  disabled: ["aria-disabled", SECTION, "fragment"],
} as const satisfies CopyTable;

/**
 * The reason sentences the health specs assert, by reason code. `literal` entries are whole
 * sentences; `fragment` entries are the fixed start of a sentence built from facts (see
 * {@link HEALTH_REASON_PREFIXES}).
 */
export const HEALTH_REASON_TABLE = {
  "probe-timeout": ["This check took too long, so its result is unknown.", DIAG, "literal"],
  "service-live": ["The companion service is running and answering.", DIAG, "literal"],
  "service-unreachable": ["The plugin can't reach the companion service.", DIAG, "literal"],
  "service-not-running": [
    "Can't be checked while the companion service isn't running.",
    DIAG,
    "literal",
  ],
  "vault-ready": ["The managed vault is ready.", DIAG, "literal"],
  "vault-not-set-up": ["No managed vault is set up yet.", DIAG, "literal"],
  "managed-tree-incomplete": ["Some managed folders are missing from the vault.", DIAG, "literal"],
  "vault-mismatch": [
    "The vault open in Obsidian isn't the one the companion service manages.",
    DIAG,
    "literal",
  ],
  "vault-root-missing": ["The managed vault folder is missing.", DIAG, "literal"],
  "vault-root-unreadable": ["The managed vault folder can't be read.", DIAG, "literal"],
  "vault-root-not-writable": [
    "The managed vault folder is read-only, so notes can't be saved.",
    DIAG,
    "literal",
  ],
  "hooks-not-installed": [
    "Hooks aren't installed. Session tracking and waiting-for-approval states need them.",
    DIAG,
    "literal",
  ],
  "hooks-disabled-in-claude": [
    "Hooks are installed, but Claude Code has all hooks turned off.",
    DIAG,
    "literal",
  ],
  "hook-runtime-missing": ["The program the hooks run with can't be found.", DIAG, "literal"],
  "hooks-state-unreadable": [
    "Claude Code's settings couldn't be read, so hook status is unknown.",
    DIAG,
    "literal",
  ],
  "no-events-yet": [
    "Hooks are installed. No event has arrived since the companion service started.",
    DIAG,
    "literal",
  ],
  "telemetry-ok": ["Usage telemetry is arriving in the expected format.", DIAG, "literal"],
  "telemetry-shape-changed": [
    "Claude Code changed its event format. Usage tracking is paused rather than guessed.",
    DIAG,
    "literal",
  ],
  "analysis-on": ["Transcript analysis is on.", DIAG, "literal"],
  "analysis-off": [
    "Transcript analysis is off. Token counts and costs stay empty until you turn it on.",
    DIAG,
    "literal",
  ],
  "codex-not-installed": ["Codex isn't installed on this Mac.", DIAG, "literal"],
  "codex-hooks-not-installed": ["Codex hooks aren't installed.", DIAG, "literal"],
  "codex-bridge-not-installed": ["The Codex bridge isn't installed.", DIAG, "literal"],
  "never-run": ["No research run yet. Runs start only when you press Run now.", DIAG, "literal"],
  "research-key-present": ["A research key is in the macOS keychain.", DIAG, "literal"],
  "research-key-missing": ["No research key is stored in the macOS keychain.", DIAG, "literal"],
  "run-interrupted": [
    "The last run ended without reporting, so its result is unknown.",
    DIAG,
    "literal",
  ],
  "launcher-not-set-up": ["Not set up.", DIAG, "literal"],
  "launcher-untested": ["Saved but not tested yet.", DIAG, "literal"],
  "bundle-not-found": ["The saved app can't be found on this Mac.", DIAG, "literal"],
  "executable-not-found": ["The saved program can't be found or can't be run.", DIAG, "literal"],
  // Sentences built from facts or from another module: the fixed start only.
  "statusline-not-installed": ["The status-line wrapper", DIAG, "fragment"],
  "spool-dropped-records": ["Hook records were dropped", DIAG, "fragment"],
  "spool-clean": ["No hook records", DIAG, "fragment"],
  "run-all-sources-failed": ["The last run failed: ", DIAG, "fragment"],
} as const satisfies CopyTable;

/** The reason codes whose mirrored text is only the start of the sentence. */
export const HEALTH_REASON_PREFIX_CODES: readonly string[] = Object.freeze([
  "statusline-not-installed",
  "spool-dropped-records",
  "spool-clean",
  "run-all-sources-failed",
]);

type Values<T extends CopyTable> = { readonly [K in keyof T]: T[K][0] };

function values<T extends CopyTable>(table: T): Values<T> {
  return Object.fromEntries(
    Object.entries(table).map(([key, entry]) => [key, entry[0]]),
  ) as Values<T>;
}

export const HEALTH_TEXT: Values<typeof HEALTH_TEXT_TABLE> = Object.freeze(
  values(HEALTH_TEXT_TABLE),
);
export const HEALTH_CLASSES: Values<typeof HEALTH_CLASSES_TABLE> = Object.freeze(
  values(HEALTH_CLASSES_TABLE),
);
export const HEALTH_ATTRS: Values<typeof HEALTH_ATTRS_TABLE> = Object.freeze(
  values(HEALTH_ATTRS_TABLE),
);

/** The whole sentences, by reason code. */
export const HEALTH_REASONS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(HEALTH_REASON_TABLE)
      .filter(([code]) => !HEALTH_REASON_PREFIX_CODES.includes(code))
      .map(([code, entry]) => [code, entry[0]]),
  ),
);

/** The fixed starts of the sentences that carry facts, by reason code. */
export const HEALTH_REASON_PREFIXES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(HEALTH_REASON_TABLE)
      .filter(([code]) => HEALTH_REASON_PREFIX_CODES.includes(code))
      .map(([code, entry]) => [code, entry[0]]),
  ),
);

/** The sentence of a code with a whole mirrored sentence; throws for any other code. */
export function reasonSentence(code: string): string {
  const sentence = Object.hasOwn(HEALTH_REASONS, code) ? HEALTH_REASONS[code] : undefined;
  if (sentence === undefined) throw new Error(`No mirrored sentence for the reason code ${code}.`);
  return sentence;
}

/**
 * Whether `text` is the sentence the plugin writes for `code`: equal to the mirrored sentence, or
 * starting with the mirrored start of a sentence that carries facts. A code with no mirror matches
 * nothing, so a drill can never pass on a code it cannot judge.
 */
export function reasonTextMatches(code: string, text: string): boolean {
  if (Object.hasOwn(HEALTH_REASONS, code)) return HEALTH_REASONS[code] === text;
  if (Object.hasOwn(HEALTH_REASON_PREFIXES, code)) {
    return text.startsWith(HEALTH_REASON_PREFIXES[code] as string);
  }
  return false;
}

/** True when the code has a mirrored sentence or a mirrored sentence start. */
export function hasReasonMirror(code: string): boolean {
  return Object.hasOwn(HEALTH_REASONS, code) || Object.hasOwn(HEALTH_REASON_PREFIXES, code);
}
