import type { ClaimFacts, ExecuteOutcome, ProposalId, StoredProposal } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { recomputeFromStored } from "./canonical-hash.js";
import { decisionMacFields, presenceMessage, signDecisionProof } from "./proof.js";
import { buildOperationRegistry } from "./registry.js";
import { EXTENDED_TABLE, fakeNamed } from "./test-support/extended-table.js";
import type { FakeOperation } from "./test-support/fake-operation.js";
import {
  createHarness,
  type Harness,
  type LoggedLine,
  TEST_PROOF_KEY,
} from "./test-support/harness.js";
import { codesOf, logViolations } from "./test-support/log-allow-list.js";
import { generatePresenceKeys, signMessage, TEST_PIN } from "./test-support/presence-fake.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

/** The proof text the engine would have stored for `row` approved at `approvedAt` through `via`. */
function proofFor(
  row: Pick<StoredProposal, "proposalId" | "operation" | "payloadHash">,
  approvedAt: string,
  via: "plugin" | "other" | "presence" = "plugin",
  key: Buffer = TEST_PROOF_KEY,
): string {
  const fields = decisionMacFields({ ...row, approvedAt, decidedVia: via });
  if (fields === null) throw new Error("fixture: no covered fields");
  return signDecisionProof(key, fields, null);
}

/** Approves a pending request in the store without running anything: the first half of a crash window. */
function approveInStore(h: Harness, id: ProposalId, proof: string | null = null): StoredProposal {
  const stored = h.store.get(id);
  if (stored === null) throw new Error("fixture: no row");
  const now = h.clock.now();
  const result = h.store.decide({
    proposalId: id,
    decision: "approve",
    expectedHash: stored.payloadHash,
    now,
    approvedAt: now,
    via: "plugin",
    decisionProof: proof ?? proofFor(stored, now),
  });
  if (result.kind !== "approved") throw new Error(`fixture: not approved: ${result.kind}`);
  return result.proposal;
}

/** Approves with NO proof, as a row written by something other than the engine would be. */
function approveUnsigned(h: Harness, id: ProposalId): StoredProposal {
  const stored = h.store.get(id);
  if (stored === null) throw new Error("fixture: no row");
  const now = h.clock.now();
  const result = h.store.decide({
    proposalId: id,
    decision: "approve",
    expectedHash: stored.payloadHash,
    now,
    via: "plugin",
  });
  if (result.kind !== "approved") throw new Error(`fixture: not approved: ${result.kind}`);
  return result.proposal;
}

/** Leaves a request `executing` with one attempt and no execution having run: the service died mid-effect. */
function leaveExecuting(h: Harness, id: ProposalId, facts: ClaimFacts = { pid: 4242 }): void {
  approveInStore(h, id);
  const claim = h.store.claim(id, facts, h.clock.now());
  if (claim.kind !== "claimed") throw new Error("fixture: claim lost");
}

let rawCounter = 0;

/** A request that was claimed with retry policy `never` (the extended table's fake connector), inserted as the store would hold it. */
function rawRow(
  h: Harness,
  from: ProposalId,
  over: Partial<StoredProposal> & { operation: string },
): ProposalId {
  const base = h.store.get(from);
  if (base === null) throw new Error("fixture: no base row");
  rawCounter += 1;
  const id = `r${rawCounter.toString(36).padStart(24, "0")}` as ProposalId;
  const row: StoredProposal = {
    ...base,
    proposalId: id,
    dedupeKey: `${over.operation}:${id}`,
    state: "executing",
    attempts: 1,
    approvedAt: base.approvedAt ?? h.clock.now(),
    claimFacts: {},
    ...over,
  };
  const hash = recomputeFromStored(row);
  const payloadHash = over.payloadHash ?? hash ?? row.payloadHash;
  const decidedVia = row.decidedVia ?? "plugin";
  // A row the engine could have made: it carries its own proof unless the caller says otherwise.
  const decisionProof =
    "decisionProof" in over
      ? over.decisionProof
      : proofFor(
          { proposalId: id, operation: row.operation, payloadHash },
          row.approvedAt ?? "",
          decidedVia,
        );
  h.store.insertRaw({ ...row, payloadHash, decidedVia, decisionProof });
  return id;
}

function lastAudit(h: Harness, id: ProposalId): string | undefined {
  return h.store.auditEvents(id).at(-1);
}

function stateOf(h: Harness, id: ProposalId): string | undefined {
  return h.store.get(id)?.state;
}

/** Records the order `reconcile` and `execute` were called in. */
function trackOrder(op: FakeOperation): string[] {
  const order: string[] = [];
  const { execute, reconcile } = op.definition;
  op.definition.execute = async (...args) => {
    order.push("execute");
    return execute.apply(op.definition, args);
  };
  op.definition.reconcile = async (...args) => {
    order.push("reconcile");
    return reconcile.apply(op.definition, args);
  };
  return order;
}

describe("proven effect (Task 2, Test 1)", () => {
  it("finishes executed with the reconciled flag and the evidence code, and never calls execute", async () => {
    const h = createHarness();
    const id = h.propose();
    leaveExecuting(h, id);
    h.diagnostic.verdicts.push({ kind: "effect-proven", evidence: "effect-row-found" });

    const summary = await h.engine.recover();
    await h.engine.settled();

    const stored = h.store.get(id);
    expect(stored?.state).toBe("executed");
    expect(stored?.outcomeCode).toBe("executed");
    expect(h.store.auditEvents(id)).toContain("reconciled-executed");
    expect(h.store.auditEvents(id)).not.toContain("retried-after-restart");
    expect(h.store.finishes.at(-1)).toMatchObject({
      state: "executed",
      reconciled: true,
      evidence: "effect-row-found",
    });
    expect(h.diagnostic.executeCalls).toHaveLength(0);
    expect(h.diagnostic.reconcileCalls).toHaveLength(1);
    expect(h.diagnostic.reconcileCalls[0]?.context).toEqual({
      idempotencyKey: id,
      claimFacts: { pid: 4242 },
      attempt: 1,
    });
    expect(summary.reconciled).toBe(1);
    expect(
      h.published.some((e) => e.approval.proposalId === id && e.approval.state === "executed"),
    ).toBe(true);
  });
});

