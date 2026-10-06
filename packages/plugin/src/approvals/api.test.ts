import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalsSnapshot, summary } from "../test-support/approval-fixtures.js";
import {
  type ApprovalsApi,
  approvalsApi,
  configureApprovalsApi,
  refreshApprovals,
} from "./api.js";
import {
  approvalsById,
  approvalsCounts,
  approvalsReady,
  resetApprovalsState,
} from "./signals.js";

/**
 * Plan 06-10, Task 1 (tracer), Test 8: the API holder. View code reaches the
 * service only through plain functions held here, never through the client
 * package (whose value exports pull in Node HTTP).
 */

function fakeApi(overrides: Partial<ApprovalsApi> = {}): ApprovalsApi {
  return {
    list: vi.fn(() => Promise.resolve(approvalsSnapshot({ pending: [summary(1)] }))),
    get: vi.fn(() => Promise.reject(new Error("unused"))),
    decide: vi.fn(() => Promise.reject(new Error("unused"))),
    test: vi.fn(() => Promise.reject(new Error("unused"))),
    ...overrides,
  };
}

beforeEach(resetApprovalsState);
afterEach(() => {
  resetApprovalsState();
  configureApprovalsApi(null);
});

describe("the approvals API holder", () => {
  it("with nothing configured, refreshApprovals resolves false without throwing", async () => {
    await expect(refreshApprovals()).resolves.toBe(false);
    expect(approvalsById.value.size).toBe(0);
  });

  it("with nothing configured, every holder function rejects with the service-disconnected code", async () => {
    for (const call of [
      () => approvalsApi().list(),
      () => approvalsApi().get("x"),
      () => approvalsApi().decide({ proposalId: "x", decision: "deny", payloadHash: "y" }),
      () => approvalsApi().test(),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "service-disconnected" });
    }
  });

  it("with a fake API returning a snapshot, adopts it and resolves true", async () => {
    const api = fakeApi();
    configureApprovalsApi(api);
    await expect(refreshApprovals()).resolves.toBe(true);
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(approvalsById.value.size).toBe(1);
    expect(approvalsCounts.value.pending).toBe(1);
    expect(approvalsReady.value).toBe(true);
  });

  it("a thrown error leaves the signals unchanged and resolves false", async () => {
    configureApprovalsApi(fakeApi());
    await refreshApprovals();
    configureApprovalsApi(fakeApi({ list: vi.fn(() => Promise.reject(new Error("down"))) }));
    await expect(refreshApprovals()).resolves.toBe(false);
    expect(approvalsById.value.size).toBe(1);
    expect(approvalsCounts.value.pending).toBe(1);
  });

  it("a malformed list response changes nothing and resolves false", async () => {
    configureApprovalsApi(fakeApi());
    await refreshApprovals();
    configureApprovalsApi(
      fakeApi({ list: vi.fn(() => Promise.resolve({ ready: 1 } as never)) }),
    );
    await expect(refreshApprovals()).resolves.toBe(false);
    expect(approvalsById.value.size).toBe(1);
  });

  it("exposes the list, get, decide and test functions only", () => {
    configureApprovalsApi(fakeApi());
    expect(Object.keys(approvalsApi()).sort()).toEqual(["decide", "get", "list", "test"]);
  });
});
