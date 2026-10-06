import type { ApprovalSummary } from "@ccc/domain/approval.js";
import type { ApprovalFilter } from "@ccc/domain/approval-view.js";
import { signal } from "@preact/signals";
import type { ApprovalDetailResponse } from "../approvals/api.js";
import type { ApprovalCounts } from "../approvals/signals.js";

/** Skeleton (RED): the real module lands in the GREEN commit. */

export const APPROVAL_FILTERS: readonly ApprovalFilter[] = ["pending", "decided", "expired"];
export const approvalChip = signal<ApprovalFilter>("pending");
export const APPROVAL_PAGE_SIZE = 25;
export const approvalsStatus = signal("");
export const approvalsSectionVisible = signal(false);

export function chipText(_filter: ApprovalFilter, _counts: ApprovalCounts | null): string {
  return "";
}

export function chipName(_filter: ApprovalFilter, _counts: ApprovalCounts | null): string {
  return "";
}

export function orderedApprovals(
  _byId: ReadonlyMap<string, ApprovalSummary>,
  _filter: ApprovalFilter,
): readonly ApprovalSummary[] {
  return [];
}

export function announceApproval(_text: string): void {}

export interface DetailCache {
  get(proposalId: string): Promise<ApprovalDetailResponse>;
  clear(): void;
}

export function createDetailCache(
  _fetch: (proposalId: string) => Promise<ApprovalDetailResponse>,
): DetailCache {
  return { get: () => Promise.reject(new Error("skeleton")), clear: () => {} };
}

export function resetApprovalsView(): void {}