describe("one retry, same key, fresh token (Task 2, Test 2)", () => {
  it("consults reconcile first, then executes attempt 2 with the same key and a token built from the original approval time", async () => {
    const h = createHarness();
    const id = h.propose();
    leaveExecuting(h, id);
    const approvedAt = h.store.get(id)?.approvedAt ?? "";
    const order = trackOrder(h.diagnostic);
    h.diagnostic.verdicts.push({ kind: "effect-absent" });
    h.clock.advance(1 * MINUTE);

    const summary = await h.engine.recover();
    await h.engine.settled();

    expect(order).toEqual(["reconcile", "execute"]);
    expect(h.diagnostic.executeCalls).toHaveLength(1);
    const call = h.diagnostic.executeCalls[0];
    expect(call?.context.attempt).toBe(2);
    expect(call?.context.idempotencyKey).toBe(id);
    expect(Object.isFrozen(call?.token)).toBe(true);
    expect(call?.token.proposalId).toBe(id);
    expect(call?.token.operation).toBe("diagnostic.test");
    expect(call?.token.subject).toBe("diagnostic");
    // The earlier of the proposal's own expiry (24 hours) and approval time plus the maximum age (5 minutes).
    expect(call?.token.expiresAt).toBe(new Date(Date.parse(approvedAt) + 5 * MINUTE).toISOString());
    const stored = h.store.get(id);
    expect(stored?.state).toBe("executed");
    expect(stored?.attempts).toBe(2);
    const audit = h.store.auditEvents(id);
    expect(audit.indexOf("retried-after-restart")).toBeGreaterThan(audit.indexOf("claimed"));
    expect(audit.indexOf("executed")).toBeGreaterThan(audit.indexOf("retried-after-restart"));
    expect(summary.retried).toBe(1);
    expect(h.diagnostic.effects.size).toBe(1);
  });

  it("each retry gets its own token object", async () => {
    const h = createHarness();
    const a = h.propose({ subject: "a" });
    const b = h.propose({ subject: "b" });
    leaveExecuting(h, a);
    leaveExecuting(h, b);
    h.diagnostic.verdicts.push({ kind: "effect-absent" }, { kind: "effect-absent" });
    await h.engine.recover();
    await h.engine.settled();
    const tokens = h.diagnostic.executeCalls.map((call) => call.token);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });
});

describe("late refusal (Task 2, Test 3)", () => {
  const REFUSALS: ExecuteOutcome[] = [
    { kind: "refused", reason: "process-ended" },
    { kind: "refused", reason: "run-not-found" },
    { kind: "refused", reason: "identity-mismatch" },
    { kind: "failed", reason: "execution-failed" },
    { kind: "failed", reason: "capability-refused" },
  ];

  for (const refusal of REFUSALS) {
    const label = `${refusal.kind}:${refusal.kind === "executed" ? "" : refusal.reason}`;

    it(`${label} on the retry asks reconcile again: proven is executed (reconciled)`, async () => {
      const h = createHarness();
      const id = h.propose();
      leaveExecuting(h, id);
      h.diagnostic.verdicts.push(
        { kind: "effect-absent" },
        { kind: "effect-proven", evidence: "process-gone" },
      );
      h.diagnostic.outcomes.push(refusal);
      await h.engine.recover();
      await h.engine.settled();
      expect(h.diagnostic.reconcileCalls).toHaveLength(2);
      expect(h.diagnostic.executeCalls).toHaveLength(1);
      expect(stateOf(h, id)).toBe("executed");
      expect(lastAudit(h, id)).toBe("reconciled-executed");
      expect(h.store.finishes.at(-1)).toMatchObject({ reconciled: true, evidence: "process-gone" });
    });

    it(`${label} on the retry is unknown unless proven, never failed`, async () => {
      for (const second of [
        { kind: "effect-absent" } as const,
        { kind: "unknown", reason: "run-unreadable" } as const,
        new Error("reconcile broke"),
      ]) {
        const h = createHarness();
        const id = h.propose();
        leaveExecuting(h, id);
        h.diagnostic.verdicts.push({ kind: "effect-absent" }, second);
        h.diagnostic.outcomes.push(refusal);
        await h.engine.recover();
        await h.engine.settled();
        expect(stateOf(h, id)).toBe("unknown");
        expect(lastAudit(h, id)).toBe("outcome-unknown");
        expect(h.store.finishes.every((finish) => finish.state !== "failed")).toBe(true);
      }
    });
  }

  it("a rejected retry execute finishes unknown and logs no message text", async () => {
    const h = createHarness();
    const id = h.propose();
    leaveExecuting(h, id);
    h.diagnostic.verdicts.push({ kind: "effect-absent" });
    h.diagnostic.outcomes.push(new Error("disk path /Users/USERNAME/secret"));
    await h.engine.recover();
    await h.engine.settled();
    expect(stateOf(h, id)).toBe("unknown");
    expect(h.store.get(id)?.outcomeCode).toBe("executor-threw");
    expect(JSON.stringify(h.log.lines)).not.toContain("secret");
  });
});

