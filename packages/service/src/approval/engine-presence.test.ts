// The presence gate in `decide` (09-14, D-01, D-02, D-03, R-03, APPR-11). The gate is proven over the
// in-memory store and the EXTENDED table, because the SQL store classifies through the production
// table and cannot be handed the test-only `connector.fake-write` row (STATE decision 06-24).
import type { DecideResponse, ProposalId, StoredProposal } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { buildOperationRegistry } from "./registry.js";
import { EXTENDED_TABLE, fakeNamed } from "./test-support/extended-table.js";
import { createHarness, type Harness } from "./test-support/harness.js";
import { createPresenceFake, PROVED, type PresenceFake } from "./test-support/presence-fake.js";

const WRITE = "connector.fake-write";

function presenceHarness(port?: PresenceFake): Harness {
  return createHarness({
    table: EXTENDED_TABLE,
    registry: ([a, b]) =>
      buildOperationRegistry(
        [a, b, fakeNamed("connector.fake-send"), fakeNamed(WRITE)].flatMap((f) =>
          f === undefined ? [] : [f.definition],
        ),
        EXTENDED_TABLE,
      ),
    ...(port === undefined ? {} : { presence: port }),
  });
}

function hashOf(h: Harness, id: ProposalId): string {
  return h.store.get(id)?.payloadHash ?? "";
}

function approve(
  h: Harness,
  id: ProposalId,
  hash = hashOf(h, id),
  via: "plugin" | "other" = "plugin",
) {
  return h.engine.decide({
    proposalId: id,
    decision: "approve",
    payloadHash: hash,
    channelHint: via,
  });
}

function stored(h: Harness, id: ProposalId): StoredProposal {
  const row = h.store.get(id);
  if (row === null) throw new Error("missing row");
  return row;
}

function auditDetails(h: Harness, id: ProposalId) {
  return h.store.auditFor(id).map((row) => [row.event, row.code]);
}

describe("the presence gate (Task 1)", () => {
  it("Test 1 (tracer): a token-only approve of a connector-class request is refused, stays pending and is on the record", async () => {
    const h = presenceHarness();
    const id = h.propose({ operation: WRITE, subject: "w" });
    const response = await approve(h, id);
    expect(response).toEqual({ outcome: "presence-unavailable" });
    expect(stored(h, id).state).toBe("pending");
    expect(auditDetails(h, id).at(-1)).toEqual(["presence-refused", "presence-unavailable"]);
    expect(h.store.calls).not.toContain("claim");
    expect(h.store.calls).not.toContain("decide");
    expect(h.diagnostic.executeCalls).toHaveLength(0);
  });

  it("Test 2: a denied presence check refuses the approve with presence-denied and the same facts", async () => {
    const port = createPresenceFake({ kind: "denied" });
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    const response: DecideResponse = await approve(h, id);
    expect(response).toEqual({ outcome: "presence-denied" });
    expect(stored(h, id).state).toBe("pending");
    expect(auditDetails(h, id).at(-1)).toEqual(["presence-refused", "presence-denied"]);
    expect(port.requests).toHaveLength(1);
    expect(h.store.calls).not.toContain("decide");
  });

  it("Test 3: a proved presence check approves with decided_via presence and the instant the port vouched for", async () => {
    const port = createPresenceFake();
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    // The owner takes ten seconds over the prompt: approved_at is the instant asked, decided_at the later one.
    port.script(async () => {
      h.clock.advance(10_000);
      return PROVED;
    });
    const asked = h.clock.now();
    const response = await approve(h, id, hashOf(h, id), "other");
    expect(response.outcome).toBe("decided");
    const row = stored(h, id);
    expect(row.decidedVia).toBe("presence");
    expect(row.approvedAt).toBe(asked);
    expect(row.decidedAt).not.toBe(asked);
    expect(port.requests).toEqual([
      { proposalId: id, operation: WRITE, payloadHash: row.payloadHash, approvedAt: asked },
    ]);
  });

  it("Test 4 (R-03): a deny on a presence-required request is decided at once and never asks", async () => {
    const port = createPresenceFake({ kind: "denied" });
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    const response = await h.engine.decide({
      proposalId: id,
      decision: "deny",
      payloadHash: hashOf(h, id),
      channelHint: "plugin",
    });
    expect(response.outcome).toBe("decided");
    expect(stored(h, id).state).toBe("denied");
    expect(port.requests).toHaveLength(0);
    expect(h.store.calls).not.toContain("recordDecisionRefusal");
  });

  it("Test 5 (D-02): presence none operations never call the port and decide as before", async () => {
    const port = createPresenceFake({ kind: "denied" });
    const h = presenceHarness(port);
    const terminate = h.propose({ operation: "session.force-terminate", subject: "t" });
    const diagnostic = h.propose({ subject: "d" });
    await approve(h, terminate);
    await approve(h, diagnostic);
    expect(port.requests).toHaveLength(0);
    expect(stored(h, terminate).decidedVia).toBe("plugin");
    expect(stored(h, diagnostic).decidedVia).toBe("plugin");
    expect(stored(h, diagnostic).state).not.toBe("pending");
  });
});

describe("a port that misbehaves fails closed (Rule 2)", () => {
  it("treats a throwing port as unavailable", async () => {
    const port = createPresenceFake(async () => {
      throw new Error("helper exploded");
    });
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    expect(await approve(h, id)).toEqual({ outcome: "presence-unavailable" });
    expect(stored(h, id).state).toBe("pending");
    expect(JSON.stringify(h.log.lines)).not.toContain("helper exploded");
  });

  it("treats an unrecognised answer as unavailable", async () => {
    const port = createPresenceFake((async () => ({ kind: "maybe" })) as unknown as Parameters<
      typeof createPresenceFake
    >[0]);
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    expect(await approve(h, id)).toEqual({ outcome: "presence-unavailable" });
    expect(stored(h, id).state).toBe("pending");
  });
});
