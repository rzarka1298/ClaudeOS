/**
 * The mirror of every plugin string the approvals specs assert (05.2-06, T-05.2-24).
 *
 * The e2e package may not import plugin code, so each literal is copied here with the plugin
 * source file (relative to packages/plugin/src) that owns it. `approvals-copy.test.ts` reads
 * those source files as text and proves each literal still appears in its file, so a copy
 * change in the plugin breaks CI instead of making a spec pass vacuously or fail for the wrong
 * reason. Specs import the strings from here and never write an assertion literal inline.
 */

export interface MirrorEntry {
  readonly key: string;
  /** Path relative to packages/plugin/src. */
  readonly source: string;
  readonly text: string;
}

const registry: MirrorEntry[] = [];

/** Registers a literal with the file that owns it and returns it. */
function mirror(key: string, source: string, text: string): string {
  registry.push({ key, source, text });
  return text;
}

/** Every registered literal, in registration order. */
export function mirroredEntries(): readonly MirrorEntry[] {
  return registry;
}

/**
 * The entries whose text no longer appears verbatim in their source file. A source that cannot
 * be read counts as drift for each of its entries. Pure: the reader is a parameter.
 */
export function findDrift(
  entries: readonly MirrorEntry[],
  readSource: (source: string) => string,
): MirrorEntry[] {
  const cache = new Map<string, string | null>();
  const load = (source: string): string | null => {
    if (!cache.has(source)) {
      try {
        cache.set(source, readSource(source));
      } catch {
        cache.set(source, null);
      }
    }
    return cache.get(source) ?? null;
  };
  return entries.filter((entry) => !(load(entry.source)?.includes(entry.text) ?? false));
}

const COPY = "view/approvals-copy.ts";
const SETTINGS = "view/settings-tab.ts";
const TASKS_COPY = "view/tasks-copy.ts";

