// The engine signs every approval (09-17, D-03, APPR-12). A proof made with the engine's own key sits
// in the stored row of every approve and in no deny; the key is required, so no construction site can
// skip the proof.
import type { ProposalId, StoredProposal } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { verifyDecisionProof } from "./proof.js";
import { buildOperationRegistry } from "./registry.js";
import { EXTENDED_TABLE, fakeNamed } from "./test-support/extended-table.js";
import { createHarness, type Harness, TEST_PROOF_KEY } from "./test-support/harness.js";
import { createPresenceFake } from "./test-support/presence-fake.js";

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
    expect(verifyDecisionProof(TEST_PROOF_KEY, row)).toBe("valid");
    // Another key does not verify it.
    expect(verifyDecisionProof(Buffer.alloc(32, 9), row)).toBe("invalid");
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
      return { kind: "proved", scheme: "none", signature: null };
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
    expect(verifyDecisionProof(TEST_PROOF_KEY, row)).toBe("valid");
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
    expect(verifyDecisionProof(TEST_PROOF_KEY, row)).toBe("valid");
  });
});
