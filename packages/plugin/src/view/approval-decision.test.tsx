import type { DecideResponse } from "@ccc/domain/approval.js";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalDecideInput } from "../approvals/api.js";
import { proposalId, summary } from "../test-support/approval-fixtures.js";
import {
  approvalDetail,
  approvalView,
  decidedView,
  FIXTURE_HASH,
  FIXTURE_NOW_MS,
  testApprovalView,
} from "../test-support/approval-view-fixtures.js";
import {
  ApprovalDecision,
  type ApprovalDecisionProps,
  type RefetchResult,
  subjectOfView,
} from "./approval-decision.js";
import { APPROVAL_STATUS, DISABLED_REASONS } from "./approvals-copy.js";

afterEach(cleanup);

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const DECIDED: DecideResponse = {
  outcome: "decided",
  approval: summary(1, "approved", 2),
};

function setup(overrides: Partial<ApprovalDecisionProps> = {}) {
  const view = approvalView();
  const announce = vi.fn();
  const notify = vi.fn();
  const onFollowUp = vi.fn();
  const decide = vi.fn(async (_input: ApprovalDecideInput): Promise<DecideResponse> => DECIDED);
  const refetch = vi.fn(
    async (): Promise<RefetchResult> => ({
      kind: "ok",
      detail: approvalDetail(decidedView("approved")),
    }),
  );
  const props: ApprovalDecisionProps = {
    subject: subjectOfView(view),
    shownHash: FIXTURE_HASH,
    reviewable: true,
    nowMs: FIXTURE_NOW_MS,
    connected: true,
    stale: false,
    approveHold: false,
    decide,
    refetch,
    announce,
    notify,
    onFollowUp,
    ...overrides,
  };
  const utils = render(<ApprovalDecision {...props} />);
  return { ...utils, props, announce, notify, onFollowUp, decide, refetch };
}

function buttons() {
  const group = screen.getByRole("group", { name: "Decision" });
  const all = within(group).getAllByRole("button");
  return {
    group,
    all,
    deny: all[0] as HTMLButtonElement,
    approve: all[1] as HTMLButtonElement,
    run: all[2] as HTMLButtonElement,
  };
}

function reasonOf(button: HTMLElement): string {
  const ids = (button.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  return ids
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim();
}

describe("the decision group (UI-SPEC S2, Test 3)", () => {
  it("is a group named Decision holding Deny, Approve once, then Open originating run in tab order", () => {
    setup();
    const { all, group } = buttons();
    expect(group.getAttribute("role")).toBe("group");
    expect(all.map((b) => b.textContent)).toEqual(["Deny", "Approve once", "Open originating run"]);
    expect(all.map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Deny: Force-terminate Refactor parser",
      "Approve once: force-terminate Refactor parser",
      "Open originating run: Refactor parser",
    ]);
    expect(screen.getByRole("button", { name: "Deny: Force-terminate Refactor parser" })).toBe(
      all[0],
    );
  });

  it("shows a visible effect sub-label under Approve once for a destructive request, linked by aria-describedby", () => {
    setup();
    const { approve } = buttons();
    const sublabel = screen.getByText("This will force-terminate Refactor parser.");
    expect(sublabel.id).not.toBe("");
    expect(approve.getAttribute("aria-describedby")?.split(" ")).toContain(sublabel.id);
  });

  it("shows no sub-label for a request that is not destructive, and names the approval by its title", () => {
    setup({ subject: subjectOfView(testApprovalView()) });
    expect(screen.queryByText(/^This will /)).toBeNull();
    const { approve, run } = buttons();
    expect(approve.getAttribute("aria-label")).toBe("Approve once: Test approval");
    expect(run.getAttribute("aria-disabled")).toBe("true");
    expect(reasonOf(run)).toBe(DISABLED_REASONS.noRun);
  });

  it("is never autofocused, never native disabled and never accent-named", () => {
    setup();
    const { all } = buttons();
    for (const button of all) {
      expect(button.hasAttribute("autofocus")).toBe(false);
      expect(button.hasAttribute("disabled")).toBe(false);
    }
    expect(document.activeElement).not.toBe(all[1]);
  });
});

