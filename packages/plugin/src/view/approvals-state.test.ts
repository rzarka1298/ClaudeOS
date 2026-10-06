import type { ApprovalSummary } from "@ccc/domain/approval.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proposalId, summary } from "../test-support/approval-fixtures.js";
import { approvalDetail } from "../test-support/approval-view-fixtures.js";
import {
  announceApproval,
  approvalChip,
  approvalsSectionVisible,
  approvalsStatus,
  chipName,
  chipText,
  createDetailCache,
  orderedApprovals,
  resetApprovalsView,
} from "./approvals-state.js";

beforeEach(() => {
  resetApprovalsView();
});

afterEach(() => {
  resetApprovalsView();
});

function mapOf(...items: readonly ApprovalSummary[]): ReadonlyMap<string, ApprovalSummary> {
  return new Map(items.map((item) => [item.proposalId, item]));
}

describe("Test 1: chip text and accessible names from the true counts", () => {
  const counts = { pending: 2, decided: 7, expired: 1 };

  it("puts the count in the visible text and spells the accessible name out", () => {
    expect(chipText("pending", counts)).toBe("Pending (2)");
    expect(chipText("decided", counts)).toBe("Decided (7)");
    expect(chipText("expired", counts)).toBe("Expired (1)");
    expect(chipName("pending", counts)).toBe("Pending, 2 requests");
    expect(chipName("decided", counts)).toBe("Decided, 7 requests");
    expect(chipName("expired", counts)).toBe("Expired, 1 request");
  });

  it("renders the labels with no number while the counts are unknown", () => {
    expect(chipText("pending", null)).toBe("Pending");
    expect(chipName("decided", null)).toBe("Decided");
  });

  it("starts on Pending", () => {
    expect(approvalChip.value).toBe("pending");
  });
});

describe("Test 2: the pending list is ordered by soonest expiry", () => {
  it("sorts Pending by expiry and leaves other states out", () => {
    const late = summary(1, "pending", 1, { expiresAt: "2026-10-06T14:00:00.000Z" });
    const soon = summary(2, "pending", 1, { expiresAt: "2026-10-06T12:10:00.000Z" });
    const mid = summary(3, "pending", 1, { expiresAt: "2026-10-06T13:00:00.000Z" });
    const done = summary(4, "approved", 2, { decidedAt: "2026-10-06T11:00:00.000Z" });
    const ordered = orderedApprovals(mapOf(late, soon, mid, done), "pending");
    expect(ordered.map((item) => item.proposalId)).toEqual([
      soon.proposalId,
      mid.proposalId,
      late.proposalId,
    ]);
  });
});

describe("Test 4: the status message", () => {
  it("holds one message at a time; a new message replaces the old", () => {
    expect(approvalsStatus.value).toBe("");
    announceApproval("Sending your decision…");
    expect(approvalsStatus.value).toBe("Sending your decision…");
    announceApproval("Denied. Nothing was changed.");
    expect(approvalsStatus.value).toBe("Denied. Nothing was changed.");
  });
});

describe("Test 5: the visibility signal", () => {
  it("starts false and is cleared by a reset", () => {
    expect(approvalsSectionVisible.value).toBe(false);
    approvalsSectionVisible.value = true;
    resetApprovalsView();
    expect(approvalsSectionVisible.value).toBe(false);
  });
});

describe("the detail cache", () => {
  it("fetches once for concurrent calls and fetches again after the answer settled", async () => {
    const fetch = vi.fn(async () => approvalDetail());
    const cache = createDetailCache(fetch);
    const [a, b] = await Promise.all([cache.get(proposalId(1)), cache.get(proposalId(1))]);
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledTimes(1);
    await cache.get(proposalId(1));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never hands a settled answer to a later call, so a refetch always asks the service", async () => {
    let calls = 0;
    const cache = createDetailCache(async () => {
      calls += 1;
      return { ...approvalDetail(), payloadHash: `${calls}`.repeat(64).slice(0, 64) };
    });
    const first = await cache.get(proposalId(1));
    const second = await cache.get(proposalId(1));
    expect(first.payloadHash).not.toBe(second.payloadHash);
  });

  it("passes a rejection on and does not keep it", async () => {
    let fail = true;
    const cache = createDetailCache(async () => {
      if (fail) throw new Error("down");
      return approvalDetail();
    });
    await expect(cache.get(proposalId(1))).rejects.toThrow("down");
    fail = false;
    await expect(cache.get(proposalId(1))).resolves.toBeDefined();
  });
});
