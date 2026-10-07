// Deep submodule imports, not the `@ccc/domain` barrel (R-EXPORTS rule 4): the
// barrel re-exports `path-containment.ts` (`node:fs`/`node:path`), which the
// visual harness's browser-platform bundle cannot resolve.
import type { ApprovalSummary, ApprovalsSnapshot } from "@ccc/domain/approval.js";
import { APPROVAL_STATE_DISPLAY, type ApprovalFilter } from "@ccc/domain/approval-view.js";
import { computed, signal } from "@preact/signals";

/**
 * The plugin's approval inbox, held in memory only (D-21, T-06-13).
 *
 * The inbox is a projection the service owns. It is hydrated from the
 * snapshot and kept current by `approval.upserted` events, and it is
 * persisted nowhere in the plugin: no settings key, no `data.json` member, no
 * browser storage. A reload starts empty and asks the service again, which is
 * what makes APPR-07 (a pending request survives a plugin reload) the
 * service's guarantee and not a second copy to keep consistent.
 *
 * Every mutation goes through {@link applyApprovalSummary} or
 * {@link adoptApprovalsSnapshot}; the parsing of an untrusted payload happens
 * in `events.ts` before either is called.
 */

export interface ApprovalCounts {
  readonly pending: number;
  readonly decided: number;
  readonly expired: number;
}

const ZERO_COUNTS: ApprovalCounts = { pending: 0, decided: 0, expired: 0 };

/** Every request the service has told this plugin about, keyed by proposal id. Never mutated in place. */
export const approvalsById = signal<ReadonlyMap<string, ApprovalSummary>>(new Map());

/** True bucket totals (not list lengths: a list may be truncated). */
export const approvalsCounts = signal<ApprovalCounts>(ZERO_COUNTS);

/**
 * Whether the service reports the engine ready. `null` until a snapshot with
 * an approvals member arrives; a later snapshot without one (an older
 * service) never clears a held value.
 */
export const approvalsReady = signal<boolean | null>(null);

/** Whether the service cut a list short to fit the response budget. */
export const approvalsTruncated = signal(false);

/** Whether a snapshot with an approvals member has ever been adopted. */
export const approvalsHydrated = signal(false);

/** The request the Approvals section shows in its detail pane, or `null`. Survives destination switches. */
export const selectedProposalId = signal<string | null>(null);

/**
 * Set by a navigation that selected a request (a notification, a link, a
 * button) and consumed once by the Approvals section: the only mount that
 * moves focus to the detail pane (UI-SPEC S2), mirroring the Phase 5
 * `detailFocusRequested` rule.
 */
export const approvalDetailFocusRequested = signal(false);

/**
 * How many requests need a decision, for the Agent runs tab chip (UI-SPEC
 * S6, E13). `null` until the first snapshot: an absent count is "unknown",
 * never "none" (D-15). A disconnect never rewrites it.
 */
export const pendingApprovalCount = computed<number | null>(() =>
  approvalsHydrated.value ? approvalsCounts.value.pending : null,
);

type UpsertHook = (summary: ApprovalSummary) => void;

/** The single module-level hook the notifier consumes (Pitfall 10). `null` means none. */
let upsertHook: UpsertHook | null = null;

/** Installs (or, with `null`, removes) the one hook. A second call replaces the first. */
export function setApprovalUpsertHook(hook: UpsertHook | null): void {
  upsertHook = hook;
}

function callHook(summary: ApprovalSummary): void {
  if (upsertHook === null) return;
  try {
    upsertHook(summary);
  } catch {
    // A notifier failure must never undo or block the state update.
  }
}

function bucketOf(summary: ApprovalSummary): ApprovalFilter {
  return APPROVAL_STATE_DISPLAY[summary.state].filter;
}

function withDelta(counts: ApprovalCounts, bucket: ApprovalFilter, delta: number): ApprovalCounts {
  return { ...counts, [bucket]: Math.max(0, counts[bucket] + delta) };
}

/**
 * Applies one validated summary (ADR-0007 revision monotonicity). A revision
 * not newer than the one held is ignored, so a decided request never
 * regresses to pending. Counts follow the bucket the request moves between.
 * Returns whether anything changed; the hook is called only when it did.
 */
export function applyApprovalSummary(summary: ApprovalSummary): boolean {
  const existing = approvalsById.value.get(summary.proposalId);
  if (existing !== undefined && summary.revision <= existing.revision) return false;
  const next = new Map(approvalsById.value);
  next.set(summary.proposalId, summary);
  approvalsById.value = next;

  const to = bucketOf(summary);
  if (existing === undefined) {
    // On a truncated inbox an unknown id past its first revision is an update of
    // an entry the snapshot omitted: the authoritative totals already count it.
    const omittedEarlier = approvalsTruncated.value && summary.revision > 1;
    if (!omittedEarlier) approvalsCounts.value = withDelta(approvalsCounts.value, to, 1);
  } else {
    const from = bucketOf(existing);
    if (from !== to) {
      approvalsCounts.value = withDelta(withDelta(approvalsCounts.value, from, -1), to, 1);
    }
  }
  callHook(summary);
  return true;
}

/**
 * Replaces the whole inbox from a validated full-resync snapshot. The hook is
 * called once for each summary that was not already known, so a request that
 * arrived while the stream was down still reaches the notifier.
 */
export function adoptApprovalsSnapshot(snapshot: ApprovalsSnapshot): void {
  const known = approvalsById.value;
  const next = new Map<string, ApprovalSummary>();
  for (const list of [snapshot.pending, snapshot.decided, snapshot.expired]) {
    for (const summary of list) next.set(summary.proposalId, summary);
  }
  approvalsById.value = next;
  approvalsCounts.value = { ...snapshot.counts };
  approvalsReady.value = snapshot.ready;
  approvalsTruncated.value = snapshot.truncated;
  approvalsHydrated.value = true;
  for (const summary of next.values()) {
    if (!known.has(summary.proposalId)) callHook(summary);
  }
}

/** Returns every approval signal to its initial value (tests, and a clean reload). The hook is left as set. */
export function resetApprovalsState(): void {
  approvalsById.value = new Map();
  approvalsCounts.value = ZERO_COUNTS;
  approvalsReady.value = null;
  approvalsTruncated.value = false;
  approvalsHydrated.value = false;
  selectedProposalId.value = null;
  approvalDetailFocusRequested.value = false;
}
