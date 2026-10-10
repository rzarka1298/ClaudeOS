import type { ServiceEvent, SnapshotResponse } from "@ccc/domain";
import { ApprovalsSnapshotSchema, ApprovalUpsertedPayloadSchema } from "@ccc/domain/approval.js";
import { adoptApprovalsSnapshot, applyApprovalSummary } from "./signals.js";

/**
 * The one place `approval.upserted` events and the snapshot's approvals member
 * land (APPR-07, D-28). Every payload is parsed with the domain schema before
 * it is trusted; one that fails is dropped and the last good value stands
 * (Pitfall 17, T-05-23).
 */

/** Applies an `approval.upserted` event. Anything else, or a malformed payload, is ignored. */
export function applyApprovalServiceEvent(event: ServiceEvent): void {
  if (event.type !== "approval.upserted") return;
  const parsed = ApprovalUpsertedPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return;
  applyApprovalSummary(parsed.data.approval);
}

/**
 * Adopts a full-resync snapshot's approvals member. The member is optional so
 * an older service's snapshot still parses (Pitfall 17): an absent member
 * leaves every approval signal exactly as it was, never cleared. A member
 * that fails its schema is treated the same way.
 */
export function adoptApprovalsFromSnapshot(snapshot: SnapshotResponse): void {
  const member: unknown = snapshot.state.approvals;
  if (member === undefined) return;
  const parsed = ApprovalsSnapshotSchema.safeParse(member);
  if (!parsed.success) return;
  adoptApprovalsSnapshot(parsed.data);
}
