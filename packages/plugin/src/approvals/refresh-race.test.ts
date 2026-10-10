import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalsSnapshot, proposalId, summary } from "../test-support/approval-fixtures.js";
import { type ApprovalsApi, configureApprovalsApi, refreshApprovals } from "./api.js";
import {
  adoptApprovalsSnapshot,
  applyApprovalSummary,
  approvalsById,
  approvalsCounts,
  pendingApprovalCount,
  resetApprovalsState,
  setApprovalUpsertHook,
} from "./signals.js";

/** Wave-7: a reconnect refresh must never regress a revision an event already advanced. */

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function apiWith(list: ApprovalsApi["list"]): ApprovalsApi {
  const none = () => Promise.reject(new Error("unused"));
  return { list, get: none, decide: none, test: none };
}

beforeEach(resetApprovalsState);
afterEach(() => {
  configureApprovalsApi(null);
  resetApprovalsState();
  setApprovalUpsertHook(null);
});

describe("snapshot adoption never regresses a revision", () => {
  it("a late older snapshot keeps the decided revision, the counts and does not re-notify", async () => {
    const hook = vi.fn();
    const d = deferred<ReturnType<typeof approvalsSnapshot>>();
    configureApprovalsApi(apiWith(() => d.promise));
    const refresh = refreshApprovals();
    setApprovalUpsertHook(hook);
    applyApprovalSummary(summary(1, "pending", 1));
    applyApprovalSummary(summary(1, "approved", 2));
    hook.mockClear();
    d.resolve(approvalsSnapshot({ pending: [summary(1, "pending", 1)] }));
    await refresh;
    expect(approvalsById.value.get(proposalId(1))?.state).toBe("approved");
    expect(approvalsById.value.get(proposalId(1))?.revision).toBe(2);
    expect(pendingApprovalCount.value).toBe(0);
    expect(approvalsCounts.value).toEqual({ pending: 0, decided: 1, expired: 0 });
    expect(hook).not.toHaveBeenCalled();
  });

  it("a request that arrived by event while a refresh was in flight survives that refresh", async () => {
    const d = deferred<ReturnType<typeof approvalsSnapshot>>();
    configureApprovalsApi(apiWith(() => d.promise));
    const refresh = refreshApprovals();
    applyApprovalSummary(summary(2, "pending", 1));
    d.resolve(approvalsSnapshot({ pending: [summary(1, "pending", 1)] }));
    await refresh;
    expect(approvalsById.value.has(proposalId(2))).toBe(true);
    expect(approvalsById.value.has(proposalId(1))).toBe(true);
    expect(pendingApprovalCount.value).toBe(2);
    expect(approvalsCounts.value).toEqual({ pending: 2, decided: 0, expired: 0 });
  });

  it("an older entry absent from the refresh response is still dropped", async () => {
    applyApprovalSummary(summary(2, "pending", 1));
    const d = deferred<ReturnType<typeof approvalsSnapshot>>();
    configureApprovalsApi(apiWith(() => d.promise));
    const refresh = refreshApprovals();
    d.resolve(approvalsSnapshot({ pending: [summary(1, "pending", 1)] }));
    await refresh;
    expect(approvalsById.value.has(proposalId(2))).toBe(false);
    expect(approvalsCounts.value).toEqual({ pending: 1, decided: 0, expired: 0 });
  });

  it("entries absent from a bare snapshot are dropped and newer snapshot entries win", () => {
    applyApprovalSummary(summary(1, "pending", 1));
    applyApprovalSummary(summary(2, "pending", 1));
    adoptApprovalsSnapshot(approvalsSnapshot({ decided: [summary(1, "approved", 3)] }));
    expect(approvalsById.value.has(proposalId(2))).toBe(false);
    expect(approvalsById.value.get(proposalId(1))?.revision).toBe(3);
    expect(approvalsCounts.value).toEqual({ pending: 0, decided: 1, expired: 0 });
  });
});

describe("concurrent refreshes", () => {
  it("only the latest call's snapshot is adopted", async () => {
    const first = deferred<ReturnType<typeof approvalsSnapshot>>();
    const second = deferred<ReturnType<typeof approvalsSnapshot>>();
    const lists = [first, second];
    let i = 0;
    configureApprovalsApi(apiWith(() => lists[i++]?.promise as never));
    const a = refreshApprovals();
    const b = refreshApprovals();
    second.resolve(approvalsSnapshot({ decided: [summary(1, "approved", 2)] }));
    await b;
    first.resolve(approvalsSnapshot({ pending: [summary(1, "pending", 1), summary(2)] }));
    await a;
    expect(approvalsById.value.size).toBe(1);
    expect(approvalsById.value.get(proposalId(1))?.state).toBe("approved");
  });
});
