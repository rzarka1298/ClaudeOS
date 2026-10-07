import type { ApprovalSummary } from "@ccc/domain/approval.js";
import { APPROVAL_STATE_DISPLAY, type ApprovalFilter } from "@ccc/domain/approval-view.js";
import { CLASSIFICATION } from "@ccc/domain/classification.js";
import { signal } from "@preact/signals";
import { type ApprovalDetailResponse, approvalsApi } from "../approvals/api.js";
import type { ApprovalCounts } from "../approvals/signals.js";
import type { FooterModel } from "../widgets/presentation.js";
import { formatRelativeTime } from "../widgets/relative-time.js";
import { APPROVALS_SOURCE_LABEL, EXPIRING, expiryParts, FILTER_LABEL } from "./approvals-copy.js";

/**
 * The Approvals section's own view state (UI-SPEC S1), held in memory only.
 *
 * The pressed chip, how many rows each chip shows, the section's one polite
 * message and whether the section is on screen are view state: none of it is
 * persisted anywhere (a reload starts on Pending with nothing selected), and
 * none of it is the inbox itself, which lives in `approvals/signals.ts`.
 * Nothing here reads the clock; times arrive as arguments.
 */

/** The three chips, in their fixed order. */
export const APPROVAL_FILTERS: readonly ApprovalFilter[] = ["pending", "decided", "expired"];

/** The pressed chip. Pending until the owner presses another one. */
export const approvalChip = signal<ApprovalFilter>("pending");

/** Rows shown per page; `Show 25 more` adds another page. */
export const APPROVAL_PAGE_SIZE = 25;

/** How many rows each chip currently shows. */
export const approvalPages = signal<Readonly<Record<ApprovalFilter, number>>>({
  pending: APPROVAL_PAGE_SIZE,
  decided: APPROVAL_PAGE_SIZE,
  expired: APPROVAL_PAGE_SIZE,
});

/** The section's one polite message; a new message replaces the old one. */
export const approvalsStatus = signal("");

/**
 * Whether the Approvals section is on screen. The notifier reads this to
 * decide between a native notification, a Notice and silence; it is true
 * exactly while the section is mounted.
 */
export const approvalsSectionVisible = signal(false);

const PLURAL = new Intl.PluralRules("en");

/** `Pending (2)`; the bare label while the counts are unknown (an absent count is not zero). */
export function chipText(filter: ApprovalFilter, counts: ApprovalCounts | null): string {
  return counts === null ? FILTER_LABEL[filter] : `${FILTER_LABEL[filter]} (${counts[filter]})`;
}

/** `Pending, 2 requests`, `Expired, 1 request`; the bare label while the counts are unknown. */
export function chipName(filter: ApprovalFilter, counts: ApprovalCounts | null): string {
  if (counts === null) return FILTER_LABEL[filter];
  const count = counts[filter];
  const noun = PLURAL.select(count) === "one" ? "request" : "requests";
  return `${FILTER_LABEL[filter]}, ${count} ${noun}`;
}

function millis(iso: string | null): number {
  if (iso === null) return Number.NaN;
  return Date.parse(iso);
}

/** When a request was settled, for ordering: the decision, else the expiry. */
export function settledAt(summary: ApprovalSummary): string {
  return summary.decidedAt ?? summary.expiresAt;
}

/**
 * The requests of one chip in display order: Pending by soonest expiry,
 * Decided and Expired by the most recent decision first. Ties fall back to the
 * creation time and then the id, so the order is total and never flickers.
 */
export function orderedApprovals(
  byId: ReadonlyMap<string, ApprovalSummary>,
  filter: ApprovalFilter,
): readonly ApprovalSummary[] {
  const rows = [...byId.values()].filter(
    (summary) => APPROVAL_STATE_DISPLAY[summary.state].filter === filter,
  );
  const key = (summary: ApprovalSummary): number =>
    filter === "pending" ? millis(summary.expiresAt) : -millis(settledAt(summary));
  return rows.sort((a, b) => {
    const byKey = key(a) - key(b);
    if (byKey !== 0 && !Number.isNaN(byKey)) return byKey;
    const byCreated = millis(a.createdAt) - millis(b.createdAt);
    if (byCreated !== 0 && !Number.isNaN(byCreated)) return byCreated;
    return a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0;
  });
}

