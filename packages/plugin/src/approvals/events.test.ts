import type { ServiceEvent, SnapshotResponse } from "@ccc/domain";
import { EMPTY_PROJECTS_SNAPSHOT } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionState } from "../connection-state.js";
import { approvalsSnapshot, summary } from "../test-support/approval-fixtures.js";
import { adoptApprovalsFromSnapshot, applyApprovalServiceEvent } from "./events.js";
import {
  approvalsById,
  approvalsCounts,
  approvalsReady,
  approvalsTruncated,
  pendingApprovalCount,
  resetApprovalsState,
  setApprovalUpsertHook,
} from "./signals.js";

/**
 * Plan 06-10, Task 1 (tracer): a snapshot and an `approval.upserted` event
 * flow into the signals, the counts and the notifier hook. Payloads are
 * parsed before they are trusted; a failure leaves the last good value
 * standing (Pitfall 17, T-05-23 precedent).
 */

function snapshotWith(approvals: unknown): SnapshotResponse {
  const state: Record<string, unknown> = {
    serviceStartedAt: "2026-10-06T10:00:00.000Z",
    projects: EMPTY_PROJECTS_SNAPSHOT,
  };
  if (approvals !== undefined) state.approvals = approvals;
  return { lastEventId: 1, state } as unknown as SnapshotResponse;
}

function upserted(approval: unknown, id = 10): ServiceEvent {
  return {
    id,
    type: "approval.upserted",
    occurredAt: "2026-10-06T10:00:00.000Z",
    payload: { approval },
  };
}

beforeEach(resetApprovalsState);
afterEach(() => {
  resetApprovalsState();
  setApprovalUpsertHook(null);
  connectionState.value = { kind: "connecting" };
});

describe("adopting a snapshot (Test 1)", () => {
  it("fills the map, the true counts, the ready flag and the truncated flag", () => {
    adoptApprovalsFromSnapshot(
      snapshotWith(
        approvalsSnapshot({
          pending: [summary(1), summary(2)],
          decided: [summary(3, "executed", 2)],
          expired: [summary(4, "expired", 2)],
          truncated: true,
          counts: { pending: 2, decided: 9, expired: 5 },
        }),
      ),
    );
    expect(approvalsById.value.size).toBe(4);
    expect(approvalsCounts.value).toEqual({ pending: 2, decided: 9, expired: 5 });
    expect(approvalsReady.value).toBe(true);
    expect(approvalsTruncated.value).toBe(true);
  });

  it("leaves everything untouched, never cleared, when the snapshot has no approvals member", () => {
    adoptApprovalsFromSnapshot(snapshotWith(approvalsSnapshot({ pending: [summary(1)] })));
    adoptApprovalsFromSnapshot(snapshotWith(undefined));
    expect(approvalsById.value.size).toBe(1);
    expect(approvalsCounts.value.pending).toBe(1);
    expect(approvalsReady.value).toBe(true);
  });

  it("keeps the previous values when the member is malformed", () => {
    adoptApprovalsFromSnapshot(snapshotWith(approvalsSnapshot({ pending: [summary(1)] })));
    adoptApprovalsFromSnapshot(snapshotWith({ ready: "yes", pending: "no" }));
    adoptApprovalsFromSnapshot(
      snapshotWith({ ...approvalsSnapshot({ pending: [summary(2)] }), counts: { pending: -1 } }),
    );
    expect(approvalsById.value.size).toBe(1);
    expect(approvalsCounts.value.pending).toBe(1);
  });
});

describe("the ready flag (Test 2)", () => {
  it("is null before any snapshot, true when ready, false when present but not ready", () => {
    expect(approvalsReady.value).toBeNull();
    adoptApprovalsFromSnapshot(snapshotWith(approvalsSnapshot({ ready: true })));
    expect(approvalsReady.value).toBe(true);
    adoptApprovalsFromSnapshot(snapshotWith(approvalsSnapshot({ ready: false })));
    expect(approvalsReady.value).toBe(false);
  });

  it("an older service's snapshot with no member never un-readies a held value", () => {
    adoptApprovalsFromSnapshot(snapshotWith(approvalsSnapshot({ ready: true })));
    adoptApprovalsFromSnapshot(snapshotWith(undefined));
    expect(approvalsReady.value).toBe(true);
  });
});

