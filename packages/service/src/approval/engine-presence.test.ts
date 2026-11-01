// The presence gate in `decide` (09-14, D-01, D-02, D-03, R-03, APPR-11). The gate is proven over the
// in-memory store and the EXTENDED table, because the SQL store classifies through the production
// table and cannot be handed the test-only `connector.fake-write` row (STATE decision 06-24).
import type { DecideResponse, PresenceRequest, ProposalId, StoredProposal } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  DecisionProofSchema,
  presenceMessage,
  verifyDecisionProof,
  verifyPresenceSignature,
} from "./proof.js";
import { buildOperationRegistry } from "./registry.js";
import { EXTENDED_TABLE, fakeNamed } from "./test-support/extended-table.js";
import { createHarness, type Harness, TEST_PROOF_KEY } from "./test-support/harness.js";
import {
  createPresenceFake,
  deferredPresence,
  generatePresenceKeys,
  PROVED,
  type PresenceFake,
  signMessage,
  TEST_PIN,
} from "./test-support/presence-fake.js";

const WRITE = "connector.fake-write";

function presenceHarness(port?: PresenceFake, readPin?: () => Promise<string | null>): Harness {
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
    ...(readPin === undefined ? {} : { readPin }),
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

describe("concurrency and budget (Task 2)", () => {
  it("Test 4: two concurrent approves share one presence check and one outcome", async () => {
    const port = createPresenceFake();
    const slow = deferredPresence();
    port.script(slow.script);
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    const first = approve(h, id);
    const second = approve(h, id);
    await Promise.resolve();
    slow.settle(PROVED);
    const answers = await Promise.all([first, second]);
    expect(port.requests).toHaveLength(1);
    // One decision: the first caller is told it decided, the second that it was already decided.
    expect(answers.map((a) => a.outcome).sort()).toEqual(["already-decided", "decided"]);
    expect(h.store.calls.filter((c) => c === "decide")).toHaveLength(1);
  });

  it("Test 5: the 4th prompt within a minute is refused without a port call; a minute later one reaches the port", async () => {
    const port = createPresenceFake({ kind: "denied" });
    const h = presenceHarness(port);
    const ids = [1, 2, 3, 4].map((n) => h.propose({ operation: WRITE, subject: `w${n}` }));
    for (const id of ids.slice(0, 3)) await approve(h, id);
    expect(port.requests).toHaveLength(3);
    const fourth = ids[3] as ProposalId;
    expect(await approve(h, fourth)).toEqual({ outcome: "presence-unavailable" });
    expect(port.requests).toHaveLength(3);
    expect(
      h.log.lines.some((l) => l.level === "warn" && l.fields.code === "presence-rate-limited"),
    ).toBe(true);
    expect(auditDetails(h, fourth).at(-1)).toEqual(["presence-refused", "presence-budget"]);
    h.clock.advance(60_000);
    await approve(h, h.propose({ operation: WRITE, subject: "w5" }));
    expect(port.requests).toHaveLength(4);
  });

  it("Test 6: a wrong hash and an already-expired request never reach the port", async () => {
    const port = createPresenceFake();
    const h = presenceHarness(port);
    const wrong = h.propose({ operation: WRITE, subject: "wrong" });
    expect(await approve(h, wrong, "a".repeat(64))).toEqual({ outcome: "hash-mismatch" });
    const late = h.propose({ operation: WRITE, subject: "late" });
    h.clock.advance(61_000);
    expect(await approve(h, late)).toEqual({ outcome: "expired" });
    expect(port.requests).toHaveLength(0);
    expect(stored(h, late).state).toBe("expired");
  });

  it("a request that expires while the check is up is expired after the check, not approved", async () => {
    const port = createPresenceFake(async () => {
      h.clock.advance(61_000);
      return PROVED;
    });
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    expect(await approve(h, id)).toEqual({ outcome: "expired" });
    expect(stored(h, id).state).toBe("expired");
    expect(h.diagnostic.executeCalls).toHaveLength(0);
  });

  it("never lets a late proof decide a request that was denied meanwhile", async () => {
    const port = createPresenceFake();
    const slow = deferredPresence();
    port.script(slow.script);
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    const pending = approve(h, id);
    await Promise.resolve();
    await h.engine.decide({
      proposalId: id,
      decision: "deny",
      payloadHash: hashOf(h, id),
      channelHint: "plugin",
    });
    slow.settle(PROVED);
    expect(await pending).toEqual({ outcome: "already-decided", state: "denied" });
    expect(stored(h, id).state).toBe("denied");
  });
});

describe("the store is not held across the prompt (D-01, T-09-28)", () => {
  it("has made no decide call while the port is still deciding, and exactly one after it proves", async () => {
    const callsDuringPrompt: string[] = [];
    const port = createPresenceFake(async () => {
      callsDuringPrompt.push(...h.store.calls);
      return PROVED;
    });
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    await approve(h, id);
    expect(callsDuringPrompt).not.toContain("decide");
    expect(h.store.calls.filter((call) => call === "decide")).toHaveLength(1);
  });
});

describe("no client claim changes a gated decision (D-03, T-09-25)", () => {
  it("answers presence-unavailable and leaves the request pending whatever the hint says, a forged presence included", async () => {
    for (const hint of ["plugin", "other", "presence", "Presence", undefined, "x"]) {
      const h = presenceHarness();
      const id = h.propose({ operation: WRITE, subject: "w" });
      const response = await h.engine.decide({
        proposalId: id,
        decision: "approve",
        payloadHash: hashOf(h, id),
        channelHint: hint as never,
      });
      expect(response, String(hint)).toEqual({ outcome: "presence-unavailable" });
      expect(stored(h, id).state).toBe("pending");
      expect(stored(h, id).decidedVia).toBeNull();
    }
  });

  it("records a forged presence hint as other on an operation that needs none", async () => {
    const h = presenceHarness();
    const id = h.propose({ subject: "d" });
    await h.engine.decide({
      proposalId: id,
      decision: "approve",
      payloadHash: hashOf(h, id),
      channelHint: "presence" as never,
    });
    expect(stored(h, id).decidedVia).toBe("other");
  });
});

describe("the helper's signature is verified against the pin (09-18 Task 1)", () => {
  it("Test 2 (tracer): a proved answer with a verifying signature is accepted, stored and re-verifies", async () => {
    const port = createPresenceFake();
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    const response = await approve(h, id, hashOf(h, id), "other");
    expect(response.outcome).toBe("decided");
    const row = stored(h, id);
    expect(row.decidedVia).toBe("presence");
    const proof = DecisionProofSchema.parse(JSON.parse(row.decisionProof ?? "null"));
    // ECDSA is randomised: assert the stored part verifies against the pin over this row's message.
    expect(proof.presence?.scheme).toBe("p256");
    expect(
      verifyPresenceSignature(
        TEST_PIN,
        presenceMessage({
          proposalId: id,
          operation: WRITE,
          payloadHash: row.payloadHash,
          approvedAt: row.approvedAt ?? "",
        }),
        proof.presence?.sig ?? "",
      ),
    ).toBe(true);
    expect(
      verifyDecisionProof(TEST_PROOF_KEY, row, { presenceRequired: true, pin: TEST_PIN }),
    ).toBe("valid");
  });

  async function refusedWith(
    answer: (message: string) => unknown,
    readPin?: () => Promise<string | null>,
  ): Promise<{ h: Harness; id: ProposalId; response: DecideResponse }> {
    const port = createPresenceFake((async (request: PresenceRequest) =>
      answer(presenceMessage(request))) as never);
    const h = presenceHarness(port, readPin);
    const id = h.propose({ operation: WRITE, subject: "w" });
    const response = await approve(h, id);
    return { h, id, response };
  }

  function expectRefused(r: { h: Harness; id: ProposalId; response: DecideResponse }): void {
    expect(r.response).toEqual({ outcome: "presence-unavailable" });
    expect(stored(r.h, r.id).state).toBe("pending");
    expect(stored(r.h, r.id).decidedVia).toBeNull();
    expect(auditDetails(r.h, r.id).at(-1)).toEqual(["presence-refused", "presence-unavailable"]);
    expect(r.h.store.calls).not.toContain("decide");
    expect(
      r.h.log.lines.some((l) => l.level === "warn" && l.fields.code === "presence-proof-invalid"),
    ).toBe(true);
  }

  it("Test 3a: a signature from another key is refused presence-unavailable", async () => {
    const other = generatePresenceKeys();
    expectRefused(
      await refusedWith((m) => ({
        kind: "proved",
        scheme: "p256",
        signature: signMessage(m, other),
      })),
    );
  });

  it("Test 3b: a signature over a different message is refused", async () => {
    expectRefused(
      await refusedWith((m) => ({
        kind: "proved",
        scheme: "p256",
        signature: signMessage(`${m} `),
      })),
    );
  });

  it("Test 3c (09-FIX9): with no pin the owner is never asked: the port is not called and the budget is not spent", async () => {
    for (const readPin of [
      async () => null,
      async (): Promise<string | null> => {
        throw new Error("keychain down");
      },
    ]) {
      const port = createPresenceFake();
      const h = presenceHarness(port, readPin);
      const id = h.propose({ operation: WRITE, subject: "w" });
      const response = await approve(h, id);
      expect(response).toEqual({ outcome: "presence-unavailable" });
      expect(port.requests).toHaveLength(0);
      expect(stored(h, id).state).toBe("pending");
      expect(auditDetails(h, id).at(-1)).toEqual(["presence-refused", "presence-unavailable"]);
      expect(h.store.calls).not.toContain("decide");
      expect(
        h.log.lines.some((l) => l.level === "warn" && l.fields.code === "presence-pin-unavailable"),
      ).toBe(true);
    }
  });

  it("Test 3c2 (09-FIX9): refusals for want of a pin spend no prompt budget, and a pin lost during the prompt is refused", async () => {
    let pin: string | null = null;
    const port = createPresenceFake();
    const h = presenceHarness(port, async () => pin);
    for (let i = 0; i < 5; i += 1) {
      await approve(h, h.propose({ operation: WRITE, subject: `w${i}` }));
    }
    expect(port.requests).toHaveLength(0);
    // The pin comes back: the next approve prompts at once (budget untouched) and is accepted.
    pin = TEST_PIN;
    const id = h.propose({ operation: WRITE, subject: "late" });
    expect((await approve(h, id, hashOf(h, id), "other")).outcome).toBe("decided");
    expect(port.requests).toHaveLength(1);
    // A pin that is gone when the signature has to be checked (read once before the prompt, once after).
    const lostPort = createPresenceFake();
    let reads = 0;
    const g = presenceHarness(lostPort, async () => {
      reads += 1;
      return reads === 1 ? TEST_PIN : null;
    });
    const lost = g.propose({ operation: WRITE, subject: "lost" });
    expect(await approve(g, lost)).toEqual({ outcome: "presence-unavailable" });
    expect(lostPort.requests).toHaveLength(1);
    expect(stored(g, lost).state).toBe("pending");
    expect(g.store.calls).not.toContain("decide");
  });

  it("Test 3d: scheme none under the recorded K-ATTR custody is refused", async () => {
    expectRefused(await refusedWith(() => ({ kind: "proved", scheme: "none", signature: null })));
  });

  it("the pin is read for a presence-required approve (before the prompt, and again to verify), never for a denial or an ungated approve", async () => {
    let reads = 0;
    const read = async (): Promise<string | null> => {
      reads += 1;
      return TEST_PIN;
    };
    const denyHarness = presenceHarness(createPresenceFake({ kind: "denied" }), read);
    const denyId = denyHarness.propose({ operation: WRITE, subject: "w" });
    await denyHarness.engine.decide({
      proposalId: denyId,
      decision: "deny",
      payloadHash: hashOf(denyHarness, denyId),
      channelHint: "plugin",
    });
    const plain = presenceHarness(createPresenceFake(), read);
    await approve(plain, plain.propose({ subject: "d" }));
    expect(reads).toBe(0);
    const proved = presenceHarness(createPresenceFake(), read);
    const provedId = proved.propose({ operation: WRITE, subject: "w" });
    await approve(proved, provedId, undefined, "other");
    await proved.engine.settled();
    // Before the prompt, to verify the signature, at the claim and at the last gate before execute.
    expect(reads).toBe(4);
  });
});

describe("a pin that cannot be read after the owner approved (09-FIX9, FIX15 M1)", () => {
  function unreadableFrom(readNumber: number) {
    let reads = 0;
    const port = createPresenceFake();
    const h = presenceHarness(port, async () => {
      reads += 1;
      return reads < readNumber ? TEST_PIN : null;
    });
    return h;
  }

  it("read 3 (the claim): finishes the row failed with presence-key-unreadable, never leaves it approved, and runs nothing", async () => {
    const h = unreadableFrom(3);
    const id = h.propose({ operation: WRITE, subject: "w" });
    const response = await approve(h, id, hashOf(h, id), "other");
    await h.engine.settled();
    expect(response.outcome).toBe("decided");
    expect(stored(h, id).state).toBe("failed");
    expect(stored(h, id).outcomeCode).toBe("presence-key-unreadable");
    expect(
      h.log.lines.some(
        (l) => l.level === "warn" && l.fields.code === "approval-proof-pin-unavailable",
      ),
    ).toBe(true);
    expect(h.log.lines.some((l) => l.fields.code === "approval-proof-invalid")).toBe(false);
  });

  it("read 4 (the last gate): finishes the row failed with presence-key-unreadable, never leaves it executing, and runs nothing", async () => {
    const h = unreadableFrom(4);
    const id = h.propose({ operation: WRITE, subject: "w" });
    await approve(h, id, hashOf(h, id), "other");
    await h.engine.settled();
    expect(stored(h, id).state).toBe("failed");
    expect(stored(h, id).outcomeCode).toBe("presence-key-unreadable");
    expect(h.log.lines.some((l) => l.fields.code === "approval-proof-invalid")).toBe(false);
  });
});

describe("the proposal is re-checked after the pre-prompt pin lookup (09-FIX9, Codex)", () => {
  const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

  function gatedPin() {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      release: () => release(),
      read: async (): Promise<string | null> => {
        await gate;
        return TEST_PIN;
      },
    };
  }

  const denyOf = (h: Harness, id: ProposalId) =>
    h.engine.decide({
      proposalId: id,
      decision: "deny",
      payloadHash: hashOf(h, id),
      channelHint: "plugin",
    });

  it("a deny that lands during the pin lookup means no prompt: zero port calls", async () => {
    const pin = gatedPin();
    const port = createPresenceFake();
    const h = presenceHarness(port, pin.read);
    const id = h.propose({ operation: WRITE, subject: "w" });
    const pending = approve(h, id, hashOf(h, id), "other");
    await tick();
    expect((await denyOf(h, id)).outcome).toBe("decided");
    pin.release();
    expect(await pending).toEqual({ outcome: "already-decided", state: "denied" });
    expect(port.requests).toHaveLength(0);
    expect(stored(h, id).state).toBe("denied");
  });

  it("a withdrawal during the pin lookup means no prompt either", async () => {
    const pin = gatedPin();
    const port = createPresenceFake();
    const h = presenceHarness(port, pin.read);
    const id = h.propose({ operation: WRITE, subject: "w" });
    const pending = approve(h, id, hashOf(h, id), "other");
    await tick();
    expect(h.engine.withdraw(id)).toEqual({ kind: "withdrawn" });
    pin.release();
    const response = await pending;
    expect(response.outcome).toBe("already-decided");
    expect(port.requests).toHaveLength(0);
  });

  it("a request that expires during the pin lookup is expired, not prompted for", async () => {
    const pin = gatedPin();
    const port = createPresenceFake();
    const h = presenceHarness(port, pin.read);
    const id = h.propose({ operation: WRITE, subject: "w" });
    const pending = approve(h, id, hashOf(h, id), "other");
    await tick();
    h.clock.advance(61_000);
    pin.release();
    expect(await pending).toEqual({ outcome: "expired" });
    expect(port.requests).toHaveLength(0);
    expect(stored(h, id).state).toBe("expired");
  });

  it("a prompt is still asked for when nothing changed during the lookup", async () => {
    const pin = gatedPin();
    const port = createPresenceFake();
    const h = presenceHarness(port, pin.read);
    const id = h.propose({ operation: WRITE, subject: "w" });
    const pending = approve(h, id, hashOf(h, id), "other");
    await tick();
    pin.release();
    expect((await pending).outcome).toBe("decided");
    expect(port.requests).toHaveLength(1);
  });
});