describe("never retried (Task 2, Test 4)", () => {
  function expectUnknownWithoutExecute(h: Harness, id: ProposalId, op: FakeOperation): void {
    expect(stateOf(h, id)).toBe("unknown");
    expect(lastAudit(h, id)).toBe("outcome-unknown");
    expect(op.executeCalls).toHaveLength(0);
    expect(h.store.calls).not.toContain("beginRetry");
    expect(h.store.finishes.every((finish) => finish.state !== "failed")).toBe(true);
  }

  it("effect-absent on a retry-never operation", async () => {
    const send = fakeNamed("connector.fake-send");
    const h = createHarness({
      registry: ([d, t]) =>
        buildOperationRegistry(
          [d, t, send, fakeNamed("connector.fake-write")]
            .map((f) => f?.definition)
            .filter((def) => def !== undefined),
          EXTENDED_TABLE,
        ),
    });
    const base = h.propose();
    const id = rawRow(h, base, { operation: "connector.fake-send" });
    send.verdicts.push({ kind: "effect-absent" });
    await h.engine.recover();
    await h.engine.settled();
    expect(send.reconcileCalls).toHaveLength(1);
    expectUnknownWithoutExecute(h, id, send);
  });

  it("an unknown verdict", async () => {
    const h = createHarness();
    const id = h.propose();
    leaveExecuting(h, id);
    h.diagnostic.verdicts.push({ kind: "unknown", reason: "run-unreadable" });
    await h.engine.recover();
    await h.engine.settled();
    expectUnknownWithoutExecute(h, id, h.diagnostic);
  });

  it("a reconcile that throws", async () => {
    const h = createHarness();
    const id = h.propose();
    leaveExecuting(h, id);
    h.diagnostic.verdicts.push(new Error("reconcile broke /Users/USERNAME"));
    await h.engine.recover();
    await h.engine.settled();
    expectUnknownWithoutExecute(h, id, h.diagnostic);
    expect(h.store.get(id)?.outcomeCode).toBe("reconcile-threw");
    expect(JSON.stringify(h.log.lines)).not.toContain("USERNAME");
  });

  it("attempts already at two", async () => {
    const h = createHarness();
    const id = h.propose();
    leaveExecuting(h, id);
    expect(h.store.beginRetry(id, h.clock.now()).kind).toBe("retrying");
    h.store.calls.length = 0;
    h.diagnostic.verdicts.push({ kind: "effect-absent" });
    await h.engine.recover();
    await h.engine.settled();
    expectUnknownWithoutExecute(h, id, h.diagnostic);
  });

  it("a time past the maximum approval age", async () => {
    const h = createHarness();
    const id = h.propose();
    leaveExecuting(h, id);
    h.clock.advance(5 * MINUTE);
    h.diagnostic.verdicts.push({ kind: "effect-absent" });
    await h.engine.recover();
    await h.engine.settled();
    expectUnknownWithoutExecute(h, id, h.diagnostic);
  });

  it("a time past the proposal's own expiry, even inside the maximum approval age", async () => {
    const h = createHarness();
    const id = h.propose({ requestedTtlMs: 1 * MINUTE + 30 * SECOND });
    h.clock.advance(1 * MINUTE);
    leaveExecuting(h, id);
    h.clock.advance(1 * MINUTE);
    h.diagnostic.verdicts.push({ kind: "effect-absent" });
    await h.engine.recover();
    await h.engine.settled();
    expectUnknownWithoutExecute(h, id, h.diagnostic);
  });

  it("a row whose stored payload no longer matches its hash is unknown and never reconciled or run", async () => {
    const h = createHarness();
    const id = h.propose({ payload: { note: "original" } });
    leaveExecuting(h, id);
    h.store.tamperPayloadJson(id, '{"note":"edited"}');
    await h.engine.recover();
    await h.engine.settled();
    expectUnknownWithoutExecute(h, id, h.diagnostic);
    expect(h.diagnostic.reconcileCalls).toHaveLength(0);
    expect(h.store.get(id)?.outcomeCode).toBe("integrity-check-failed");
  });
});

describe("unknown is terminal (Task 2, Test 5)", () => {
  it("a later recovery selects no unknown, executed, failed or decided request and writes nothing", async () => {
    const h = createHarness();
    const ids = {
      unknown: h.propose({ subject: "u" }),
      executed: h.propose({ subject: "e" }),
      denied: h.propose({ subject: "d" }),
      lapsed: h.propose({ subject: "l" }),
    };
    leaveExecuting(h, ids.unknown);
    leaveExecuting(h, ids.executed);
    h.diagnostic.verdicts.push(
      { kind: "unknown", reason: "run-unreadable" },
      { kind: "effect-proven", evidence: "effect-row-found" },
    );
    h.store.decide({
      proposalId: ids.denied,
      decision: "deny",
      expectedHash: h.store.get(ids.denied)?.payloadHash ?? "",
      now: h.clock.now(),
      via: "plugin",
    });
    approveInStore(h, ids.lapsed);
    h.clock.advance(10 * MINUTE);
    await h.engine.recover();
    await h.engine.settled();
    expect(Object.values(ids).map((id) => stateOf(h, id))).toEqual([
      "unknown",
      "executed",
      "denied",
      "lapsed",
    ]);

    const before = Object.values(ids).map((id) => h.store.auditEvents(id));
    const reconciles = h.diagnostic.reconcileCalls.length;
    h.store.calls.length = 0;
    h.diagnostic.verdicts.push({ kind: "effect-absent" }, { kind: "effect-absent" });

    const second = await h.engine.recover();
    await h.engine.settled();

    expect(Object.values(ids).map((id) => h.store.auditEvents(id))).toEqual(before);
    expect(h.diagnostic.reconcileCalls).toHaveLength(reconciles);
    expect(h.diagnostic.executeCalls).toHaveLength(0);
    for (const write of ["claim", "finish", "beginRetry"]) {
      expect(h.store.calls).not.toContain(write);
    }
    expect(Object.values(second).every((count) => count === 0)).toBe(true);
  });
});

describe("approved and never claimed (Task 2, Test 6)", () => {
  it("claims with fresh facts and executes one inside the maximum approval age", async () => {
    const h = createHarness();
    const id = h.propose();
    approveInStore(h, id);
    h.clock.advance(1 * MINUTE);
    h.diagnostic.claimFactsResult = { pid: 7 };

    const summary = await h.engine.recover();
    await h.engine.settled();

    const stored = h.store.get(id);
    expect(stored?.state).toBe("executed");
    expect(stored?.claimFacts).toEqual({ pid: 7 });
    expect(stored?.attempts).toBe(1);
    expect(h.diagnostic.executeCalls).toHaveLength(1);
    expect(h.diagnostic.executeCalls[0]?.context.attempt).toBe(1);
    expect(summary.claimed).toBe(1);
    expect(summary.lapsed).toBe(0);
  });

  it("lapses one beyond it with an audit row and never calls execute", async () => {
    const h = createHarness();
    const id = h.propose();
    approveInStore(h, id);
    h.clock.advance(6 * MINUTE);
    const summary = await h.engine.recover();
    await h.engine.settled();
    expect(stateOf(h, id)).toBe("lapsed");
    expect(h.store.auditEvents(id)).toContain("lapsed");
    expect(h.diagnostic.executeCalls).toHaveLength(0);
    expect(summary.lapsed).toBe(1);
    expect(summary.claimed).toBe(0);
  });
});

