// The presence gate in `decide` (09-14, D-01, D-02, D-03, R-03, APPR-11). The gate is proven over the
// in-memory store and the EXTENDED table, because the SQL store classifies through the production
// table and cannot be handed the test-only `connector.fake-write` row (STATE decision 06-24).
import type { DecideResponse, ProposalId, StoredProposal } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { buildOperationRegistry } from "./registry.js";
import { EXTENDED_TABLE, fakeNamed } from "./test-support/extended-table.js";
import { createHarness, type Harness } from "./test-support/harness.js";
import {
  createPresenceFake,
  deferredPresence,
  PROVED,
  type PresenceFake,
} from "./test-support/presence-fake.js";

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
