import type { ApprovalSummary } from "@ccc/domain/approval.js";
import { APPROVAL_STATE_DISPLAY, type ApprovalFilter } from "@ccc/domain/approval-view.js";
import { signal } from "@preact/signals";
import { type ApprovalDetailResponse, approvalsApi } from "../approvals/api.js";
import type { ApprovalCounts } from "../approvals/signals.js";
import type { FooterModel } from "../widgets/presentation.js";
import { FILTER_LABEL } from "./approvals-copy.js";

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
// Time phrases, expiry, arrival and the provenance strip (RED skeleton)

export interface TimePhrase {
  readonly text: string;
  /** Under five minutes (or expiring): the phrase carries weight 600. */
  readonly urgent: boolean;
}

export function approvalTimePhrase(_summary: ApprovalSummary, _nowMs: number): TimePhrase {
  return { text: "", urgent: false };
}

export function expiredPendingIds(
  _byId: ReadonlyMap<string, ApprovalSummary>,
  _nowMs: number,
): readonly string[] {
  return [];
}

export function pendingIdSet(_byId: ReadonlyMap<string, ApprovalSummary>): ReadonlySet<string> {
  return new Set();
}

export function hasArrival(_previous: ReadonlySet<string>, _current: ReadonlySet<string>): boolean {
  return false;
}

/** Set when the list may have missed a change; cleared when a snapshot or event arrives while live. */
export const approvalsMissedSync = signal(false);

/** Set when the first load failed, so the section shows its error state. */
export const approvalsLoadFailed = signal(false);

export interface FooterInput {
  readonly hydrated: boolean;
  readonly ready: boolean | null;
  readonly disconnected: boolean;
  readonly missedSync: boolean;
  /** ISO time of the last list change this view saw, or null. */
  readonly observedAt: string | null;
}

export function approvalsFooterModel(_input: FooterInput): FooterModel {
  return { observedAt: null, freshness: null, partiality: null, sources: [] };
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
   * never rest on a remembered answer.
   */
  get(proposalId: string): Promise<ApprovalDetailResponse>;
  /** What the cache holds for a request now, or `undefined` for one never asked about. */
  peek(proposalId: string): DetailForm | undefined;
  clear(): void;
}

/** Remembered forms per load; the oldest is forgotten past this many. */
const FORM_CAP = 50;

export function createDetailCache(
  load: (proposalId: string) => Promise<ApprovalDetailResponse>,
): DetailCache {
  const inFlight = new Map<string, Promise<ApprovalDetailResponse>>();
  const forms = new Map<string, DetailForm>();

  function remember(proposalId: string, form: DetailForm): void {
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
      remember(proposalId, { kind: "loading" });
      const request = Promise.resolve()
        .then(() => load(proposalId))
        .then(
          (detail) => {
            remember(proposalId, { kind: "loaded", detail });
            return detail;
          },
          (error: unknown) => {
            remember(proposalId, { kind: "error" });
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
  approvalDetailCache.clear();
}
