// Wave-6 hardening of the presence gate (09-FIX6A): the clock is read once for the deadline decision
// (C1), the port's answer is validated (m2), refusals are bounded on the record (M1), a hung port is cut
// off (m1), a denial cools down and a budget refusal is told apart (m3), and the paths that were never
// exercised are (m5). Kept apart from `engine-presence.test.ts` so the 09-18 wiring change to that file
// does not collide. Same doubles: the in-memory store over the EXTENDED table and a scriptable port.
import {
  type Clock,
  type DecideResponse,
  PRESENCE_PROMPT_TIMEOUT_MS,
  type ProposalId,
  type StoredProposal,
} from "@ccc/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApprovalEngine,
  PRESENCE_DENIED_COOLDOWN_MS,
  PRESENCE_ENGINE_TIMEOUT_MS,
} from "./engine.js";
import { verifyDecisionProof } from "./proof.js";
import { buildOperationRegistry } from "./registry.js";
import { EXTENDED_TABLE, fakeNamed } from "./test-support/extended-table.js";
import { createHarness, type Harness, TEST_PROOF_KEY } from "./test-support/harness.js";
import {
  createPresenceFake,
  deferredPresence,
  PROVED,
  type PresenceFake,
  TEST_PIN,
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
    // The proof covers the instant the owner vouched for, not the clamped clock read (09-FIX8, M5).
    expect(
      verifyDecisionProof(TEST_PROOF_KEY, row, { presenceRequired: true, pin: TEST_PIN }),
    ).toBe("valid");
  });
});

describe("a token-holder looping on a pending request cannot flood the record or the log (M1)", () => {
  it("writes one row per reason (unavailable, then budget) and a handful of warnings for fifty refusals at the same instant, and the owner still sees `requested`", async () => {
    const port = createPresenceFake({ kind: "unavailable" });
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    for (let i = 0; i < 50; i += 1) {
      expect(await approve(h, id)).toEqual({ outcome: "presence-unavailable" });
    }
    const refusals = h.store.auditFor(id).filter((row) => row.event === "presence-refused");
    expect(refusals.map((row) => row.code)).toEqual(["presence-unavailable", "presence-budget"]);
    expect(h.store.auditFor(id)[0]?.event).toBe("requested");
    const warnings = h.log.lines.filter((line) => line.level === "warn");
    expect(warnings.length).toBeLessThanOrEqual(3);
  });

  it("holds the row count and the warnings at the cap when the refusals are spaced past the window", async () => {
    const port = createPresenceFake({ kind: "denied" });
    const h = presenceHarness(port);
    // Long-lived row: this test is about the record, not about expiry.
    const id = h.propose({ operation: WRITE, subject: "w", requestedTtlMs: 60_000 });
    let rows = 0;
    for (let i = 0; i < 30 && stored(h, id).state === "pending"; i += 1) {
      await approve(h, id);
      h.clock.advance(1_500);
      rows = h.store.auditFor(id).filter((row) => row.event === "presence-refused").length;
    }
    expect(rows).toBeLessThanOrEqual(8);
    expect(h.store.auditFor(id)[0]?.event).toBe("requested");
    expect(h.log.lines.filter((l) => l.fields.code === "presence-refused").length).toBe(rows);
  });
});

describe("a hung port cannot wedge the proposal or shutdown (m1)", () => {
  it("cuts a never-settling port off after the prompt ceiling plus a margin: unavailable, still pending, joiners released, a retry can ask again", async () => {
    vi.useFakeTimers();
    const port = createPresenceFake(() => new Promise(() => undefined));
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    // The client waits PROMPT + 10 s; the engine must answer inside that.
    expect(PRESENCE_ENGINE_TIMEOUT_MS).toBeGreaterThan(PRESENCE_PROMPT_TIMEOUT_MS);
    expect(PRESENCE_ENGINE_TIMEOUT_MS).toBeLessThan(PRESENCE_PROMPT_TIMEOUT_MS + 10_000);

    const first = approve(h, id);
    const joiner = approve(h, id);
    await vi.advanceTimersByTimeAsync(PRESENCE_ENGINE_TIMEOUT_MS);

    expect(await first).toEqual({ outcome: "presence-unavailable" });
    expect(await joiner).toEqual({ outcome: "presence-unavailable" });
    expect(stored(h, id).state).toBe("pending");
    expect(auditDetails(h, id).at(-1)).toEqual(["presence-refused", "presence-unavailable"]);
    expect(
      h.log.lines.some((l) => l.level === "warn" && l.fields.code === "presence-check-timeout"),
    ).toBe(true);

    // The flight is gone: a later approve starts a fresh check (the port is asked a second time).
    h.clock.advance(1_000);
    const retry = approve(h, id);
    await vi.advanceTimersByTimeAsync(0);
    expect(port.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(PRESENCE_ENGINE_TIMEOUT_MS);
    await retry;
  });

  it("releases the caller and settled() when shutdown begins with the prompt up, and decides nothing", async () => {
    const port = createPresenceFake();
    const slow = deferredPresence();
    port.script(slow.script);
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    let released: DecideResponse | undefined;
    const pending = approve(h, id).then((response) => {
      released = response;
    });
    await Promise.resolve();

    h.engine.beginShutdown();
    const outcome = await Promise.race([
      h.engine.settled().then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 200)),
    ]);

    expect(outcome).toBe("settled");
    await pending;
    expect(released).toEqual({ outcome: "operation-reserved" });
    expect(stored(h, id).state).toBe("pending");
    // The prompt answering afterwards changes nothing.
    slow.settle(PROVED);
    await Promise.resolve();
    expect(h.store.calls).not.toContain("decide");
    expect(h.store.calls).not.toContain("recordDecisionRefusal");
  });
});