/** Posts a message to the section's polite status line. */
export function announceApproval(text: string): void {
  approvalsStatus.value = text;
}

/** Shows one more page of a chip's list. */
export function showMoreApprovals(filter: ApprovalFilter): void {
  const pages = approvalPages.value;
  approvalPages.value = { ...pages, [filter]: pages[filter] + APPROVAL_PAGE_SIZE };
}

// ---------------------------------------------------------------------------
// Time phrases, expiry, arrival and the provenance strip

export interface TimePhrase {
  readonly text: string;
  /** Under five minutes (or expiring): the phrase carries weight 600. */
  readonly urgent: boolean;
}

/**
 * The time phrase a row ends with (UI-SPEC S1 "List"): a Pending request counts
 * down (`Expires in 14 min`) under 24 hours and reads an absolute time beyond,
 * then `Expiring…` at zero; a Decided one says what happened and when; an
 * Expired one says when it ran out. `nowMs` is the prop clock, never the ambient one.
 */
export function approvalTimePhrase(summary: ApprovalSummary, nowMs: number): TimePhrase {
  if (summary.state === "pending") {
    const parts = expiryParts(nowMs, summary.expiresAt);
    return parts.kind === "expiring"
      ? { text: EXPIRING, urgent: true }
      : { text: parts.phrase, urgent: parts.urgent };
  }
  const display = APPROVAL_STATE_DISPLAY[summary.state];
  if (display.filter === "expired") {
    return { text: `Expired ${formatRelativeTime(settledAt(summary), nowMs)}`, urgent: false };
  }
  return {
    text:
      summary.decidedAt === null
        ? display.label
        : `${display.label} ${formatRelativeTime(summary.decidedAt, nowMs)}`,
    urgent: false,
  };
}

/** The pending requests whose expiry is at or before `nowMs`, in the map's order. */
export function expiredPendingIds(
  byId: ReadonlyMap<string, ApprovalSummary>,
  nowMs: number,
): readonly string[] {
  const due: string[] = [];
  for (const summary of byId.values()) {
    if (summary.state === "pending" && Date.parse(summary.expiresAt) <= nowMs) {
      due.push(summary.proposalId);
    }
  }
  return due;
}

/** The ids of every pending request. */
export function pendingIdSet(byId: ReadonlyMap<string, ApprovalSummary>): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const summary of byId.values()) {
    if (summary.state === "pending") ids.add(summary.proposalId);
  }
  return ids;
}

/** Whether `current` holds a pending id that `previous` did not: the one arrival worth announcing. */
export function hasArrival(previous: ReadonlySet<string>, current: ReadonlySet<string>): boolean {
  for (const id of current) {
    if (!previous.has(id)) return true;
  }
  return false;
}

const FORCE_TERMINATE_SUMMARY = CLASSIFICATION["session.force-terminate"].summary;

/** The label the service gives a force-terminate request: the table's summary, capitalised. */
const FORCE_TERMINATE_LABEL = `${FORCE_TERMINATE_SUMMARY.charAt(0).toUpperCase()}${FORCE_TERMINATE_SUMMARY.slice(1)}`;

/**
 * The pending force-terminate request for a Run, if there is one: what lets the
 * Run's disabled Force-terminate control point at it instead of inviting a
 * second request. `null` when there is none.
 */
export function pendingTerminateRequestFor(
  byId: ReadonlyMap<string, ApprovalSummary>,
  runId: string,
): string | null {
  for (const summary of byId.values()) {
    if (
      summary.state === "pending" &&
      summary.runId === runId &&
      summary.operationLabel === FORCE_TERMINATE_LABEL
    ) {
      return summary.proposalId;
    }
  }
  return null;
}

/**
 * Set when the list may have missed a change: the stream dropped, or a refresh
 * failed. Cleared when a snapshot or an event arrives while the stream is live.
 * View state in memory, like everything here.
 */
export const approvalsMissedSync = signal(false);

/** Set when the first load failed, so the section shows its error state. */
export const approvalsLoadFailed = signal(false);