describe("applying an approval.upserted event (Test 3)", () => {
  it("replaces the entry when the revision is higher", () => {
    applyApprovalServiceEvent(upserted(summary(1, "pending", 1)));
    applyApprovalServiceEvent(upserted(summary(1, "executed", 3)));
    expect(approvalsById.value.get(summary(1).proposalId)?.state).toBe("executed");
  });

  it("ignores an equal or lower revision, so a decided request never regresses to pending", () => {
    applyApprovalServiceEvent(upserted(summary(1, "executed", 3)));
    applyApprovalServiceEvent(upserted(summary(1, "pending", 3)));
    applyApprovalServiceEvent(upserted(summary(1, "pending", 1)));
    expect(approvalsById.value.get(summary(1).proposalId)?.state).toBe("executed");
  });

  it("ignores a malformed payload, an unknown key and an event of another type", () => {
    applyApprovalServiceEvent(upserted({ proposalId: "nope" }));
    applyApprovalServiceEvent({
      id: 11,
      type: "approval.upserted",
      occurredAt: "2026-10-06T10:00:00.000Z",
      payload: { approval: summary(1), extra: true },
    });
    applyApprovalServiceEvent({
      id: 12,
      type: "service.heartbeat",
      occurredAt: "2026-10-06T10:00:00.000Z",
      payload: {},
    });
    expect(approvalsById.value.size).toBe(0);
  });
});

describe("bucket counting (Test 4)", () => {
  it("a new pending request adds one to pending", () => {
    adoptApprovalsFromSnapshot(snapshotWith(approvalsSnapshot()));
    applyApprovalServiceEvent(upserted(summary(1)));
    expect(approvalsCounts.value).toEqual({ pending: 1, decided: 0, expired: 0 });
  });

  it("pending becoming executed moves one from pending to decided", () => {
    adoptApprovalsFromSnapshot(snapshotWith(approvalsSnapshot({ pending: [summary(1)] })));
    applyApprovalServiceEvent(upserted(summary(1, "executed", 2)));
    expect(approvalsCounts.value).toEqual({ pending: 0, decided: 1, expired: 0 });
  });

  it("pending becoming expired moves one from pending to expired", () => {
    adoptApprovalsFromSnapshot(snapshotWith(approvalsSnapshot({ pending: [summary(1)] })));
    applyApprovalServiceEvent(upserted(summary(1, "expired", 2)));
    expect(approvalsCounts.value).toEqual({ pending: 0, decided: 0, expired: 1 });
  });

  it("a change inside the same bucket changes no count", () => {
    adoptApprovalsFromSnapshot(
      snapshotWith(approvalsSnapshot({ decided: [summary(1, "approved", 2)] })),
    );
    applyApprovalServiceEvent(upserted(summary(1, "executing", 3)));
    applyApprovalServiceEvent(upserted(summary(1, "executed", 4)));
    expect(approvalsCounts.value).toEqual({ pending: 0, decided: 1, expired: 0 });
  });

  it("counts never go below zero", () => {
    adoptApprovalsFromSnapshot(
      snapshotWith(
        approvalsSnapshot({
          pending: [summary(1)],
          counts: { pending: 0, decided: 0, expired: 0 },
        }),
      ),
    );
    applyApprovalServiceEvent(upserted(summary(1, "executed", 2)));
    expect(approvalsCounts.value).toEqual({ pending: 0, decided: 1, expired: 0 });
  });

  it("a disconnect never rewrites the counts or the pending count (UI-SPEC E13, D-15)", () => {
    adoptApprovalsFromSnapshot(
      snapshotWith(approvalsSnapshot({ pending: [summary(1), summary(2)] })),
    );
    connectionState.value = { kind: "disconnected", reason: "service stopped" };
    expect(approvalsCounts.value.pending).toBe(2);
    expect(pendingApprovalCount.value).toBe(2);
  });
});

describe("the notifier hook through the event path (Test 6)", () => {
  it("is called for a new request and not for a replay of the same revision", () => {
    const hook = vi.fn();
    setApprovalUpsertHook(hook);
    applyApprovalServiceEvent(upserted(summary(1)));
    applyApprovalServiceEvent(upserted(summary(1)));
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]?.[0]).toMatchObject({ proposalId: summary(1).proposalId });
  });

  it("is not called for a malformed payload", () => {
    const hook = vi.fn();
    setApprovalUpsertHook(hook);
    applyApprovalServiceEvent(upserted({ bad: true }));
    expect(hook).not.toHaveBeenCalled();
  });
});