describe("reserved or unknown operation at recovery (Task 2, Test 7)", () => {
  it("finishes an executing row unknown (a claimed row may have run) with a fixed code and never executes or reconciles it", async () => {
    const h = createHarness();
    const base = h.propose();
    const reserved = rawRow(h, base, { operation: "vault.delete" });
    const absent = rawRow(h, base, { operation: "no.such.operation" });
    const summary = await h.engine.recover();
    await h.engine.settled();
    for (const id of [reserved, absent]) {
      expect(stateOf(h, id)).toBe("unknown");
      expect(h.store.get(id)?.outcomeCode).toBe("operation-unavailable");
      expect(lastAudit(h, id)).toBe("outcome-unknown");
    }
    expect(summary.unknown).toBe(2);
    expect(summary.failed).toBe(0);
    for (const op of [h.diagnostic, h.terminate]) {
      expect(op.executeCalls).toHaveLength(0);
      expect(op.reconcileCalls).toHaveLength(0);
    }
  });

  it("claims an approved row of a reserved or unregistered operation, then fails it, without executing", async () => {
    const h = createHarness();
    const base = h.propose();
    const reserved = rawRow(h, base, {
      operation: "vault.delete",
      state: "approved",
      attempts: 0,
      claimFacts: null,
    });
    const absent = rawRow(h, base, {
      operation: "no.such.operation",
      state: "approved",
      attempts: 0,
      claimFacts: null,
    });
    const summary = await h.engine.recover();
    await h.engine.settled();
    for (const id of [reserved, absent]) {
      expect(stateOf(h, id)).toBe("failed");
      expect(h.store.get(id)?.outcomeCode).toBe("operation-reserved");
      expect(h.store.auditEvents(id)).toEqual(["claimed", "failed"]);
    }
    expect(h.diagnostic.executeCalls).toHaveLength(0);
    expect(summary.failed).toBe(2);
  });
});

describe("expired on startup (Task 2, Test 8)", () => {
  it("expires overdue pending requests before it examines executing rows", async () => {
    const h = createHarness();
    const overdue = h.propose({ subject: "overdue", requestedTtlMs: 1 * MINUTE });
    const running = h.propose({ subject: "running" });
    leaveExecuting(h, running);
    h.clock.advance(2 * MINUTE);
    h.store.calls.length = 0;
    const summary = await h.engine.recover();
    expect(stateOf(h, overdue)).toBe("expired");
    expect(h.store.calls.indexOf("expireDue")).toBeGreaterThanOrEqual(0);
    expect(h.store.calls.indexOf("expireDue")).toBeLessThan(h.store.calls.indexOf("listExecuting"));
    expect(summary.expired).toBe(1);
    expect(
      h.published.some((e) => e.approval.proposalId === overdue && e.approval.state === "expired"),
    ).toBe(true);
  });
});

describe("idempotent (Task 2, Test 9)", () => {
  it("a second run writes no audit rows and leaves the same states", async () => {
    const h = createHarness();
    const ids = [
      h.propose({ subject: "a" }),
      h.propose({ subject: "b" }),
      h.propose({ subject: "c", requestedTtlMs: 1 * MINUTE }),
      h.propose({ subject: "d" }),
    ];
    leaveExecuting(h, ids[0] as ProposalId);
    leaveExecuting(h, ids[1] as ProposalId);
    approveInStore(h, ids[3] as ProposalId);
    h.diagnostic.verdicts.push({ kind: "effect-proven", evidence: "effect-row-found" });
    h.diagnostic.verdicts.push({ kind: "effect-absent" });
    h.clock.advance(2 * MINUTE);

    await h.engine.recover();
    await h.engine.settled();
    const states = ids.map((id) => stateOf(h, id));
    const audit = ids.map((id) => h.store.auditEvents(id));
    const executes = h.diagnostic.executeCalls.length;
    const publishedCount = h.published.length;

    const again = await h.engine.recover();
    await h.engine.settled();

    expect(ids.map((id) => stateOf(h, id))).toEqual(states);
    expect(ids.map((id) => h.store.auditEvents(id))).toEqual(audit);
    expect(h.diagnostic.executeCalls).toHaveLength(executes);
    expect(h.published).toHaveLength(publishedCount);
    expect(again).toEqual({
      expired: 0,
      reconciled: 0,
      retried: 0,
      unknown: 0,
      lapsed: 0,
      claimed: 0,
      failed: 0,
      purged: 0,
      proofInvalid: 0,
    });
  });
});

describe("does not wait for the retried effect (Task 2, Test 10)", () => {
  it("resolves once the retry is persisted while execute still runs; settled waits for it", async () => {
    const h = createHarness();
    const id = h.propose();
    leaveExecuting(h, id);
    h.diagnostic.verdicts.push({ kind: "effect-absent" });
    const gate = h.diagnostic.hold();

    const summary = await h.engine.recover();

    expect(summary.retried).toBe(1);
    const mid = h.store.get(id);
    expect(mid?.state).toBe("executing");
    expect(mid?.attempts).toBe(2);
    expect(h.store.auditEvents(id)).toContain("retried-after-restart");
    expect(h.diagnostic.executeCalls).toHaveLength(1);

    // A second recovery while this process is still running the effect leaves it alone.
    h.diagnostic.verdicts.push({ kind: "effect-absent" });
    const again = await h.engine.recover();
    expect(again.unknown).toBe(0);
    expect(h.store.get(id)?.state).toBe("executing");
    expect(h.diagnostic.executeCalls).toHaveLength(1);

    let done = false;
    const waiting = h.engine.settled().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    gate.release();
    await waiting;
    expect(h.store.get(id)?.state).toBe("executed");
  });
});