/** When this view last saw the list change, as an ISO time, or `null`. */
export const approvalsObservedAt = signal<string | null>(null);

export interface FooterInput {
  readonly hydrated: boolean;
  readonly ready: boolean | null;
  readonly disconnected: boolean;
  readonly missedSync: boolean;
  /** ISO time of the last list change this view saw, or null. */
  readonly observedAt: string | null;
}

const SOURCE_LABEL = APPROVALS_SOURCE_LABEL;

/**
 * The provenance strip's model (UI-SPEC S1): one source, `Approval inbox`.
 * Live while the stream is healthy and nothing was missed, stale after a missed
 * sync, unavailable when the engine is not ready and, with the last observation
 * kept, while the service is away.
 */
export function approvalsFooterModel(input: FooterInput): FooterModel {
  if (input.hydrated && input.ready === false) {
    return {
      observedAt: null,
      freshness: "unavailable",
      partiality: null,
      sources: [{ label: SOURCE_LABEL, status: "no-source" }],
    };
  }
  if (input.disconnected) {
    return {
      observedAt: input.observedAt,
      freshness: "unavailable",
      partiality: null,
      sources: [{ label: SOURCE_LABEL, status: "disconnected" }],
    };
  }
  return {
    observedAt: input.observedAt,
    freshness: input.missedSync ? "stale" : "live",
    partiality: null,
    sources: [{ label: SOURCE_LABEL, status: "ok" }],
  };
}

// ---------------------------------------------------------------------------
// The detail cache

/** What the cache knows of one request. */
export type DetailForm =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly detail: ApprovalDetailResponse }
  | { readonly kind: "error" };

export interface DetailCache {
  /**
   * Asks for one request. Calls made while an answer is still on its way share
   * it; a later call always asks again, because a decision and a hash must
   * never rest on an answer kept from before.
   */
  get(proposalId: string): Promise<ApprovalDetailResponse>;
  /** What the cache holds for a request now, or `undefined` for one never asked about. */
  peek(proposalId: string): DetailForm | undefined;
  clear(): void;
}

/** Forms kept per load; the oldest is dropped past this many. */
const FORM_CAP = 50;

export function createDetailCache(
  load: (proposalId: string) => Promise<ApprovalDetailResponse>,
): DetailCache {
  const inFlight = new Map<string, Promise<ApprovalDetailResponse>>();
  const forms = new Map<string, DetailForm>();

  function keepForm(proposalId: string, form: DetailForm): void {
    forms.delete(proposalId);
    forms.set(proposalId, form);
    while (forms.size > FORM_CAP) {
      const oldest = forms.keys().next();
      if (oldest.done === true) break;
      forms.delete(oldest.value);
    }
  }

  return {
    get(proposalId) {
      const shared = inFlight.get(proposalId);
      if (shared !== undefined) return shared;
      keepForm(proposalId, { kind: "loading" });
      const request = Promise.resolve()
        .then(() => load(proposalId))
        .then(
          (detail) => {
            keepForm(proposalId, { kind: "loaded", detail });
            return detail;
          },
          (error: unknown) => {
            keepForm(proposalId, { kind: "error" });
            throw error;
          },
        )
        .finally(() => {
          if (inFlight.get(proposalId) === request) inFlight.delete(proposalId);
        });
      inFlight.set(proposalId, request);
      return request;
    },
    peek: (proposalId) => forms.get(proposalId),
    clear() {
      inFlight.clear();
      forms.clear();
    },
  };
}

/** The section's cache, reading whichever API is configured at the moment of each call. */
export const approvalDetailCache: DetailCache = createDetailCache((proposalId) =>
  approvalsApi().get(proposalId),
);

/** Returns every piece of section view state to its start (a clean reload; tests). */
export function resetApprovalsView(): void {
  approvalChip.value = "pending";
  approvalPages.value = {
    pending: APPROVAL_PAGE_SIZE,
    decided: APPROVAL_PAGE_SIZE,
    expired: APPROVAL_PAGE_SIZE,
  };
  approvalsStatus.value = "";
  approvalsSectionVisible.value = false;
  approvalsMissedSync.value = false;
  approvalsLoadFailed.value = false;
  approvalsObservedAt.value = null;
  approvalDetailCache.clear();
}
