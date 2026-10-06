import type { ApprovalAuditEvent, ProposalState, RequesterKind } from "@ccc/domain/approval.js";
import type { ApprovalFilter } from "@ccc/domain/approval-view.js";
import { formatDuration } from "../widgets/duration.js";
import { formatMonthDay, formatTimeOfDay } from "../widgets/usage-format.js";

/**
 * Every locked string, vocabulary and message builder for the approval
 * surfaces (UI-SPEC "Copywriting Contract", S2). One module, so the wording
 * lives in one reviewable place and the source scan has one file to read for
 * it. Sentence case throughout; counts through `Intl`.
 *
 * Nothing here knows about a payload, a path or an error message: a string
 * that names requester-supplied text takes it as an argument and the caller
 * renders it as a text node.
 */

// ---------------------------------------------------------------------------
// Locked labels

export const APPROVALS_HEADING = "Approvals";
export const DECISION_GROUP_LABEL = "Decision";
export const DENY_LABEL = "Deny";
export const APPROVE_LABEL = "Approve once";
export const OPEN_RUN_LABEL = "Open originating run";
export const SELECT_PROMPT = "Select a request to review it and decide.";

/** The accessible names are clamped so a long title cannot swamp a screen reader. */
const NAME_CLAMP = 120;

function clamp(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

export function denyName(title: string): string {
  return `${DENY_LABEL}: ${clamp(title, NAME_CLAMP)}`;
}

/** `effect` is the engine-templated effect, or the title for a request with none. */
export function approveName(effect: string): string {
  return `${APPROVE_LABEL}: ${clamp(effect, NAME_CLAMP)}`;
}

export function openRunName(runName: string): string {
  return `${OPEN_RUN_LABEL}: ${clamp(runName, NAME_CLAMP)}`;
}

/** The visible sub-label under Approve once for a destructive request. */
export function destructiveSublabel(effect: string): string {
  return `This will ${effect}.`;
}

// ---------------------------------------------------------------------------
// Provenance

export const COMPUTED_CAPTION = "Computed by the command center";

/** The kind is closed and engine-assigned; only the label is requester text. */
export const REQUESTER_KIND_LABEL: Readonly<Record<RequesterKind, string>> = {
  dashboard: "Dashboard",
  skill: "Skill",
  automation: "Automation",
  connector: "Connector",
};

export function providedByCaption(kind: RequesterKind, label: string): string {
  return `Provided by ${REQUESTER_KIND_LABEL[kind]}: ${label}`;
}

/** `Requested by` reads the kind then the label; an empty label reads as the kind alone. */
export function requestedByText(kind: RequesterKind, label: string): string {
  return label === "" ? REQUESTER_KIND_LABEL[kind] : `${REQUESTER_KIND_LABEL[kind]}: ${label}`;
}

// ---------------------------------------------------------------------------
// Block headings and terms

export const BLOCK_HEADING = {
  who: "Who and where",
  happen: "What will happen",
  target: "Target",
  change: "What will change",
  reason: "Reason",
  risks: "Risks",
  record: "Record",
  history: "History",
} as const;

export const TERM = {
  requestedBy: "Requested by",
  project: "Project",
  run: "Run",
  requested: "Requested",
  requestId: "Request ID",
  fingerprint: "Content fingerprint",
  decidedThrough: "Decided through",
} as const;

export const NOT_PROVIDED = "Not provided";
export const NO_PROJECT = "No project";
export const NOT_IN_A_RUN = "Not part of a run";
export const NO_RISKS = "None listed.";

/** The Decided through vocabulary (D-47): anything but the plugin reads as another client. */
export const DECIDED_THROUGH = {
  plugin: "The command center",
  other: "Another local client",
} as const;

// ---------------------------------------------------------------------------
// The change block

export const TOO_LARGE = "This change is too large to review here.";
export const NO_CHANGE = "No change. Approving this does nothing.";
export const TEXT_SHORTENED = "Text shortened for display.";
export const SHOW_FULL_TEXT = "Show full text";
export const SHOW_SHORTER_TEXT = "Show shorter text";
export const SHOW_FEWER_LINES = "Show fewer lines";
export const CHANGES_LABEL = "Changes";
export const ADDED_MARKER = "+ Added";
export const REMOVED_MARKER = "− Removed";
export const UNCHANGED_PREFIX = "Unchanged";
/** The hidden prefix a screen reader hears before a visible `[U+XXXX]` token. */
export const CONTROL_CHARACTER = "control character";

const COUNT = new Intl.NumberFormat("en");
const PLURAL = new Intl.PluralRules("en");

export function showAllLines(total: number): string {
  return `Show all ${COUNT.format(total)} lines`;
}

export function unchangedLines(count: number): string {
  const noun = PLURAL.select(count) === "one" ? "line" : "lines";
  return `… ${COUNT.format(count)} unchanged ${noun}`;
}

// ---------------------------------------------------------------------------
// Disabled reasons, status lines and Notices

export const DISABLED_REASONS = {
  disconnected: "The companion service isn't running.",
  loading: "Loading the full request…",
  stale: "This list may be out of date. Refresh, then decide.",
  expired: "This request has expired.",
  tooLarge: "This change is too large to review here, so it can't be approved from here.",
  noRun: "This request didn't come from a run.",
  runNotLoaded: "That run isn't in the loaded history.",
} as const;

export const APPROVAL_STATUS = {
  sending: "Sending your decision…",
  approved: "Approved. Carrying out the action…",
  denied: "Denied. Nothing was changed.",
  hashMismatch:
    "This request changed after you opened it. Review the updated details before deciding.",
  expiredDuringDecide: "This request expired and was denied automatically. Nothing was changed.",
  alreadyDecided: "This request was already decided.",
  notFound: "That request isn't in the inbox.",
  transport:
    "Couldn't send your decision: the companion service didn't respond within 5 seconds. Checking whether it went through…",
  notThrough: "It did not go through. You can decide again.",
  confirmFailed:
    "Couldn't confirm whether your decision went through. Refresh the list before deciding again.",
  /** A request whose operation is not enabled yet; the service refuses it before anything changes. */
  reserved: "This kind of request can't be decided yet. Nothing was changed.",
  loadFailed: "Couldn't load this request.",
} as const;

export function approvedNotice(title: string): string {
  return `Approved: ${title}.`;
}

export function deniedNotice(title: string): string {
  return `Denied: ${title}.`;
}

// ---------------------------------------------------------------------------
// The detail pane's own states

export const DETAILS_CHANGED = "The details changed since you first opened this request.";
export const NOT_FOUND_HEADING = APPROVAL_STATUS.notFound;
export const NOT_FOUND_BODY =
  "It may have been cleared. Pending and recent requests are listed here.";
export const LOAD_ERROR_HEADING = APPROVAL_STATUS.loadFailed;
export const LOAD_ERROR_BODY = "Check the service in Settings → Diagnostics, then refresh.";
export const PURGED_BODY = "The details of this request are no longer kept. Its audit record is.";
export const LOADING_LABEL = "Loading approval request";
export const AWAITING_EXIT_SENTENCE = "Carried out. The session is still shutting down.";

export const FILTER_LABEL: Readonly<Record<ApprovalFilter, string>> = {
  pending: "Pending",
  decided: "Decided",
  expired: "Expired",
};

export function listedUnder(filter: ApprovalFilter): string {
  return `This request is listed under ${FILTER_LABEL[filter]}.`;
}

export function showFilter(filter: ApprovalFilter): string {
  return `Show ${FILTER_LABEL[filter]}`;
}

// ---------------------------------------------------------------------------
// History vocabulary (APPR-08): the only words the audit list may use

export const HISTORY_LABEL: Readonly<Record<ApprovalAuditEvent, string>> = {
  requested: "Requested",
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  withdrawn: "Withdrawn",
  claimed: "Started carrying out",
  executed: "Carried out",
  failed: "Failed",
  "outcome-unknown": "Outcome unknown",
  "retried-after-restart": "Retried after a restart",
  "reconciled-executed": "Carried out",
  lapsed: "Lapsed",
};

// ---------------------------------------------------------------------------
// Failed reasons (fixed vocabulary, never a path or an error message)

export const FAILED_REASON_LABELS = [
  "the session's process had already ended",
  "that session is no longer listed",
  "the process no longer matches the one you approved",
  "the command center couldn't run it",
] as const;

export const DIAGNOSTICS_HINT = "Check the service in Settings → Diagnostics.";

export interface FailedReason {
  readonly text: string;
  /** True for the last, catch-all phrase, which points at the diagnostics. */
  readonly diagnostics: boolean;
}

const [REASON_ENDED, REASON_UNLISTED, REASON_MISMATCH, REASON_OTHER] = FAILED_REASON_LABELS;

/**
 * Chooses one of the four fixed phrases from the outcome code. Only the three
 * codes a refused execution reports have their own phrase; every other code,
 * and an absent one, is the catch-all so a code never leaks into the text.
 */
export function failedReason(code: string | null): FailedReason {
  switch (code) {
    case "process-ended":
      return { text: REASON_ENDED, diagnostics: false };
    case "run-not-found":
      return { text: REASON_UNLISTED, diagnostics: false };
    case "identity-mismatch":
      return { text: REASON_MISMATCH, diagnostics: false };
    default:
      return { text: REASON_OTHER, diagnostics: true };
  }
}

// ---------------------------------------------------------------------------
// Times

/** `{Mon D}, {h:mm AM}`, with the year outside the current one. Never a slash-separated date. */
export function formatApprovalTime(iso: string, nowMs: number): string {
  return `${formatMonthDay(iso, nowMs)}, ${formatTimeOfDay(iso)}`;
}

const DAY_MS = 86_400_000;
const URGENT_MS = 300_000;
const DENIED_AUTOMATICALLY = "If you don't decide, it's denied automatically.";

export type ExpiryParts =
  | { readonly kind: "expiring" }
  | {
      readonly kind: "counting";
      /** The countdown phrase, e.g. `Expires in 14 min`. Weight 600 when urgent. */
      readonly phrase: string;
      /** What follows the phrase on the same line. */
      readonly suffix: string;
      /** Under five minutes left. */
      readonly urgent: boolean;
    };

/** The pending countdown, split so the phrase can carry its own emphasis. */
export function expiryParts(nowMs: number, expiresAt: string): ExpiryParts {
  const remaining = Date.parse(expiresAt) - nowMs;
  if (remaining <= 0) return { kind: "expiring" };
  const absolute = formatApprovalTime(expiresAt, nowMs);
  if (remaining < DAY_MS) {
    return {
      kind: "counting",
      phrase: `Expires in ${formatDuration(remaining)}`,
      suffix: ` (${absolute}). ${DENIED_AUTOMATICALLY}`,
      urgent: remaining < URGENT_MS,
    };
  }
  return {
    kind: "counting",
    phrase: `Expires ${absolute}`,
    suffix: `. ${DENIED_AUTOMATICALLY}`,
    urgent: false,
  };
}

export const EXPIRING = "Expiring…";

/** The hidden summary a screen reader hears when focus lands on Deny. */
export function denySummary(title: string, nowMs: number, expiresAt: string): string {
  const parts = expiryParts(nowMs, expiresAt);
  return parts.kind === "expiring" ? `${title}. ${EXPIRING}` : `${title}. ${parts.phrase}.`;
}

// ---------------------------------------------------------------------------
// State explanations

export interface ExplanationInput {
  readonly state: ProposalState;
  readonly nowMs: number;
  readonly expiresAt: string;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  /** When the action finished, from the audit history, or null. */
  readonly executedAt: string | null;
  readonly outcomeCode: string | null;
  /** The operation's fixed `What to check` line, or null. */
  readonly checkHint: string | null;
  /** True for a carried-out request whose process had not exited yet (`awaiting-exit`). */
  readonly awaitingExit: boolean;
}

/**
 * The explanation lines under a state (UI-SPEC "State rendering"), as separate
 * paragraphs. A retry refusal is never turned into a failure here: the reason
 * phrase is built only for the `failed` state.
 */
export function stateExplanation(input: ExplanationInput): readonly string[] {
  const at = (iso: string | null): string | null =>
    iso === null ? null : formatApprovalTime(iso, input.nowMs);
  const approved = at(input.decidedAt);
  const approvedPhrase = approved === null ? "Approved" : `Approved ${approved}`;

  switch (input.state) {
    case "pending": {
      const parts = expiryParts(input.nowMs, input.expiresAt);
      return [parts.kind === "expiring" ? EXPIRING : `${parts.phrase}${parts.suffix}`];
    }
    case "approved":
      return [`${approvedPhrase}. Waiting to start.`];
    case "executing":
      return [`${approvedPhrase}. The action is being carried out. This updates when it finishes.`];
    case "executed": {
      const carried = at(input.executedAt);
      const main =
        carried === null
          ? `${approvedPhrase} and carried out.`
          : `${approvedPhrase} and carried out ${carried}.`;
      return input.awaitingExit ? [main, AWAITING_EXIT_SENTENCE] : [main];
    }
    case "failed": {
      const reason = failedReason(input.outcomeCode);
      const first = `${approvedPhrase}, but it failed: ${reason.text}.${
        reason.diagnostics ? ` ${DIAGNOSTICS_HINT}` : ""
      }`;
      return input.checkHint === null ? [first] : [first, input.checkHint];
    }
    case "unknown": {
      const hint = input.checkHint === null ? "" : ` ${input.checkHint}`;
      return [
        `The app stopped while this was being carried out, so the result couldn't be confirmed.${hint} Nothing is retried automatically. Ask for a new request if you still need it.`,
      ];
    }
    case "denied":
      return [
        approved === null
          ? "You denied this request. Nothing was changed."
          : `You denied this request ${approved}. Nothing was changed.`,
      ];
    case "withdrawn":
      return ["The requester withdrew this request. Nothing was changed."];
    case "lapsed":
      return [
        "This was approved but not carried out in time, so it was dropped. Nothing was changed. Ask for a new request if you still need it.",
      ];
    case "expired":
      return [
        `No decision arrived before ${formatApprovalTime(input.expiresAt, input.nowMs)}, so it was denied automatically. Nothing was changed. The requester can raise a new request against the current state.`,
      ];
  }
}

// ---------------------------------------------------------------------------
// What a request that is no longer pending looks like as an outcome line

export interface SettledStatus {
  readonly status: string;
  /** The Obsidian Notice, or null when the line alone is enough. */
  readonly notice: string | null;
}

/**
 * The status line and Notice for a request found in `state` after a decision
 * whose response was lost, or for a request that finished while the pane was
 * open. A pending request means the decision did not go through.
 */
export function settledStatus(
  state: ProposalState,
  title: string,
  outcomeCode: string | null,
): SettledStatus {
  switch (state) {
    case "pending":
      return { status: APPROVAL_STATUS.notThrough, notice: null };
    case "denied":
      return { status: APPROVAL_STATUS.denied, notice: deniedNotice(title) };
    case "approved":
    case "executing":
      return { status: APPROVAL_STATUS.approved, notice: approvedNotice(title) };
    case "executed":
      return { status: "Carried out.", notice: `${title}: Carried out.` };
    case "failed": {
      const sentence = `Couldn't carry it out: ${failedReason(outcomeCode).text}.`;
      return { status: sentence, notice: `${title}: ${sentence}` };
    }
    case "unknown": {
      const sentence = "The outcome couldn't be confirmed.";
      return { status: sentence, notice: `${title}: ${sentence}` };
    }
    case "expired":
      return {
        status: APPROVAL_STATUS.expiredDuringDecide,
        notice: APPROVAL_STATUS.expiredDuringDecide,
      };
    case "withdrawn":
    case "lapsed":
      return {
        status: APPROVAL_STATUS.alreadyDecided,
        notice: APPROVAL_STATUS.alreadyDecided,
      };
  }
}