describe("payload purge (Task 2, Test 11)", () => {
  it("purges decided payloads after thirty days, keeps younger and unfinished ones, and never touches audit rows", async () => {
    const h = createHarness();
    const old = h.propose({ subject: "old" });
    const oldDenied = h.propose({ subject: "old-denied" });
    approveInStore(h, old);
    h.store.claim(old, {}, h.clock.now());
    h.store.finish({
      proposalId: old,
      state: "executed",
      code: "executed",
      note: null,
      evidence: null,
      reconciled: false,
      now: h.clock.now(),
    });
    h.store.decide({
      proposalId: oldDenied,
      decision: "deny",
      expectedHash: h.store.get(oldDenied)?.payloadHash ?? "",
      now: h.clock.now(),
      via: "plugin",
    });
    h.clock.advance(29 * DAY);
    const young = h.propose({ subject: "young" });
    h.store.decide({
      proposalId: young,
      decision: "deny",
      expectedHash: h.store.get(young)?.payloadHash ?? "",
      now: h.clock.now(),
      via: "plugin",
    });
    h.clock.advance(2 * DAY);
    const pending = h.propose({ subject: "pending" });
    const running = h.propose({ subject: "running" });
    leaveExecuting(h, running);
    const auditBefore = [old, oldDenied, young].map((id) => h.store.auditEvents(id));

    const summary = await h.engine.recover();
    await h.engine.settled();

    expect(h.store.get(old)?.payloadJson).toBeNull();
    expect(h.store.get(oldDenied)?.payloadJson).toBeNull();
    expect(h.store.get(young)?.payloadJson).not.toBeNull();
    expect(h.store.get(pending)?.payloadJson).not.toBeNull();
    expect(h.store.get(running)?.payloadJson).not.toBeNull();
    expect([old, oldDenied, young].map((id) => h.store.auditEvents(id))).toEqual(auditBefore);
    expect(summary.purged).toBe(2);
  });
});

describe("summary (Task 2, Test 12)", () => {
  it("returns counts only: numbers under fixed names, no id and no text", async () => {
    const h = createHarness();
    const proven = h.propose({ subject: "proven" });
    const retried = h.propose({ subject: "retried" });
    const unknown = h.propose({ subject: "unknown" });
    const waiting = h.propose({ subject: "waiting" });
    const overdue = h.propose({ subject: "overdue", requestedTtlMs: 1 * MINUTE });
    leaveExecuting(h, proven);
    leaveExecuting(h, retried);
    leaveExecuting(h, unknown);
    h.diagnostic.verdicts.push(
      { kind: "effect-proven", evidence: "effect-row-found" },
      { kind: "effect-absent" },
      { kind: "unknown", reason: "run-unreadable" },
    );
    approveInStore(h, waiting);
    h.clock.advance(2 * MINUTE);
    const fresh = h.propose({ subject: "fresh" });
    approveInStore(h, fresh);

    const summary = await h.engine.recover();
    await h.engine.settled();

    expect(summary).toEqual({
      expired: 1,
      reconciled: 1,
      retried: 1,
      unknown: 1,
      lapsed: 0,
      claimed: 2,
      failed: 0,
      purged: 0,
      proofInvalid: 0,
    });
    expect(Object.values(summary).every((count) => typeof count === "number")).toBe(true);
    const text = JSON.stringify(summary);
    for (const id of [proven, retried, unknown, waiting, overdue, fresh]) {
      expect(text).not.toContain(id);
    }
    const logged = h.log.lines.filter((line) => line.fields.code === "recovered");
    expect(logged).toHaveLength(1);
    expect(logged[0]?.fields.counts).toEqual(summary);
  });
});

describe("one bad row does not stop recovery (Task 2, beyond the plan)", () => {
  it("logs a fixed code for a row whose store write throws and still recovers the others", async () => {
    const h = createHarness();
    const bad = h.propose({ subject: "bad" });
    const good = h.propose({ subject: "good" });
    leaveExecuting(h, bad);
    leaveExecuting(h, good);
    h.diagnostic.verdicts.push({ kind: "effect-absent" }, { kind: "effect-proven", evidence: "x" });
    const store = h.store as { beginRetry: Harness["store"]["beginRetry"] };
    const original = store.beginRetry.bind(h.store);
    store.beginRetry = (id, now) => {
      if (id === bad) throw new Error("database is locked /Users/USERNAME");
      return original(id, now);
    };
    await h.engine.recover();
    await h.engine.settled();
    expect(stateOf(h, bad)).toBe("executing");
    expect(stateOf(h, good)).toBe("executed");
    expect(h.log.lines.some((line) => line.fields.code === "recovery-row-failed")).toBe(true);
    expect(JSON.stringify(h.log.lines)).not.toContain("USERNAME");
  });
});

describe("logging allow-list over every recovery branch (Task 3, Test 4)", () => {
  it("logs only allow-listed keys and short fixed values in every branch of recovery", async () => {
    const lines: LoggedLine[] = [];
    const take = (h: Harness) => void lines.push(...h.log.lines);

    {
      // proven, retried, an unknown verdict, a thrown reconcile
      const h = createHarness();
      const ids = ["a", "b", "c", "d"].map((subject) => h.propose({ subject }));
      for (const id of ids) leaveExecuting(h, id);
      h.diagnostic.verdicts.push(
        { kind: "effect-proven", evidence: "effect-row-found" },
        { kind: "effect-absent" },
        { kind: "unknown", reason: "run-unreadable" },
        new Error("reconcile broke /Users/USERNAME"),
      );
      await h.engine.recover();
      await h.engine.settled();
      take(h);
    }
    {
      // expired, lapsed, claimed, reserved (executing and approved), purge
      const h = createHarness();
      const base = h.propose({ subject: "base" });
      h.propose({ subject: "overdue", requestedTtlMs: MINUTE });
      const stale = h.propose({ subject: "stale" });
      approveInStore(h, stale);
      h.clock.advance(6 * MINUTE);
      const fresh = h.propose({ subject: "fresh" });
      approveInStore(h, fresh);
      rawRow(h, base, { operation: "vault.delete" });
      rawRow(h, base, { operation: "no.such.operation", state: "approved", attempts: 0 });
      h.diagnostic.verdicts.push({ kind: "unknown", reason: "run-unreadable" });
      await h.engine.recover();
      await h.engine.settled();
      h.clock.advance(31 * DAY);
      await h.engine.recover();
      take(h);
    }
    {
      // an executing and an approved row without a valid proof (09-17)
      const h = createHarness();
      const unsignedExecuting = h.propose({ subject: "unsigned-executing" });
      approveUnsigned(h, unsignedExecuting);
      h.store.claim(unsignedExecuting, {}, h.clock.now());
      const unsignedApproved = h.propose({ subject: "unsigned-approved" });
      approveUnsigned(h, unsignedApproved);
      await h.engine.recover();
      take(h);
    }
    {
      // a row whose store write throws; a payload that fails its hash
      const h = createHarness();
      const bad = h.propose({ subject: "bad" });
      const tampered = h.propose({ subject: "tampered", payload: { note: "one" } });
      leaveExecuting(h, bad);
      leaveExecuting(h, tampered);
      h.store.tamperPayloadJson(tampered, '{"note":"two"}');
      h.diagnostic.verdicts.push({ kind: "effect-absent" });
      const store = h.store as { beginRetry: Harness["store"]["beginRetry"] };
      store.beginRetry = () => {
        throw new Error("database is locked /Users/USERNAME");
      };
      await h.engine.recover();
      take(h);
    }

    expect(logViolations(lines)).toEqual([]);
    const codes = codesOf(lines);
    for (const required of [
      "retried-after-restart",
      "recovered",
      "recovery-row-failed",
      "executed",
      "outcome-unknown",
      "reconcile-threw",
      "operation-reserved",
      "stored-hash-mismatch",
      "approval-proof-invalid",
      "proof-invalid",
    ]) {
      expect(codes.has(required), `recovery never logged "${required}"`).toBe(true);
    }
    expect(JSON.stringify(lines)).not.toContain("USERNAME");
  });
});

