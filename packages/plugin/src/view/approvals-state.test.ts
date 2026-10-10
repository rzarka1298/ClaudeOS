import type { ApprovalSummary } from "@ccc/domain/approval.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proposalId, summary } from "../test-support/approval-fixtures.js";
import { approvalDetail, FIXTURE_NOW_MS } from "../test-support/approval-view-fixtures.js";
import { formatApprovalTime } from "./approvals-copy.js";
import {
  announceApproval,
  approvalChip,
  approvalsFooterModel,
  approvalsSectionVisible,
  approvalsStatus,
  approvalTimePhrase,
  chipName,
  chipText,
  createDetailCache,
  expiredPendingIds,
  hasArrival,
  orderedApprovals,
  pendingIdSet,
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

const NOW = FIXTURE_NOW_MS;
const minutesFromNow = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

describe("Test 1 (time phrases): the phrase each chip's rows show", () => {
  it("counts down under 24 hours with the shared duration formatter", () => {
    const row = summary(1, "pending", 1, { expiresAt: minutesFromNow(14) });
    expect(approvalTimePhrase(row, NOW)).toEqual({ text: "Expires in 14 min", urgent: false });
  });

  it("reads an absolute time at 24 hours and beyond", () => {
    const expiresAt = "2026-10-08T15:20:00.000Z";
    const row = summary(1, "pending", 1, { expiresAt });
    expect(approvalTimePhrase(row, NOW)).toEqual({
      text: `Expires ${formatApprovalTime(expiresAt, NOW)}`,
      urgent: false,
    });
  });

  it("is urgent under five minutes and reads Expiring… at zero and after", () => {
    const four = summary(1, "pending", 1, { expiresAt: minutesFromNow(4) });
    expect(approvalTimePhrase(four, NOW)).toEqual({ text: "Expires in 4 min", urgent: true });
    const zero = summary(2, "pending", 1, { expiresAt: new Date(NOW).toISOString() });
    expect(approvalTimePhrase(zero, NOW)).toEqual({ text: "Expiring…", urgent: true });
    const past = summary(3, "pending", 1, { expiresAt: minutesFromNow(-3) });
    expect(approvalTimePhrase(past, NOW).text).toBe("Expiring…");
  });

  it("reads the state and when it was decided for Decided rows", () => {
    const denied = summary(1, "denied", 2, { decidedAt: minutesFromNow(-5) });
    expect(approvalTimePhrase(denied, NOW)).toEqual({
      text: "Denied 5 minutes ago",
      urgent: false,
    });
    const failed = summary(2, "failed", 4, { decidedAt: minutesFromNow(-125) });
    expect(approvalTimePhrase(failed, NOW).text).toBe("Failed 2 hours ago");
    const noTime = summary(3, "approved", 2, { decidedAt: null });
    expect(approvalTimePhrase(noTime, NOW).text).toBe("Approved");
  });

  it("reads Expired and when for Expired rows, from the expiry when no decision time exists", () => {
    const expired = summary(1, "expired", 2, { expiresAt: minutesFromNow(-90), decidedAt: null });
    expect(approvalTimePhrase(expired, NOW).text).toBe("Expired 1 hour ago");
  });
});

describe("Test 3 (ordering): Decided and Expired list the most recent decision first", () => {
  it("orders by decision time newest first, falling back to the expiry", () => {
    const older = summary(1, "denied", 2, { decidedAt: minutesFromNow(-60) });
    const newer = summary(2, "executed", 4, { decidedAt: minutesFromNow(-5) });
    const noTime = summary(3, "expired", 2, { expiresAt: minutesFromNow(-30), decidedAt: null });
    const newest = summary(4, "expired", 2, {
      expiresAt: minutesFromNow(-10),
      decidedAt: minutesFromNow(-10),
    });
    const map = mapOf(older, newer, noTime, newest);
    expect(orderedApprovals(map, "decided").map((row) => row.proposalId)).toEqual([
      newer.proposalId,
      older.proposalId,
    ]);
    expect(orderedApprovals(map, "expired").map((row) => row.proposalId)).toEqual([
      newest.proposalId,
      noTime.proposalId,
    ]);
  });
});

describe("Test 4 (zero-expiry): which pending requests have run out", () => {
  it("names only pending requests whose expiry is at or before now", () => {
    const due = summary(1, "pending", 1, { expiresAt: minutesFromNow(-1) });
    const exactly = summary(2, "pending", 1, { expiresAt: new Date(NOW).toISOString() });
    const later = summary(3, "pending", 1, { expiresAt: minutesFromNow(5) });
    const decided = summary(4, "denied", 2, { expiresAt: minutesFromNow(-10) });
    expect(expiredPendingIds(mapOf(due, exactly, later, decided), NOW)).toEqual([
      due.proposalId,
      exactly.proposalId,
    ]);
  });
});

describe("Test 6 (arrival): a new pending request is the only thing announced", () => {
  it("collects the pending ids", () => {
    const set = pendingIdSet(mapOf(summary(1, "pending"), summary(2, "denied", 2)));
    expect([...set]).toEqual([proposalId(1)]);
  });

  it("is an arrival only when an id appears that was not pending before", () => {
    const a = new Set([proposalId(1)]);
    expect(hasArrival(a, new Set([proposalId(1), proposalId(2)]))).toBe(true);
    expect(hasArrival(a, new Set([proposalId(1)]))).toBe(false);
    expect(hasArrival(a, new Set())).toBe(false);
    expect(hasArrival(new Set(), new Set())).toBe(false);
  });
});

describe("Test 9 (provenance strip): the footer model", () => {
  const base = {
    hydrated: true,
    ready: true,
    disconnected: false,
    missedSync: false,
    observedAt: "2026-10-06T11:58:00.000Z",
  } as const;

  it("is live with one Approval inbox source while the stream is healthy", () => {
    expect(approvalsFooterModel(base)).toEqual({
      observedAt: "2026-10-06T11:58:00.000Z",
      freshness: "live",
      partiality: null,
      sources: [{ label: "Approval inbox", status: "ok" }],
    });
  });

  it("is stale after a missed sync", () => {
    expect(approvalsFooterModel({ ...base, missedSync: true }).freshness).toBe("stale");
  });

  it("is unavailable when the engine is not ready, with no observation time", () => {
    const model = approvalsFooterModel({ ...base, ready: false });
    expect(model.freshness).toBe("unavailable");
    expect(model.observedAt).toBeNull();
    expect(model.sources).toEqual([{ label: "Approval inbox", status: "no-source" }]);
  });

  it("is unavailable but keeps the last observation while disconnected", () => {
    const model = approvalsFooterModel({ ...base, disconnected: true });
    expect(model.freshness).toBe("unavailable");
    expect(model.observedAt).toBe("2026-10-06T11:58:00.000Z");
    expect(model.sources).toEqual([{ label: "Approval inbox", status: "disconnected" }]);
  });
});
