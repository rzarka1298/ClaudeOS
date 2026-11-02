// The engine signs every approval (09-17, D-03, APPR-12). A proof made with the engine's own key sits
// in the stored row of every approve and in no deny; the key is required, so no construction site can
// skip the proof.
import type { ProposalId, StoredProposal } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { createApprovalEngine } from "./engine.js";
import { verifyDecisionProof } from "./proof.js";
import { buildOperationRegistry } from "./registry.js";
import { EXTENDED_TABLE, fakeNamed } from "./test-support/extended-table.js";
import { createHarness, type Harness, TEST_PROOF_KEY } from "./test-support/harness.js";
import { createPresenceFake, PROVED, TEST_PIN } from "./test-support/presence-fake.js";

const WRITE = "connector.fake-write";

function hashOf(h: Harness, id: ProposalId): string {
  return h.store.get(id)?.payloadHash ?? "";
}

function stored(h: Harness, id: ProposalId): StoredProposal {
  const row = h.store.get(id);
  if (row === null) throw new Error("missing row");
  return row;
}

describe("the engine signs approvals (09-17 Task 1)", () => {
  it("Test 1: an ungated approve stores a proof that verifies under the engine key; a deny stores none", async () => {
    const h = createHarness();
    const approved = h.propose({ subject: "a" });
    const denied = h.propose({ subject: "b" });
    await h.engine.decide({
      proposalId: approved,
      decision: "approve",
      payloadHash: hashOf(h, approved),
      channelHint: "plugin",
    });
    await h.engine.decide({
      proposalId: denied,
      decision: "deny",
      payloadHash: hashOf(h, denied),
      channelHint: "plugin",
    });
    await h.engine.settled();

    const row = stored(h, approved);
    expect(row.decisionProof).toEqual(expect.any(String));
    expect(verifyDecisionProof(TEST_PROOF_KEY, row, { presenceRequired: false, pin: null })).toBe(
      "valid",
    );
    // Another key does not verify it.
    expect(
      verifyDecisionProof(Buffer.alloc(32, 9), row, { presenceRequired: false, pin: null }),
    ).toBe("invalid");
    expect(stored(h, denied).decisionProof ?? null).toBeNull();
  });

  it("Test 2: a gated approve stores a proof whose covered approvedAt is the instant the port vouched for", async () => {
    const port = createPresenceFake();
    const h = createHarness({
      table: EXTENDED_TABLE,
      registry: ([a, b]) =>
        buildOperationRegistry(
          [a, b, fakeNamed("connector.fake-send"), fakeNamed(WRITE)].flatMap((f) =>
            f === undefined ? [] : [f.definition],
          ),
          EXTENDED_TABLE,
        ),
      presence: port,
    });
    const id = h.propose({ operation: WRITE, subject: "w" });
    port.script(async () => {
      h.clock.advance(10_000);
      return PROVED;
    });
    const asked = h.clock.now();
    const response = await h.engine.decide({
      proposalId: id,
      decision: "approve",
      payloadHash: hashOf(h, id),
      channelHint: "other",
    });
    expect(response.outcome).toBe("decided");
    const row = stored(h, id);
    expect(row.approvedAt).toBe(asked);
    expect(port.requests[0]?.approvedAt).toBe(asked);
    expect(row.decidedVia).toBe("presence");
    expect(
      verifyDecisionProof(TEST_PROOF_KEY, row, { presenceRequired: true, pin: TEST_PIN }),
    ).toBe("valid");
  });

  it("Test 2b: the ungated proof covers the instant the store recorded as approvedAt", async () => {
    const h = createHarness();
    const id = h.propose({ subject: "t" });
    h.clock.advance(5_000);
    await h.engine.decide({
      proposalId: id,
      decision: "approve",
      payloadHash: hashOf(h, id),
      channelHint: "plugin",
    });
    const row = stored(h, id);
    expect(row.approvedAt).toBe(h.clock.now());
    expect(verifyDecisionProof(TEST_PROOF_KEY, row, { presenceRequired: false, pin: null })).toBe(
      "valid",
    );
  });
});

describe("a row changed while the engine awaits is not executed (09-FIX8, item 1)", () => {
  async function approveWithTamper(
    patchOf: (h: Harness) => Parameters<Harness["store"]["tamperDecision"]>[1],
  ): Promise<{ h: Harness; id: ProposalId }> {
    const h = createHarness();
    const id = h.propose();
    // The claim facts are awaited between the engine's proof check and the claim: change the row there.
    h.diagnostic.onClaimFacts = () => h.store.tamperDecision(id, patchOf(h));
    await h.engine.decide({
      proposalId: id,
      decision: "approve",
      payloadHash: hashOf(h, id),
      channelHint: "plugin",
    });
    await h.engine.settled();
    return { h, id };
  }

  it("decided_via changed during the claimFacts await: nothing runs, the row ends failed / proof-invalid, a warning is logged", async () => {
    const { h, id } = await approveWithTamper(() => ({ decidedVia: "other" }));
    expect(h.diagnostic.executeCalls).toHaveLength(0);
    expect(stored(h, id).state).toBe("failed");
    expect(stored(h, id).outcomeCode).toBe("proof-invalid");
    expect(
      h.log.lines.filter((l) => l.fields.code === "approval-proof-invalid" && l.level === "warn"),
    ).toHaveLength(1);
  });

  it("approved_at changed during the claimFacts await: nothing runs", async () => {
    const { h, id } = await approveWithTamper((h) => ({
      // One second earlier than the real instant: still young, so only the proof can refuse it.
      approvedAt: new Date(Date.parse(h.clock.now()) - 1_000).toISOString(),
    }));
    expect(h.diagnostic.executeCalls).toHaveLength(0);
    expect(stored(h, id).outcomeCode).toBe("proof-invalid");
  });

  it("control: an untouched row still runs", async () => {
    const { h, id } = await approveWithTamper(() => ({}));
    expect(h.diagnostic.executeCalls).toHaveLength(1);
    expect(stored(h, id).state).toBe("executed");
  });
});

describe("the engine refuses a key of the wrong length (09-FIX8, item 4)", () => {
  it.each([0, 16, 31, 33, 64])("a %i-byte key throws at construction", (bytes) => {
    const h = createHarness();
    expect(() => createApprovalEngine({ ...h.deps, proofKey: Buffer.alloc(bytes, 7) })).toThrow(
      RangeError,
    );
  });

  it("a 32-byte key is accepted, and a non-Buffer is refused", () => {
    const h = createHarness();
    expect(() => createApprovalEngine({ ...h.deps, proofKey: Buffer.alloc(32, 7) })).not.toThrow();
    expect(() =>
      createApprovalEngine({ ...h.deps, proofKey: new Uint8Array(32) as unknown as Buffer }),
    ).toThrow(RangeError);
  });
});