describe("a row without a valid proof is never executed (09-17 Task 2)", () => {
  const OTHER_KEY = Buffer.alloc(32, 9);

  /** Leaves a request `executing` whose approval carries `proof` (null: none at all). */
  function leaveExecutingWith(h: Harness, id: ProposalId, proof: string | null): void {
    if (proof === null) approveUnsigned(h, id);
    else approveInStore(h, id, proof);
    const claim = h.store.claim(id, { pid: 4242 }, h.clock.now());
    if (claim.kind !== "claimed") throw new Error("fixture: claim lost");
  }

  function expectNothingRan(h: Harness): void {
    for (const op of [h.diagnostic, h.terminate]) {
      expect(op.executeCalls).toHaveLength(0);
      expect(op.reconcileCalls).toHaveLength(0);
    }
  }

  function proofWarnings(h: Harness): LoggedLine[] {
    return h.log.lines.filter((line) => line.fields.code === "approval-proof-invalid");
  }

  it("Test 1: an executing row with no proof is finished unknown / proof-invalid before any reconcile or retry", async () => {
    const h = createHarness();
    const id = h.propose();
    leaveExecutingWith(h, id, null);
    h.diagnostic.verdicts.push({ kind: "effect-absent" });

    const summary = await h.engine.recover();
    await h.engine.settled();

    expect(stateOf(h, id)).toBe("unknown");
    expect(h.store.get(id)?.outcomeCode).toBe("proof-invalid");
    expect(h.store.calls).not.toContain("beginRetry");
    expectNothingRan(h);
    expect(summary.proofInvalid).toBe(1);
    expect(summary.unknown).toBe(0);
    expect(summary.retried).toBe(0);
    const warnings = proofWarnings(h);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      level: "warn",
      fields: { proposalId: id, code: "approval-proof-invalid" },
    });
    expect(Object.keys(warnings[0]?.fields ?? {}).sort()).toEqual(["code", "proposalId"]);
  });

  it("Test 2: an approved row with no proof is claimed and finished failed / proof-invalid, never started", async () => {
    const h = createHarness();
    const id = h.propose();
    approveUnsigned(h, id);

    const summary = await h.engine.recover();
    await h.engine.settled();

    expect(stateOf(h, id)).toBe("failed");
    expect(h.store.get(id)?.outcomeCode).toBe("proof-invalid");
    expect(h.store.auditEvents(id)).toEqual(["requested", "approved", "claimed", "failed"]);
    expectNothingRan(h);
    expect(summary.proofInvalid).toBe(1);
    expect(summary.claimed).toBe(0);
    expect(proofWarnings(h)).toHaveLength(1);
  });

  it("Test 2b: a proof copied from another row, a well-formed proof with a wrong MAC, and one made with another key are refused alike", async () => {
    const h = createHarness();
    const donor = h.propose({ subject: "donor" });
    const donorRow = approveInStore(h, donor);
    const copied = h.propose({ subject: "copied" });
    const wrongMac = h.propose({ subject: "wrong-mac" });
    const otherKey = h.propose({ subject: "other-key" });
    const malformed = h.propose({ subject: "malformed" });
    const now = h.clock.now();
    approveInStore(h, copied, donorRow.decisionProof ?? "");
    approveInStore(h, wrongMac, JSON.stringify({ v: 1, mac: "0".repeat(64), presence: null }));
    approveInStore(
      h,
      otherKey,
      proofFor(h.store.get(otherKey) as StoredProposal, now, "plugin", OTHER_KEY),
    );
    approveInStore(h, malformed, "not json at all");

    const summary = await h.engine.recover();
    await h.engine.settled();

    for (const id of [copied, wrongMac, otherKey, malformed]) {
      expect(stateOf(h, id), id).toBe("failed");
      expect(h.store.get(id)?.outcomeCode).toBe("proof-invalid");
    }
    // The donor's own proof is valid for the donor: it runs.
    expect(stateOf(h, donor)).toBe("executed");
    expect(h.diagnostic.executeCalls).toHaveLength(1);
    expect(summary.proofInvalid).toBe(4);
    expect(summary.claimed).toBe(1);
    expect(proofWarnings(h)).toHaveLength(4);
  });

  it("Test 2c: executing rows with a copied proof or a wrong MAC are finished unknown without reconcile or retry", async () => {
    const h = createHarness();
    const donor = h.propose({ subject: "donor" });
    const donorRow = approveInStore(h, donor);
    const copied = h.propose({ subject: "copied" });
    const wrongMac = h.propose({ subject: "wrong-mac" });
    leaveExecutingWith(h, copied, donorRow.decisionProof ?? "");
    leaveExecutingWith(h, wrongMac, JSON.stringify({ v: 1, mac: "f".repeat(64), presence: null }));
    h.diagnostic.verdicts.push({ kind: "effect-absent" }, { kind: "effect-absent" });

    const summary = await h.engine.recover();
    await h.engine.settled();

    for (const id of [copied, wrongMac]) {
      expect(stateOf(h, id), id).toBe("unknown");
      expect(h.store.get(id)?.outcomeCode).toBe("proof-invalid");
    }
    expect(h.store.calls).not.toContain("beginRetry");
    expect(summary.proofInvalid).toBe(2);
    expect(summary.retried).toBe(0);
  });

  it("Test 3: a correctly proved approved row is still claimed and started", async () => {
    const h = createHarness();
    const id = h.propose();
    approveInStore(h, id);

    const summary = await h.engine.recover();
    await h.engine.settled();

    expect(stateOf(h, id)).toBe("executed");
    expect(h.diagnostic.executeCalls).toHaveLength(1);
    expect(summary.claimed).toBe(1);
    expect(summary.proofInvalid).toBe(0);
    expect(proofWarnings(h)).toHaveLength(0);
  });

  it("Test 3b: a proved executing row is still reconciled", async () => {
    const h = createHarness();
    const id = h.propose();
    leaveExecuting(h, id);
    h.diagnostic.verdicts.push({ kind: "effect-proven", evidence: "effect-row-found" });
    const summary = await h.engine.recover();
    await h.engine.settled();
    expect(stateOf(h, id)).toBe("executed");
    expect(summary.proofInvalid).toBe(0);
  });

  it("Test 4: the engine's claim refuses a row whose proof does not verify and starts nothing", async () => {
    const h = createHarness();
    // The store hands the engine an approved row stripped of its proof, as a tampered file would.
    const store = h.store as { decide: Harness["store"]["decide"] };
    const real = store.decide.bind(h.store);
    store.decide = (input) => {
      const { decisionProof: _dropped, ...unsigned } = input;
      return real(unsigned);
    };
    const id = h.propose();
    const response = await h.engine.decide({
      proposalId: id,
      decision: "approve",
      payloadHash: h.store.get(id)?.payloadHash ?? "",
      channelHint: "plugin",
    });
    await h.engine.settled();

    expect(response.outcome).toBe("decided");
    expect(stateOf(h, id)).toBe("failed");
    expect(h.store.get(id)?.outcomeCode).toBe("proof-invalid");
    expectNothingRan(h);
    expect(proofWarnings(h)).toHaveLength(1);
  });

  it("Test 4b: a legacy executing row with a stored proof for different fields is refused after a restart of the engine", async () => {
    const h = createHarness();
    const id = h.propose();
    leaveExecuting(h, id);
    // Restart: a second engine over the same store but a different key (the install secret changed).
    const { createApprovalEngine } = await import("./engine.js");
    const second = createApprovalEngine({ ...h.deps, proofKey: OTHER_KEY });
    h.diagnostic.verdicts.push({ kind: "effect-proven", evidence: "effect-row-found" });
    const summary = await second.recover();
    await second.settled();
    expect(stateOf(h, id)).toBe("unknown");
    expect(h.store.get(id)?.outcomeCode).toBe("proof-invalid");
    expect(summary.proofInvalid).toBe(1);
    expect(h.diagnostic.reconcileCalls).toHaveLength(0);
  });
});

