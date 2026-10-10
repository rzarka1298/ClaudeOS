import type { ProposeForceTerminate } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { approvalUnavailableProposer, createProposerSlot } from "./default-ports.js";

/** A proposer that records what it was asked. */
function recordingProposer(proposalId: string): ProposeForceTerminate & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async propose(request) {
      calls.push(request.runId);
      return { ok: true, proposalId };
    },
  };
}

describe("proposer slot (Task 2, Test 1)", () => {
  it("answers approval-unavailable before it is bound and creates nothing", async () => {
    const slot = createProposerSlot();
    expect(await slot.proposer.propose({ runId: "run-1" })).toEqual({
      ok: false,
      reason: "approval-unavailable",
    });
  });

  it("keeps the Phase 5 constant exported and identical in answer", async () => {
    const slot = createProposerSlot();
    expect(await approvalUnavailableProposer.propose({ runId: "run-1" })).toEqual(
      await slot.proposer.propose({ runId: "run-1" }),
    );
  });

  it("delegates to the bound proposer after bind", async () => {
    const slot = createProposerSlot();
    const real = recordingProposer("proposal-1");
    slot.bind(real);
    expect(await slot.proposer.propose({ runId: "run-9" })).toEqual({
      ok: true,
      proposalId: "proposal-1",
    });
    expect(real.calls).toEqual(["run-9"]);
  });

  it("hands out one stable proposer object, so a bind after the routes hold it still takes effect", async () => {
    const slot = createProposerSlot();
    const held = slot.proposer;
    slot.bind(recordingProposer("proposal-2"));
    expect(slot.proposer).toBe(held);
    expect(await held.propose({ runId: "run-3" })).toEqual({ ok: true, proposalId: "proposal-2" });
  });

  it("refuses a second bind (06-RECONCILE R-WIRING) and keeps the first target", async () => {
    const slot = createProposerSlot();
    slot.bind(recordingProposer("first"));
    expect(() => slot.bind(recordingProposer("second"))).toThrow();
    expect(await slot.proposer.propose({ runId: "run-4" })).toEqual({
      ok: true,
      proposalId: "first",
    });
  });

  it("has no capability beyond propose and bind", () => {
    const slot = createProposerSlot();
    expect(Object.keys(slot).sort()).toEqual(["bind", "proposer"]);
    expect(Object.keys(slot.proposer)).toEqual(["propose"]);
  });

  it("remembers nothing: a request before bind is not replayed after it", async () => {
    const slot = createProposerSlot();
    await slot.proposer.propose({ runId: "early" });
    const real = recordingProposer("proposal-5");
    slot.bind(real);
    expect(real.calls).toEqual([]);
  });
});
