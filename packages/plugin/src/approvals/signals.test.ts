import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalsSnapshot, summary } from "../test-support/approval-fixtures.js";
import {
  adoptApprovalsSnapshot,
  applyApprovalSummary,
  approvalDetailFocusRequested,
  approvalsById,
  approvalsCounts,
  approvalsReady,
  approvalsTruncated,
  pendingApprovalCount,
  resetApprovalsState,
  selectedProposalId,
  setApprovalUpsertHook,
} from "./signals.js";

/**
 * Plan 06-10, Task 1 (tracer): the in-memory approval state (D-21, T-06-13).
 * Memory only: the plugin is a projection of the service, and nothing here is
 * ever written to plugin settings.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

beforeEach(resetApprovalsState);
afterEach(() => {
  resetApprovalsState();
  setApprovalUpsertHook(null);
});

describe("the signals start empty and honest", () => {
  it("has no map, zero counts, a null ready flag and a null pending count before any snapshot", () => {
    expect(approvalsById.value.size).toBe(0);
    expect(approvalsCounts.value).toEqual({ pending: 0, decided: 0, expired: 0 });
    expect(approvalsReady.value).toBeNull();
    expect(approvalsTruncated.value).toBe(false);
    expect(selectedProposalId.value).toBeNull();
    expect(approvalDetailFocusRequested.value).toBe(false);
    expect(pendingApprovalCount.value).toBeNull();
  });
});

describe("pendingApprovalCount (Test 5)", () => {
  it("is the pending bucket count once a snapshot has been adopted, zero included", () => {
    adoptApprovalsSnapshot(approvalsSnapshot());
    expect(pendingApprovalCount.value).toBe(0);
    adoptApprovalsSnapshot(approvalsSnapshot({ pending: [summary(1), summary(2)] }));
    expect(pendingApprovalCount.value).toBe(2);
  });

  it("follows the true count, not the length of a truncated list", () => {
    adoptApprovalsSnapshot(
      approvalsSnapshot({
        pending: [summary(1)],
        truncated: true,
        counts: { pending: 7, decided: 0, expired: 0 },
      }),
    );
    expect(pendingApprovalCount.value).toBe(7);
    expect(approvalsTruncated.value).toBe(true);
  });
});

describe("the upsert hook (Test 6)", () => {
  it("is called once with the summary for a request new to the map", () => {
    const hook = vi.fn();
    setApprovalUpsertHook(hook);
    const first = summary(1);
    expect(applyApprovalSummary(first)).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(first);
  });

  it("is called again when the revision advances, and not for a replay of the same revision", () => {
    const hook = vi.fn();
    setApprovalUpsertHook(hook);
    applyApprovalSummary(summary(1, "pending", 1));
    applyApprovalSummary(summary(1, "pending", 1));
    expect(hook).toHaveBeenCalledTimes(1);
    applyApprovalSummary(summary(1, "executed", 2));
    expect(hook).toHaveBeenCalledTimes(2);
    applyApprovalSummary(summary(1, "pending", 1));
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it("is called once for each summary of a snapshot that was not already known", () => {
    applyApprovalSummary(summary(1));
    const hook = vi.fn();
    setApprovalUpsertHook(hook);
    adoptApprovalsSnapshot(
      approvalsSnapshot({
        pending: [summary(1), summary(2)],
        decided: [summary(3, "executed", 2)],
      }),
    );
    expect(hook).toHaveBeenCalledTimes(2);
    const ids = hook.mock.calls.map((call) => (call[0] as { proposalId: string }).proposalId);
    expect(ids).toEqual([summary(2).proposalId, summary(3).proposalId]);
  });

  it("stops calling once cleared with null, and only one hook exists at a time", () => {
    const first = vi.fn();
    const second = vi.fn();
    setApprovalUpsertHook(first);
    setApprovalUpsertHook(second);
    applyApprovalSummary(summary(1));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    setApprovalUpsertHook(null);
    applyApprovalSummary(summary(2));
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("never lets a throwing hook break the state update", () => {
    setApprovalUpsertHook(() => {
      throw new Error("hook failure");
    });
    expect(applyApprovalSummary(summary(1))).toBe(true);
    expect(approvalsById.value.size).toBe(1);
  });
});

describe("memory only (D-21, T-06-13)", () => {
  it("the signals module imports no settings, storage or plugin data module", () => {
    const source = readFileSync(join(HERE, "signals.ts"), "utf8");
    const imports = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    expect(imports.filter((line) => /settings|data\.json|localStorage|obsidian/.test(line))).toEqual(
      [],
    );
    expect(source).not.toMatch(/saveData|loadData|localStorage|sessionStorage/);
  });
});

describe("no approval state in the settings (D-21, T-06-13)", () => {
  it("the settings interface and defaults hold only the notification preference", async () => {
    const { DEFAULT_SETTINGS } = await import("../settings.js");
    const approvalKeys = Object.keys(DEFAULT_SETTINGS).filter((key) => /approv/i.test(key));
    expect(approvalKeys).toEqual(["notifyApprovals"]);
  });

  it("the plugin makes exactly one event-stream subscribe call", () => {
    const connection = readFileSync(join(HERE, "..", "service-connection.ts"), "utf8");
    expect(connection.match(/\.subscribe\(/g)).toHaveLength(1);
    const approvalSources = ["signals.ts", "events.ts", "api.ts"].map((name) =>
      readFileSync(join(HERE, name), "utf8"),
    );
    for (const source of approvalSources) expect(source).not.toMatch(/\.subscribe\(/);
  });
});