describe("a row changed while recovery awaits is not retried (09-FIX8, item 1)", () => {
  it("decided_via changed during the reconcile await: the retry is refused, the row ends unknown / proof-invalid, execute is never called", async () => {
    const h = createHarness();
    const id = h.propose();
    leaveExecuting(h, id);
    const { reconcile } = h.diagnostic.definition;
    h.diagnostic.definition.reconcile = async (...args) => {
      const verdict = await reconcile.apply(h.diagnostic.definition, args);
      // The file is edited while recovery waits for the reconcile answer.
      h.store.tamperDecision(id, { decidedVia: "other" });
      return verdict;
    };
    h.diagnostic.verdicts.push({ kind: "effect-absent" });

    const summary = await h.engine.recover();
    await h.engine.settled();

    expect(h.diagnostic.reconcileCalls).toHaveLength(1);
    expect(h.diagnostic.executeCalls).toHaveLength(0);
    expect(stateOf(h, id)).toBe("unknown");
    expect(h.store.get(id)?.outcomeCode).toBe("proof-invalid");
    expect(summary.retried).toBe(1);
    expect(
      h.log.lines.filter((l) => l.fields.code === "approval-proof-invalid" && l.level === "warn"),
    ).toHaveLength(1);
  });
});

describe("the proof is checked before the registry and payload checks (09-FIX8, item 3)", () => {
  it("a forged row of a reserved or unregistered operation, or with a bad payload, is warned and counted as proof-invalid", async () => {
    const h = createHarness();
    const base = h.propose();
    const reservedExecuting = rawRow(h, base, { operation: "vault.delete", decisionProof: null });
    const absentApproved = rawRow(h, base, {
      operation: "no.such.operation",
      state: "approved",
      attempts: 0,
      claimFacts: null,
      decisionProof: null,
    });
    const reservedApproved = rawRow(h, base, {
      operation: "vault.delete",
      state: "approved",
      attempts: 0,
      claimFacts: null,
      decisionProof: null,
    });
    const badPayload = h.propose({ subject: "bad-payload", payload: { note: "one" } });
    approveUnsigned(h, badPayload);
    h.store.claim(badPayload, {}, h.clock.now());
    h.store.tamperPayloadJson(badPayload, '{"note":"two"}');

    const summary = await h.engine.recover();
    await h.engine.settled();

    for (const id of [reservedExecuting, badPayload]) {
      expect(stateOf(h, id), id).toBe("unknown");
      expect(h.store.get(id)?.outcomeCode).toBe("proof-invalid");
    }
    for (const id of [absentApproved, reservedApproved]) {
      expect(stateOf(h, id), id).toBe("failed");
      expect(h.store.get(id)?.outcomeCode).toBe("proof-invalid");
    }
    expect(summary.proofInvalid).toBe(4);
    expect(summary.failed).toBe(0);
    expect(
      h.log.lines.filter((l) => l.fields.code === "approval-proof-invalid" && l.level === "warn"),
    ).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 09-18 Task 2: a presence-required row needs a presence part that verifies against the pin (R-05, APPR-12)

describe("presence-required rows at recovery and the claim (09-18 Task 2)", () => {
  const WRITE = "connector.fake-write";

  function writeHarness(readPin?: () => Promise<string | null>) {
    const write = fakeNamed(WRITE);
    const h = createHarness({
      table: EXTENDED_TABLE,
      registry: ([a, b]) =>
        buildOperationRegistry(
          [a, b, fakeNamed("connector.fake-send"), write].flatMap((f) =>
            f === undefined ? [] : [f.definition],
          ),
          EXTENDED_TABLE,
        ),
      ...(readPin === undefined ? {} : { readPin }),
    });
    return { h, write };
  }

  /** The proof the engine stores for a presence approval: the MAC plus the helper's signature over `signedFor`. */
  function presenceProof(
    row: Pick<StoredProposal, "proposalId" | "operation" | "payloadHash">,
    approvedAt: string,
    signedFor: Pick<StoredProposal, "proposalId" | "operation" | "payloadHash"> = row,
    keys = undefined as ReturnType<typeof generatePresenceKeys> | undefined,
  ): string {
    const fields = decisionMacFields({ ...row, approvedAt, decidedVia: "presence" });
    if (fields === null) throw new Error("fixture: no covered fields");
    const sig = signMessage(presenceMessage({ ...signedFor, approvedAt }), keys);
    return signDecisionProof(TEST_PROOF_KEY, fields, { scheme: "p256", sig });
  }

  /** Approves a pending write in the store with the given proof text (computed from the stored row when null-free). */
  function approveWrite(
    h: Harness,
    id: ProposalId,
    proofOf: (row: StoredProposal, now: string) => string,
    via: "presence" | "plugin" = "presence",
  ): StoredProposal {
    const row = h.store.get(id);
    if (row === null) throw new Error("fixture: no row");
    const now = h.clock.now();
    const result = h.store.decide({
      proposalId: id,
      decision: "approve",
      expectedHash: row.payloadHash,
      now,
      approvedAt: now,
      via,
      decisionProof: proofOf(row, now),
    });
    if (result.kind !== "approved") throw new Error(`fixture: not approved: ${result.kind}`);
    return result.proposal;
  }

  it("Test 1: an approved write row with a valid MAC but no presence part is proof-invalid and never started", async () => {
    const { h, write } = writeHarness();
    const id = h.propose({ operation: WRITE, subject: "w" });
    approveWrite(h, id, (row, now) => proofFor(row, now, "presence"));

    const summary = await h.engine.recover();
    await h.engine.settled();

    expect(stateOf(h, id)).toBe("failed");
    expect(h.store.get(id)?.outcomeCode).toBe("proof-invalid");
    expect(write.executeCalls).toHaveLength(0);
    expect(summary.proofInvalid).toBe(1);
    expect(summary.claimed).toBe(0);
  });

  it("Test 1b: the same, when the MAC was made for a plugin approval of a presence-required operation", async () => {
    const { h, write } = writeHarness();
    const id = h.propose({ operation: WRITE, subject: "w" });
    approveWrite(h, id, (row, now) => proofFor(row, now, "plugin"), "plugin");
    const summary = await h.engine.recover();
    await h.engine.settled();
    expect(stateOf(h, id)).toBe("failed");
    expect(write.executeCalls).toHaveLength(0);
    expect(summary.proofInvalid).toBe(1);
  });

  it("Test 2: a presence signature belonging to another proposal (copied) is proof-invalid", async () => {
    const { h, write } = writeHarness();
    const donor = h.propose({ operation: WRITE, subject: "donor" });
    const victim = h.propose({ operation: WRITE, subject: "victim" });
    const donorRow = h.store.get(donor);
    if (donorRow === null) throw new Error("fixture");
    approveWrite(h, victim, (row, now) => presenceProof(row, now, donorRow));

    const summary = await h.engine.recover();
    await h.engine.settled();

    expect(stateOf(h, victim)).toBe("failed");
    expect(h.store.get(victim)?.outcomeCode).toBe("proof-invalid");
    expect(write.executeCalls).toHaveLength(0);
    expect(summary.proofInvalid).toBe(1);
  });

  it("Test 2b: a signature made with a key that is not the pin, and a missing pin, are proof-invalid", async () => {
    const foreign = writeHarness();
    const a = foreign.h.propose({ operation: WRITE, subject: "a" });
    approveWrite(foreign.h, a, (row, now) => presenceProof(row, now, row, generatePresenceKeys()));
    expect((await foreign.h.engine.recover()).proofInvalid).toBe(1);
    expect(foreign.write.executeCalls).toHaveLength(0);

    const noPin = writeHarness(async () => null);
    const b = noPin.h.propose({ operation: WRITE, subject: "b" });
    approveWrite(noPin.h, b, (row, now) => presenceProof(row, now));
    expect((await noPin.h.engine.recover()).proofInvalid).toBe(1);
    expect(stateOf(noPin.h, b)).toBe("failed");
    expect(noPin.write.executeCalls).toHaveLength(0);
  });

  it("Test 3: an executing write row with a bad presence part is finished unknown / proof-invalid before reconcile", async () => {
    const { h, write } = writeHarness();
    const id = h.propose({ operation: WRITE, subject: "w" });
    approveWrite(h, id, (row, now) => proofFor(row, now, "presence"));
    const claim = h.store.claim(id, { pid: 1 }, h.clock.now());
    expect(claim.kind).toBe("claimed");

    const summary = await h.engine.recover();
    await h.engine.settled();

    expect(stateOf(h, id)).toBe("unknown");
    expect(h.store.get(id)?.outcomeCode).toBe("proof-invalid");
    expect(write.reconcileCalls).toHaveLength(0);
    expect(write.executeCalls).toHaveLength(0);
    expect(h.store.calls).not.toContain("beginRetry");
    expect(summary.proofInvalid).toBe(1);
  });

  it("Test 4: a correctly proved write row is claimed and started; a MAC-only diagnostic row still is", async () => {
    const { h, write } = writeHarness();
    const proved = h.propose({ operation: WRITE, subject: "w" });
    approveWrite(h, proved, (row, now) => presenceProof(row, now));
    const plain = h.propose({ subject: "d" });
    approveInStore(h, plain);

    const summary = await h.engine.recover();
    await h.engine.settled();

    expect(summary.proofInvalid).toBe(0);
    expect(summary.claimed).toBe(2);
    expect(write.executeCalls).toHaveLength(1);
    expect(h.diagnostic.executeCalls).toHaveLength(1);
    expect(stateOf(h, proved)).toBe("executed");
  });

  it("Test 5: the pin is read only for presence-required rows, never for a MAC-only one", async () => {
    let reads = 0;
    const { h } = writeHarness(async () => {
      reads += 1;
      return TEST_PIN;
    });
    approveInStore(h, h.propose({ subject: "d" }));
    await h.engine.recover();
    await h.engine.settled();
    expect(reads).toBe(0);
  });
});