describe("gating (Test 4)", () => {
  it("enables both decisions when everything holds", () => {
    setup();
    const { deny, approve } = buttons();
    expect(deny.getAttribute("aria-disabled")).toBeNull();
    expect(approve.getAttribute("aria-disabled")).toBeNull();
  });

  it.each([
    {
      name: "the full request has not loaded",
      change: { shownHash: null },
      reason: DISABLED_REASONS.loading,
      denyEnabled: true,
    },
    {
      name: "the request has expired",
      change: { nowMs: Date.parse("2026-10-06T12:14:00.000Z") },
      reason: DISABLED_REASONS.expired,
      denyEnabled: false,
    },
    {
      name: "the change was not fully shown",
      change: { reviewable: false },
      reason: DISABLED_REASONS.tooLarge,
      denyEnabled: true,
    },
    {
      name: "the list may be out of date",
      change: { stale: true },
      reason: DISABLED_REASONS.stale,
      denyEnabled: true,
    },
    {
      name: "the service is not connected",
      change: { connected: false },
      reason: DISABLED_REASONS.disconnected,
      denyEnabled: false,
    },
  ] as const)("withholds Approve once when $name, with its visible reason", (row) => {
    setup(row.change);
    const { deny, approve } = buttons();
    expect(approve.getAttribute("aria-disabled")).toBe("true");
    expect(approve.hasAttribute("disabled")).toBe(false);
    expect(reasonOf(approve)).toContain(row.reason);
    expect(deny.hasAttribute("disabled")).toBe(false);
    expect(deny.getAttribute("aria-disabled") === "true").toBe(!row.denyEnabled);
    if (!row.denyEnabled) expect(reasonOf(deny)).toContain(row.reason);
  });

  it("holds Approve once after a hash mismatch until the pane releases it", () => {
    setup({ approveHold: true });
    const { approve, deny } = buttons();
    expect(approve.getAttribute("aria-disabled")).toBe("true");
    expect(deny.getAttribute("aria-disabled")).toBeNull();
  });
});

describe("the decide call (Test 5)", () => {
  it("sends approve with exactly the displayed hash", async () => {
    const { decide } = setup();
    fireEvent.click(buttons().approve);
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(decide).toHaveBeenCalledWith({
      proposalId: proposalId(1),
      decision: "approve",
      payloadHash: FIXTURE_HASH,
    });
  });

  it("sends deny with the same hash", async () => {
    const { decide } = setup();
    fireEvent.click(buttons().deny);
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(decide).toHaveBeenCalledWith({
      proposalId: proposalId(1),
      decision: "deny",
      payloadHash: FIXTURE_HASH,
    });
  });

  it("sends nothing from a control that is aria-disabled", () => {
    const { decide } = setup({ stale: true });
    fireEvent.click(buttons().approve);
    expect(decide).not.toHaveBeenCalled();
  });

  it("carries the hash of what was shown even when the pane later holds another one", async () => {
    const decide = vi.fn(async (_input: ApprovalDecideInput): Promise<DecideResponse> => DECIDED);
    const { rerender, props } = setup({ decide });
    rerender(<ApprovalDecision {...props} shownHash={"cd34".repeat(16)} />);
    fireEvent.click(buttons().deny);
    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide.mock.calls[0]?.[0]).toMatchObject({ payloadHash: "cd34".repeat(16) });
  });

  it("while the full request is still loading, a pressed Deny waits for the hash instead of sending none", async () => {
    const hash = deferred<string | null>();
    const decide = vi.fn(async (_input: ApprovalDecideInput): Promise<DecideResponse> => DECIDED);
    setup({ shownHash: null, decide, awaitHash: () => hash.promise });
    fireEvent.click(buttons().deny);
    expect(decide).not.toHaveBeenCalled();
    hash.resolve(FIXTURE_HASH);
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(decide.mock.calls[0]?.[0]).toMatchObject({
      decision: "deny",
      payloadHash: FIXTURE_HASH,
    });
  });
});