describe("an attacker cannot starve the owner's budget, and a budget refusal is told apart (m3)", () => {
  it("answers a repeat approve of a just-denied proposal from a cooldown: no prompt, no budget spent, a distinct audit reason", async () => {
    const port = createPresenceFake({ kind: "denied" });
    const h = presenceHarness(port);
    const attacked = h.propose({ operation: WRITE, subject: "attacked" });
    for (let i = 0; i < 20; i += 1) {
      expect(await approve(h, attacked)).toEqual({ outcome: "presence-denied" });
    }
    // One real prompt; the other nineteen were cooled down without touching the port or the budget.
    expect(port.requests).toHaveLength(1);
    expect(
      auditDetails(h, attacked).filter(
        ([event, code]) => event === "presence-refused" && code === "presence-cooldown",
      ),
    ).toHaveLength(1);

    // The attacker spent exactly one prompt of the three-a-minute budget, not all of it: the owner's real
    // approvals of two other requests still reach the port.
    port.script(PROVED);
    for (const subject of ["a", "b"]) {
      const other = h.propose({ operation: WRITE, subject });
      expect((await approve(h, other)).outcome).toBe("decided");
    }
    expect(port.requests).toHaveLength(3);
  });

  it("FIX15 m4: shutdown aborts the signal handed to the in-flight presence check, so the helper is killed", async () => {
    const pending = deferredPresence();
    const port = createPresenceFake(pending.script);
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    const inFlight = approve(h, id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const signal = port.signals[0];
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
    h.engine.beginShutdown();
    expect(signal?.aborted).toBe(true);
    expect(await inFlight).toEqual({ outcome: "operation-reserved" });
  });

  it("asks again once the cooldown has passed", async () => {
    const port = createPresenceFake({ kind: "denied" });
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w", requestedTtlMs: 60_000 });
    await approve(h, id);
    h.clock.advance(PRESENCE_DENIED_COOLDOWN_MS - 1);
    expect(await approve(h, id)).toEqual({ outcome: "presence-denied" });
    expect(port.requests).toHaveLength(1);
    h.clock.advance(1);
    await approve(h, id);
    expect(port.requests).toHaveLength(2);
  });

  it("records a budget refusal as presence-budget (the client still reads presence-unavailable) and warns presence-rate-limited", async () => {
    const port = createPresenceFake({ kind: "unavailable" });
    const h = presenceHarness(port);
    const ids = [1, 2, 3, 4].map((n) => h.propose({ operation: WRITE, subject: `b${n}` }));
    for (const id of ids.slice(0, 3)) await approve(h, id);
    const fourth = ids[3] as ProposalId;
    expect(await approve(h, fourth)).toEqual({ outcome: "presence-unavailable" });
    expect(port.requests).toHaveLength(3);
    expect(auditDetails(h, fourth).at(-1)).toEqual(["presence-refused", "presence-budget"]);
    expect(
      h.log.lines.some((l) => l.level === "warn" && l.fields.code === "presence-rate-limited"),
    ).toBe(true);
    // An ordinary unavailable stays presence-unavailable on the record.
    expect(auditDetails(h, ids[0] as ProposalId).at(-1)).toEqual([
      "presence-refused",
      "presence-unavailable",
    ]);
  });
});

describe("paths inside the flight that were never exercised (m5)", () => {
  it("releases a joiner of a refused flight with the same refusal, one port call and one record", async () => {
    const port = createPresenceFake();
    const slow = deferredPresence();
    port.script(slow.script);
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    const first = approve(h, id);
    const joiner = approve(h, id);
    await Promise.resolve();
    slow.settle({ kind: "denied" });
    expect(await first).toEqual({ outcome: "presence-denied" });
    expect(await joiner).toEqual({ outcome: "presence-denied" });
    expect(port.requests).toHaveLength(1);
    expect(h.store.calls.filter((call) => call === "recordDecisionRefusal")).toHaveLength(1);
  });

  for (const failing of ["decide", "recordDecisionRefusal"] as const) {
    it(`a store.${failing} that throws inside the flight rejects the caller and the joiner, clears the flight, and a retry asks afresh`, async () => {
      const port = createPresenceFake(failing === "decide" ? PROVED : { kind: "unavailable" });
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = presenceHarness(port);
      let broken = true;
      const engine = createApprovalEngine({
        ...h.deps,
        store: {
          ...h.store,
          [failing]: (...args: unknown[]) => {
            if (broken) throw new Error("store down");
            return (h.store[failing] as (...a: unknown[]) => unknown)(...args);
          },
        } as typeof h.store,
      });
      const id = h.propose({ operation: WRITE, subject: "w" });
      port.script(async () => {
        await gate;
        return failing === "decide" ? PROVED : { kind: "unavailable" };
      });

      const first = approveVia(engine, h, id);
      const joiner = approveVia(engine, h, id);
      const settled = Promise.allSettled([first, joiner]);
      await Promise.resolve();
      release();
      const results = await settled;
      expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
      expect(stored(h, id).state).toBe("pending");
      expect(port.requests).toHaveLength(1);

      // The flight map was cleaned: with the store healthy again a retry runs a second check.
      broken = false;
      port.script(PROVED);
      const retry = await approveVia(engine, h, id);
      expect(port.requests).toHaveLength(2);
      expect(retry.outcome).toBe("decided");
    });
  }

  it("hands the store the caller's payload hash, not a copy of the stored one", async () => {
    const port = createPresenceFake();
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    const seen: string[] = [];
    const engine = createApprovalEngine({
      ...h.deps,
      store: {
        ...h.store,
        decide: (input: Parameters<typeof h.store.decide>[0]) => {
          seen.push(input.expectedHash);
          return h.store.decide(input);
        },
      } as typeof h.store,
    });
    const hash = hashOf(h, id);
    expect((await approveVia(engine, h, id, hash)).outcome).toBe("decided");
    expect(seen).toEqual([hash]);
  });
});

describe("review follow-ups from Codex run 20261029T023514538Z", () => {
  it("starts the denial cooldown when the denial is received, not when the prompt was asked", async () => {
    const port = createPresenceFake();
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    // The owner takes 25 s over the prompt and then denies. Counted from the ask, the 30 s cooldown would
    // be over six seconds later; counted from the denial it still has 24 s to run.
    port.script(async () => {
      h.clock.advance(25_000);
      return { kind: "denied" };
    });
    expect(await approve(h, id)).toEqual({ outcome: "presence-denied" });
    expect(port.requests).toHaveLength(1);

    h.clock.advance(6_000);
    expect(await approve(h, id)).toEqual({ outcome: "presence-denied" });
    expect(port.requests).toHaveLength(1);
    expect(auditDetails(h, id).at(-1)).toEqual(["presence-refused", "presence-cooldown"]);
  });

  it("never starts a cooldown earlier than the ask plus the cooldown when the clock steps back during the prompt", async () => {
    const port = createPresenceFake();
    const h = presenceHarness(port);
    const id = h.propose({ operation: WRITE, subject: "w" });
    const asked = h.clock.now();
    let current = h.clock.now;
    const engine = engineWithClock(h, () => current());
    port.script(async () => {
      current = () => new Date(Date.parse(asked) - 20_000).toISOString();
      return { kind: "denied" };
    });
    expect(await approveVia(engine, h, id)).toEqual({ outcome: "presence-denied" });
    // 29 s after the ask: still cooling down.
    current = () => new Date(Date.parse(asked) + PRESENCE_DENIED_COOLDOWN_MS - 1_000).toISOString();
    expect(await approveVia(engine, h, id)).toEqual({ outcome: "presence-denied" });
    expect(port.requests).toHaveLength(1);
  });

  it("holds no shutdown subscription once a check has completed, and shutdown still abandons an in-flight one", async () => {
    const port = createPresenceFake({ kind: "unavailable" });
    const h = presenceHarness(port);
    const engine = createApprovalEngine({ ...h.deps });
    for (let i = 0; i < 25; i += 1) {
      const id = h.propose({ operation: WRITE, subject: `s${i}` });
      await approveVia(engine, h, id);
      h.engine.withdraw(id);
      h.clock.advance(61_000);
    }
    expect(port.requests).toHaveLength(25);
    expect(engine.shutdownSubscriptions()).toBe(0);

    const slow = deferredPresence();
    port.script(slow.script);
    const id = h.propose({ operation: WRITE, subject: "last" });
    const pending = approveVia(engine, h, id);
    // The pin is read before the port is asked (09-FIX9), so let the check reach the port.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(port.requests).toHaveLength(26);
    expect(engine.shutdownSubscriptions()).toBe(1);
    engine.beginShutdown();
    expect(await pending).toEqual({ outcome: "operation-reserved" });
    expect(engine.shutdownSubscriptions()).toBe(0);
  });
});