export const APPROVALS_COPY = Object.freeze({
  // Locked labels (approvals-copy.ts).
  sectionHeading: mirror("sectionHeading", COPY, "Approvals"),
  denyLabel: mirror("denyLabel", COPY, "Deny"),
  approveLabel: mirror("approveLabel", COPY, "Approve once"),

  // The one polite status line (APPROVAL_STATUS and settledStatus in approvals-copy.ts).
  statusSending: mirror("statusSending", COPY, "Sending your decision…"),
  statusApproved: mirror("statusApproved", COPY, "Approved. Carrying out the action…"),
  statusDenied: mirror("statusDenied", COPY, "Denied. Nothing was changed."),
  statusCarriedOut: mirror("statusCarriedOut", COPY, "Carried out."),
  statusExpiredClosed: mirror(
    "statusExpiredClosed",
    COPY,
    "This request expired and was denied automatically. Nothing was changed.",
  ),

  // DISABLED_REASONS.disconnected, the one reason every service-backed control gives.
  serviceDown: mirror("serviceDown", COPY, "The companion service isn't running."),
  noRisks: mirror("noRisks", COPY, "None listed."),

  // FILTER_LABEL.
  filterPending: mirror("filterPending", COPY, "Pending"),
  filterDecided: mirror("filterDecided", COPY, "Decided"),
  filterExpired: mirror("filterExpired", COPY, "Expired"),

  // HISTORY_LABEL.
  historyRequested: mirror("historyRequested", COPY, "Requested"),
  historyApproved: mirror("historyApproved", COPY, "Approved"),
  historyDenied: mirror("historyDenied", COPY, "Denied"),
  historyStarted: mirror("historyStarted", COPY, "Started carrying out"),
  historyExecuted: mirror("historyExecuted", COPY, "Carried out"),
  historyExpired: mirror("historyExpired", COPY, "Expired"),

  // TERM, DECIDED_THROUGH and BLOCK_HEADING.
  fingerprintTerm: mirror("fingerprintTerm", COPY, "Content fingerprint"),
  requestIdTerm: mirror("requestIdTerm", COPY, "Request ID"),
  decidedThroughTerm: mirror("decidedThroughTerm", COPY, "Decided through"),
  decidedThroughPlugin: mirror("decidedThroughPlugin", COPY, "The command center"),
  recordHeading: mirror("recordHeading", COPY, "Record"),
  historyHeading: mirror("historyHeading", COPY, "History"),

  // Command id suffixes; the plugin id prefix comes from the sandbox driver.
  inboxCommandSuffix: mirror("inboxCommandSuffix", "approvals/commands.ts", "open-approval-inbox"),
  setupCommandSuffix: mirror("setupCommandSuffix", "setup-command.ts", "set-up-managed-vault"),

  // The request pane and the filter chips (approvals-copy.ts, approval-detail.tsx).
  filterGroupLabel: mirror("filterGroupLabel", COPY, "Approval filter"),
  countdownPrefix: mirror("countdownPrefix", COPY, "Expires"),
  deniedAutomatically: mirror(
    "deniedAutomatically",
    COPY,
    "If you don't decide, it's denied automatically.",
  ),
  computedCaption: mirror("computedCaption", COPY, "Computed by the command center"),
  providedByCaption: mirror("providedByCaption", "view/approval-detail.tsx", "Provided by "),
  requestedByTerm: mirror("requestedByTerm", COPY, "Requested by"),
  decisionGroupLabel: mirror("decisionGroupLabel", COPY, "Decision"),
  // BLOCK_HEADING.
  headingHappen: mirror("headingHappen", COPY, "What will happen"),
  headingTarget: mirror("headingTarget", COPY, "Target"),
  headingReason: mirror("headingReason", COPY, "Reason"),
  headingRisks: mirror("headingRisks", COPY, "Risks"),

  // The native notification and the Obsidian Notice that replaces it (approvals/notify.ts).
  notificationTitle: mirror("notificationTitle", "approvals/notify.ts", "Approval needed"),
  inboxNoticeText: mirror(
    "inboxNoticeText",
    "approvals/notify.ts",
    'Approval needed. Run "Open approval inbox" from the command palette to review it.',
  ),

  // Vault setup (setup-command.ts) and the mirror note link the service writes.
  vaultReadyPrefix: mirror("vaultReadyPrefix", "setup-command.ts", "Managed vault ready:"),
  confirmButton: mirror("confirmButton", "setup-command.ts", "Confirm"),
  mirrorLinkPrefix: mirror(
    "mirrorLinkPrefix",
    "../../service/src/approval-wiring/mirror.ts",
    "obsidian://ccc-approval?id=",
  ),

  // The command-center view and the Agent runs count chip.
  commandCenterViewType: mirror(
    "commandCenterViewType",
    "view/command-center-view.ts",
    "claude-command-center-view",
  ),
  agentRunsTabSpoken: mirror(
    "agentRunsTabSpoken",
    "view/destination-tabs.tsx",
    "approval request needs your decision",
  ),
  overviewCommandSuffix: mirror("overviewCommandSuffix", "main.ts", "open-overview"),
  overviewLabel: mirror("overviewLabel", "view/destinations.ts", "Overview"),

  // Expiry and disabled reasons (approvals-copy.ts: EXPIRING, DISABLED_REASONS).
  expiring: mirror("expiring", COPY, "Expiring…"),
  reasonStale: mirror("reasonStale", COPY, "This list may be out of date. Refresh, then decide."),
  reasonExpired: mirror("reasonExpired", COPY, "This request has expired."),

  // The plugin's settings tab (view/settings-tab.ts): group headings, row names, rebuild status.
  approvalsGroupHeading: mirror("approvalsGroupHeading", SETTINGS, "Approvals"),
  tasksGroupHeading: mirror("tasksGroupHeading", SETTINGS, "Tasks"),
  notifyApprovalsName: mirror("notifyApprovalsName", SETTINGS, "Approval notifications"),
  notifyApprovalsKey: mirror("notifyApprovalsKey", SETTINGS, "notifyApprovals"),
  sendTestApprovalName: mirror("sendTestApprovalName", SETTINGS, "Send a test approval"),
  rebuildName: mirror("rebuildName", SETTINGS, "Rebuild task index"),
  rebuildStarted: mirror("rebuildStarted", SETTINGS, "Rebuilding the task index…"),
  rebuildDonePrefix: mirror("rebuildDonePrefix", SETTINGS, "Task index rebuilt."),
  needsService: mirror(
    "needsService",
    SETTINGS,
    "Needs the companion service, which isn't running.",
  ),

  // The Tasks destination and the tab labels (view/tasks-copy.ts, view/destinations.ts).
  serviceDisconnected: mirror("serviceDisconnected", TASKS_COPY, "Service disconnected"),
  tasksDisconnectedReason: mirror(
    "tasksDisconnectedReason",
    TASKS_COPY,
    "The companion service isn't running.",
  ),
  agentRunsLabel: mirror("agentRunsLabel", "view/destinations.ts", "Agent runs"),
  tasksLabel: mirror("tasksLabel", "view/destinations.ts", "Tasks"),
});

/**
 * The class names, data attributes and ids the renderer functions in approvals-support.ts read.
 * Those functions cannot reference outer variables, so their selectors are literals; registering
 * the tokens here makes the drift test prove each one still exists in the plugin's markup.
 */
const SELECTORS: ReadonlyArray<readonly [string, string]> = [
  ["ccc-approvals-status", "view/approvals-section.tsx"],
  ["ccc-filter-chip", "view/approvals-section.tsx"],
  ["ccc-approval-row-button", "view/approvals-section.tsx"],
  ["ccc-approval-row-meta", "view/approvals-section.tsx"],
  ["data-selected", "view/approvals-section.tsx"],
  ["ccc-approval-detail", "view/approval-detail.tsx"],
  ["ccc-approval-history", "view/approval-detail.tsx"],
  ["ccc-approval-time", "view/approval-detail.tsx"],
  ["ccc-approval-reason", "view/approval-detail.tsx"],
  ["ccc-approval-risks", "view/approval-detail.tsx"],
  ["ccc-approval-relocated", "view/approval-detail.tsx"],
  ["ccc-approval-explanation", "view/approval-detail.tsx"],
  ["data-block", "view/approval-detail.tsx"],
  ["data-caption", "view/approval-detail.tsx"],
  ["data-decision", "view/approval-decision.tsx"],
  ["ccc-list-meta", "view/approval-decision.tsx"],
  ["ccc-nav-count", "view/destination-tabs.tsx"],
  ["ccc-visually-hidden", "view/destination-tabs.tsx"],
  ["ccc-tab-", "view/destination-tabs.tsx"],
  ["agent-runs", "view/destinations.ts"],
];

for (const [token, source] of SELECTORS) mirror(`selector:${token}`, source, token);