describe("double fire (Test 6)", () => {
  it("marks both buttons busy and disabled before the call settles, says so at once, and ignores a second press", () => {
    const pending = deferred<DecideResponse>();
    const decide = vi.fn(() => pending.promise);
    const { announce } = setup({ decide });
    const { deny, approve } = buttons();
    fireEvent.click(approve);
    expect(announce).toHaveBeenCalledWith(APPROVAL_STATUS.sending);
    for (const button of [deny, approve]) {
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(button.getAttribute("aria-disabled")).toBe("true");
    }
    fireEvent.click(approve);
    fireEvent.click(deny);
    expect(decide).toHaveBeenCalledTimes(1);
  });
});

describe("outcomes (Test 7)", () => {
  it("announces and notifies an approval, hands the refetched request to the pane and asks for the heading", async () => {
    const { announce, notify, onFollowUp } = setup();
    fireEvent.click(buttons().approve);
    await waitFor(() => expect(onFollowUp).toHaveBeenCalled());
    expect(announce).toHaveBeenCalledWith(APPROVAL_STATUS.approved);
    expect(notify).toHaveBeenCalledWith("Approved: Force-terminate Refactor parser.");
    expect(onFollowUp.mock.calls[0]?.[0]).toMatchObject({
      kind: "refetched",
      mismatch: false,
      focusHeading: true,
    });
  });

  it("announces and notifies a denial", async () => {
    const { announce, notify, onFollowUp } = setup({
      refetch: async () => ({ kind: "ok", detail: approvalDetail(decidedView("denied")) }),
    });
    fireEvent.click(buttons().deny);
    await waitFor(() => expect(onFollowUp).toHaveBeenCalled());
    expect(announce).toHaveBeenCalledWith(APPROVAL_STATUS.denied);
    expect(notify).toHaveBeenCalledWith("Denied: Force-terminate Refactor parser.");
  });

  it("re-fetches once after a hash mismatch, says so, and marks the follow-up as a mismatch", async () => {
    const refetch = vi.fn(
      async (): Promise<RefetchResult> => ({
        kind: "ok",
        detail: approvalDetail(approvalView({ revision: 2 })),
      }),
    );
    const { announce, notify, onFollowUp } = setup({
      decide: async () => ({ outcome: "hash-mismatch" }),
      refetch,
    });
    fireEvent.click(buttons().approve);
    await waitFor(() => expect(onFollowUp).toHaveBeenCalled());
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(APPROVAL_STATUS.hashMismatch);
    expect(notify).toHaveBeenCalledWith(APPROVAL_STATUS.hashMismatch);
    expect(onFollowUp.mock.calls[0]?.[0]).toMatchObject({
      kind: "refetched",
      mismatch: true,
      focusHeading: true,
    });
  });

  it.each([
    { response: { outcome: "expired" }, line: APPROVAL_STATUS.expiredDuringDecide, notice: true },
    {
      response: { outcome: "already-decided", state: "denied" },
      line: APPROVAL_STATUS.alreadyDecided,
      notice: true,
    },
    { response: { outcome: "not-found" }, line: APPROVAL_STATUS.notFound, notice: false },
  ] as const)("posts the fixed line for $response.outcome", async ({ response, line, notice }) => {
    const { announce, notify, onFollowUp } = setup({
      decide: async () => response,
      refetch: async () => ({ kind: "ok", detail: approvalDetail(decidedView("expired")) }),
    });
    fireEvent.click(buttons().approve);
    await waitFor(() => expect(announce).toHaveBeenCalledWith(line));
    expect(notify.mock.calls.some((call) => call[0] === line)).toBe(notice);
    if (response.outcome === "not-found") {
      await waitFor(() => expect(buttons().approve.getAttribute("aria-busy")).toBeNull());
      expect(onFollowUp).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "refetched" }));
    }
  });

  describe("a transport failure is UNCONFIRMED", () => {
    it("keeps both buttons disabled and busy while the refetch is outstanding, then restores them if still pending", async () => {
      const check = deferred<RefetchResult>();
      const { announce, onFollowUp } = setup({
        decide: async () => {
          throw new Error("timeout");
        },
        refetch: () => check.promise,
      });
      fireEvent.click(buttons().approve);
      await waitFor(() => expect(announce).toHaveBeenCalledWith(APPROVAL_STATUS.transport));
      await Promise.resolve();
      for (const button of [buttons().deny, buttons().approve]) {
        expect(button.getAttribute("aria-disabled")).toBe("true");
        expect(button.getAttribute("aria-busy")).toBe("true");
      }
      check.resolve({ kind: "ok", detail: approvalDetail(approvalView()) });
      await waitFor(() => expect(announce).toHaveBeenCalledWith(APPROVAL_STATUS.notThrough));
      await waitFor(() => expect(buttons().deny.getAttribute("aria-disabled")).toBeNull());
      expect(buttons().approve.getAttribute("aria-busy")).toBeNull();
      expect(onFollowUp.mock.calls.at(-1)?.[0]).toMatchObject({ focusHeading: false });
    });

    it("shows the committed outcome when the service decided before the response was lost, never 'nothing was decided'", async () => {
      const { announce, notify, onFollowUp } = setup({
        decide: async () => {
          throw new Error("timeout");
        },
        refetch: async () => ({ kind: "ok", detail: approvalDetail(decidedView("denied")) }),
      });
      fireEvent.click(buttons().deny);
      await waitFor(() => expect(onFollowUp).toHaveBeenCalled());
      expect(announce).toHaveBeenCalledWith(APPROVAL_STATUS.denied);
      expect(notify).toHaveBeenCalledWith("Denied: Force-terminate Refactor parser.");
      expect(announce).not.toHaveBeenCalledWith(APPROVAL_STATUS.notThrough);
      expect(announce.mock.calls.some((call) => /nothing was decided/i.test(String(call[0])))).toBe(
        false,
      );
      expect(onFollowUp.mock.calls.at(-1)?.[0]).toMatchObject({
        kind: "refetched",
        focusHeading: true,
      });
    });

    it("reports an approval that went through as approved", async () => {
      const { announce, onFollowUp } = setup({
        decide: async () => {
          throw new Error("timeout");
        },
        refetch: async () => ({ kind: "ok", detail: approvalDetail(decidedView("executing")) }),
      });
      fireEvent.click(buttons().approve);
      await waitFor(() => expect(onFollowUp).toHaveBeenCalled());
      expect(announce).toHaveBeenCalledWith(APPROVAL_STATUS.approved);
    });

    it("stays disabled with the fixed line when the refetch also fails", async () => {
      const { announce } = setup({
        decide: async () => {
          throw new Error("timeout");
        },
        refetch: async () => ({ kind: "error" }),
      });
      fireEvent.click(buttons().approve);
      await waitFor(() => expect(announce).toHaveBeenCalledWith(APPROVAL_STATUS.confirmFailed));
      await waitFor(() => expect(buttons().approve.getAttribute("aria-busy")).toBeNull());
      expect(buttons().approve.getAttribute("aria-disabled")).toBe("true");
      expect(buttons().deny.getAttribute("aria-disabled")).toBe("true");
      expect(reasonOf(buttons().deny)).toContain(APPROVAL_STATUS.confirmFailed);
      fireEvent.click(buttons().deny);
      expect(screen.getAllByRole("button")).toHaveLength(3);
    });
  });
});
