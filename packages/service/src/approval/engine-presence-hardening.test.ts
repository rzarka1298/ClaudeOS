// Wave-6 hardening of the presence gate (09-FIX6A): the clock is read once for the deadline decision
// (C1), the port's answer is validated (m2), refusals are bounded on the record (M1), a hung port is cut
// off (m1), a denial cools down and a budget refusal is told apart (m3), and the paths that were never
// exercised are (m5). Kept apart from `engine-presence.test.ts` so the 09-18 wiring change to that file
// does not collide. Same doubles: the in-memory store over the EXTENDED table and a scriptable port.
import type { Clock, DecideResponse, ProposalId, StoredProposal } from "@ccc/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApprovalEngine } from "./engine.js";
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

function stored(h: Harness, id: ProposalId): StoredProposal {
  const row = h.store.get(id);
  if (row === null) throw new Error("missing row");
  return row;
}

function approveVia(
  engine: Harness["engine"],
  h: Harness,
  id: ProposalId,
  hash = hashOf(h, id),
): Promise<DecideResponse> {
  return engine.decide({
    proposalId: id,
    decision: "approve",
    payloadHash: hash,
    channelHint: "plugin",
  });
}

function approve(h: Harness, id: ProposalId, hash = hashOf(h, id)): Promise<DecideResponse> {
  return approveVia(h.engine, h, id, hash);
}

function auditDetails(h: Harness, id: ProposalId) {
  return h.store.auditFor(id).map((row) => [row.event, row.code]);
}

/** An engine over the harness's own store whose clock is whatever `source` says right now. */
function engineWithClock(h: Harness, source: () => string) {
  const clock: Clock = { now: () => source() };
  return createApprovalEngine({ ...h.deps, clock });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the deadline decision reads the clock once (C1)", () => {
  it("never approves, and never needs a presence call, when the clock steps back after the expiry shortcut fired", async () => {
    const port = createPresenceFake();
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    const deadline = stored(h, id).expiresAt;
    const earlier = new Date(Date.parse(deadline) - 1_000).toISOString();
    // The wall clock reads the deadline once and then an earlier instant: a second read must not exist
    // (or, if it does, must not be able to approve).
    let reads = 0;
    const engine = engineWithClock(h, () => (reads++ === 0 ? deadline : earlier));

    const response = await approveVia(engine, h, id);

    expect(response).toEqual({ outcome: "expired" });
    expect(stored(h, id).state).toBe("expired");
    expect(stored(h, id).decidedVia).toBeNull();
    expect(port.requests).toHaveLength(0);
    expect(h.diagnostic.executeCalls).toHaveLength(0);
  });
});

describe("a port's answer is validated, and a stepped-back clock is handled (m2)", () => {
  for (const [label, answer] of [
    ["null", null],
    ["undefined", undefined],
    ["a string", "proved"],
    ["a number", 7],
    ["an object with no kind", {}],
  ] as const) {
    it(`treats ${label} as unavailable: refused, on the record, still pending, never a thrown error`, async () => {
      const port = createPresenceFake((async () => answer) as never);
      const h = presenceHarness(port);
      const id = h.propose({ operation: WRITE, subject: "w" });
      expect(await approve(h, id)).toEqual({ outcome: "presence-unavailable" });
      expect(stored(h, id).state).toBe("pending");
      expect(auditDetails(h, id).at(-1)).toEqual(["presence-refused", "presence-unavailable"]);
    });
  }

  it("approves deterministically when the clock steps back while the prompt is up: decided_at is never before approved_at", async () => {
    const port = createPresenceFake();
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    let current = h.clock.now;
    const engine = engineWithClock(h, () => current());
    const asked = h.clock.now();
    port.script(async () => {
      // The owner proves; the wall clock now reads five seconds before the instant they were asked.
      current = () => new Date(Date.parse(asked) - 5_000).toISOString();
      return PROVED;
    });

    const response = await approveVia(engine, h, id);

    expect(response.outcome).toBe("decided");
    const row = stored(h, id);
    expect(row.decidedVia).toBe("presence");
    expect(row.approvedAt).toBe(asked);
    expect((row.decidedAt ?? "") >= (row.approvedAt ?? "z")).toBe(true);
  });
});