describe("a spent prompt budget is checked before any pin lookup (09-FIX9, Codex)", () => {
  function counted() {
    let reads = 0;
    return {
      reads: () => reads,
      read: async (): Promise<string | null> => {
        reads += 1;
        return TEST_PIN;
      },
    };
  }

  it("ten sequential approves on ten requests: three prompts, and no more pin reads than port calls", async () => {
    const pin = counted();
    const port = createPresenceFake({ kind: "unavailable" });
    const h = presenceHarness(port, pin.read);
    for (let i = 0; i < 10; i += 1) {
      await approve(h, h.propose({ operation: WRITE, subject: `w${i}` }));
    }
    expect(port.requests).toHaveLength(3);
    expect(pin.reads()).toBeLessThanOrEqual(port.requests.length);
    expect(pin.reads()).toBe(3);
  });

  it("ten concurrent approves: the budget is reserved before the lookup, so at most three lookups and three prompts", async () => {
    const pin = counted();
    const port = createPresenceFake({ kind: "unavailable" });
    const h = presenceHarness(port, pin.read);
    const ids = Array.from({ length: 10 }, (_, i) =>
      h.propose({ operation: WRITE, subject: `c${i}` }),
    );
    await Promise.all(ids.map((id) => approve(h, id)));
    expect(port.requests).toHaveLength(3);
    expect(pin.reads()).toBe(3);
  });

  it("a request in its denial cooldown is refused before any pin lookup", async () => {
    const pin = counted();
    const port = createPresenceFake({ kind: "denied" });
    const h = presenceHarness(port, pin.read);
    const id = h.propose({ operation: WRITE, subject: "w" });
    await approve(h, id);
    expect(pin.reads()).toBe(1);
    await approve(h, id);
    expect(port.requests).toHaveLength(1);
    expect(pin.reads()).toBe(1);
  });
});
