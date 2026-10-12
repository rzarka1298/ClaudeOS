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
});
