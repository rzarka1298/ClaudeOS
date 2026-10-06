import { createHash } from "node:crypto";
import {
  ApprovalItemViewSchema,
  ApprovalsSnapshotSchema,
  buildEnvelope,
  canonicalJson,
  type DecideResponse,
  type ExecuteContext,
  type ExecuteOutcome,
  type NoteId,
  type ProposalId,
  type StoredProposal,
} from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { resolveOutcome } from "./engine.js";
import { buildOperationRegistry } from "./registry.js";
import { EXTENDED_TABLE, fakeNamed } from "./test-support/extended-table.js";
import { createFakeOperation } from "./test-support/fake-operation.js";
import { createHarness, flush, type Harness, REQUESTER } from "./test-support/harness.js";

const createFakeOperation_ = () => createFakeOperation("diagnostic.test");

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Approves with the hash the store holds, as the plugin does with the hash it was shown. */
async function approve(h: Harness, id: string): Promise<DecideResponse> {
  const stored = h.store.get(id as never);
  return h.engine.decide({
    proposalId: id,
    decision: "approve",
    payloadHash: stored?.payloadHash ?? "",
    via: "plugin",
  });
}

const MINUTE = 60_000;

describe("tracer: submit, approve, claim, execute, finish (Task 1)", () => {
  describe("Test 1: happy path", () => {
    it("submits pending with the envelope hash, approves, claims, executes exactly once and finishes executed", async () => {
      const h = createHarness();
      const submitted = h.submit();
      expect(submitted.kind).toBe("proposed");
      if (submitted.kind !== "proposed") return;
      expect(submitted.deduped).toBe(false);
      const id = submitted.proposalId;

      const pending = h.store.get(id);
      expect(pending?.state).toBe("pending");
      const envelope = buildEnvelope({
        operation: "diagnostic.test",
        subject: "diagnostic",
        requester: REQUESTER,
        projectId: null,
        runId: null,
        reason: "Testing the approval path.",
        payload: {},
      });
      expect(pending?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      expect(pending?.payloadHash).toBe(sha256(canonicalJson(envelope)));

      const decided = await approve(h, id);
      expect(decided.outcome).toBe("decided");
      if (decided.outcome !== "decided") return;
      expect(decided.approval.proposalId).toBe(id);
      expect(decided.approval.state).toBe("executing");

      await h.engine.settled();
      expect(h.diagnostic.executeCalls).toHaveLength(1);
      const call = h.diagnostic.executeCalls[0];
      expect(call?.token.operation).toBe("diagnostic.test");
      expect(call?.token.subject).toBe("diagnostic");
      expect(call?.token.proposalId).toBe(id);
      expect(call?.context.idempotencyKey).toBe(id);
      expect(call?.context.attempt).toBe(1);
      expect(h.diagnostic.effects.size).toBe(1);
      expect(h.terminate.executeCalls).toHaveLength(0);

      const finished = h.store.get(id);
      expect(finished?.state).toBe("executed");
      expect(finished?.outcomeCode).toBe("executed");
      expect(h.store.auditEvents(id)).toEqual(["requested", "approved", "claimed", "executed"]);
    });

    it("publishes and mirrors a summary after each transition, never a payload", async () => {
      const h = createHarness();
      const id = h.propose();
      await approve(h, id);
      await h.engine.settled();
      await flush();
      expect(h.published.map((event) => event.approval.state)).toEqual([
        "pending",
        "approved",
        "executing",
        "executed",
      ]);
      expect(h.mirrored.map((row) => row.state)).toEqual([
        "pending",
        "approved",
        "executing",
        "executed",
      ]);
      expect(Object.keys(h.published[0] ?? {})).toEqual(["approval"]);
    });
  });

  describe("Test 2: deny", () => {
    it("moves to denied, never calls execute or claim, and writes denied", async () => {
      const h = createHarness();
      const id = h.propose();
      const stored = h.store.get(id);
      const result = await h.engine.decide({
        proposalId: id,
        decision: "deny",
        payloadHash: stored?.payloadHash ?? "",
        via: "plugin",
      });
      expect(result.outcome).toBe("decided");
      if (result.outcome === "decided") expect(result.approval.state).toBe("denied");
      await h.engine.settled();
      expect(h.diagnostic.executeCalls).toHaveLength(0);
      expect(h.store.calls).not.toContain("claim");
      expect(h.store.get(id)?.state).toBe("denied");
      expect(h.store.get(id)?.decidedVia).toBe("plugin");
      expect(h.store.auditEvents(id)).toEqual(["requested", "denied"]);
    });
  });

  describe("Test 3: token expiry", () => {
    it("is the proposal expiry when the lifetime is shorter than the maximum approval age", async () => {
      const h = createHarness();
      const id = h.propose({ requestedTtlMs: 2 * MINUTE });
      await approve(h, id);
      await h.engine.settled();
      const stored = h.store.get(id);
      expect(stored?.expiresAt).toBe("2026-10-06T12:02:00.000Z");
      expect(h.diagnostic.executeCalls[0]?.token.expiresAt).toBe(stored?.expiresAt);
    });

    it("is the approval time plus the maximum approval age when the lifetime is longer", async () => {
      const h = createHarness();
      const id = h.propose();
      h.clock.advance(3 * MINUTE);
      await approve(h, id);
      await h.engine.settled();
      expect(h.store.get(id)?.expiresAt).toBe("2026-10-07T12:00:00.000Z");
      // approved at 12:03, maximum approval age 5 minutes
      expect(h.diagnostic.executeCalls[0]?.token.expiresAt).toBe("2026-10-06T12:08:00.000Z");
    });
  });

  describe("Test 6: the executor reads the stored row, never the request", () => {
    it("hands execute the payload parsed from the stored row", async () => {
      const h = createHarness();
      const id = h.propose({ payload: { note: "from the row" } });
      await approve(h, id);
      await h.engine.settled();
      expect(h.diagnostic.executeCalls[0]?.payload).toEqual({ note: "from the row" });
    });

    it("a decide request cannot carry a payload: the input has only id, decision, hash and via", async () => {
      const h = createHarness();
      const id = h.propose({ payload: { note: "from the row" } });
      const stored = h.store.get(id);
      await h.engine.decide({
        proposalId: id,
        decision: "approve",
        payloadHash: stored?.payloadHash ?? "",
        via: "plugin",
        // @ts-expect-error a payload field is not part of the decide input
        payload: { note: "smuggled" },
      });
      await h.engine.settled();
      expect(h.diagnostic.executeCalls[0]?.payload).toEqual({ note: "from the row" });
    });
  });

  describe("Test 7: asynchronous completion", () => {
    it("decide resolves once the request is claimed, before a slow execute finishes; settled waits for it", async () => {
      const h = createHarness();
      const gate = h.diagnostic.hold();
      const id = h.propose();
      const result = await approve(h, id);
      expect(result.outcome).toBe("decided");
      if (result.outcome === "decided") expect(result.approval.state).toBe("executing");
      await flush();
      expect(h.diagnostic.executeCalls).toHaveLength(1);
      expect(h.store.get(id)?.state).toBe("executing");

      let settled = false;
      const waiting = h.engine.settled().then(() => {
        settled = true;
      });
      await flush();
      expect(settled).toBe(false);
      expect(h.store.get(id)?.state).toBe("executing");

      gate.release();
      await waiting;
      expect(settled).toBe(true);
      expect(h.store.get(id)?.state).toBe("executed");
    });
  });

  describe("Test 8: publishing and mirroring are best effort", () => {
    it("a throwing publisher and a rejecting mirror change no result", async () => {
      const h = createHarness({ publisherThrows: true, mirrorRejects: true });
      const submitted = h.submit();
      expect(submitted.kind).toBe("proposed");
      const id = h.propose({ subject: "another" });
      const result = await approve(h, id);
      expect(result.outcome).toBe("decided");
      await h.engine.settled();
      await flush();
      expect(h.store.get(id)?.state).toBe("executed");
      const lines = JSON.stringify(h.log.lines);
      expect(lines).not.toContain("publisher down");
      expect(lines).not.toContain("mirror down");
    });
  });

  describe("Test 9: logs carry only ids, states, hashes and fixed codes", () => {
    it("never writes the payload, the reason or the requester label", async () => {
      const h = createHarness();
      const id = h.propose({
        reason: "REASON-SENTINEL-8841",
        payload: { note: "PAYLOAD-SENTINEL-1177" },
        requester: { kind: "dashboard", label: "LABEL-SENTINEL-5520" },
      });
      await approve(h, id);
      await h.engine.settled();
      const written = JSON.stringify(h.log.lines);
      expect(written).not.toContain("REASON-SENTINEL-8841");
      expect(written).not.toContain("PAYLOAD-SENTINEL-1177");
      expect(written).not.toContain("LABEL-SENTINEL-5520");
      expect(h.log.lines.length).toBeGreaterThan(0);
      expect(written).toContain(id);
    });
  });
});

// ===========================================================================
// Task 2: submit and decide rules, and outcome handling

const HOUR = 60 * MINUTE;
const ZEROS = "0".repeat(64);

/** A row the engine never wrote, for the double (a reserved operation, an odd state). */
function rawRow(patch: Partial<StoredProposal> = {}): StoredProposal {
  return {
    proposalId: "z000000000000000000000001" as ProposalId,
    operation: "vault.delete",
    subject: "some-note",
    dedupeKey: "k",
    requester: { kind: "skill", label: "Raw" },
    projectId: null,
    runId: null,
    reason: "raw",
    payloadJson: "{}",
    payloadHash: "b".repeat(64),
    state: "pending",
    revision: 1,
    createdAt: "2026-10-06T12:00:00.000Z",
    expiresAt: "2026-10-07T12:00:00.000Z",
    approvedAt: null,
    decidedAt: null,
    decidedVia: null,
    claimFacts: null,
    attempts: 0,
    outcomeCode: null,
    outcomeNote: null,
    mirrorNoteId: "n000000000000000000000009" as NoteId,
    supersedes: null,
    ...patch,
  };
}

async function decideWith(
  h: Harness,
  id: string,
  decision: "approve" | "deny",
  hash?: string,
  via: "plugin" | "other" = "plugin",
): Promise<DecideResponse> {
  return h.engine.decide({
    proposalId: id,
    decision,
    payloadHash: hash ?? h.store.get(id as ProposalId)?.payloadHash ?? "",
    via,
  });
}

describe("submit rejections (Task 2, Test 2)", () => {
  it("rejects a reserved operation as operation-reserved and writes nothing", () => {
    const h = createHarness();
    expect(h.submit({ operation: "vault.delete" })).toEqual({
      kind: "rejected",
      reason: "operation-reserved",
    });
    expect(h.store.calls).not.toContain("submit");
    expect(h.published).toHaveLength(0);
    expect(h.mirrored).toHaveLength(0);
  });

  it("rejects an unknown name as operation-unknown", () => {
    const h = createHarness();
    expect(h.submit({ operation: "made.up" })).toEqual({
      kind: "rejected",
      reason: "operation-unknown",
    });
    expect(h.submit({ operation: "__proto__" })).toEqual({
      kind: "rejected",
      reason: "operation-unknown",
    });
    expect(h.store.calls).not.toContain("submit");
  });

  it("rejects a no-approval or direct-gesture name as operation-not-approvable", () => {
    const h = createHarness();
    for (const operation of ["task.write", "launch.finder", "session.focus", "vault.write-note"]) {
      expect(h.submit({ operation }), operation).toEqual({
        kind: "rejected",
        reason: "operation-not-approvable",
      });
    }
    expect(h.store.calls).not.toContain("submit");
  });

  it("rejects a payload that fails the operation's strict schema", () => {
    const h = createHarness();
    for (const payload of [
      { extra: 1 },
      "text",
      null,
      [],
      { note: 5 },
      { note: "x".repeat(201) },
    ]) {
      expect(h.submit({ payload }), JSON.stringify(payload)).toEqual({
        kind: "rejected",
        reason: "invalid-payload",
      });
    }
    expect(h.store.calls).not.toContain("submit");
  });

  it("rejects a malformed requester, run id, subject or reason as invalid-payload", () => {
    const h = createHarness();
    const bad = [
      { requester: { kind: "dashboard", label: "" } },
      { requester: { kind: "dashboard", label: "x".repeat(65) } },
      { requester: { kind: "dashboard", label: "bad\u202elabel" } },
      { requester: { kind: "robot", label: "x" } },
      { runId: "not a run id" },
      { subject: "" },
      { subject: "s".repeat(1025) },
      { reason: "r".repeat(16_001) },
      { projectId: "" },
    ];
    for (const patch of bad) {
      expect(h.submit(patch as never), JSON.stringify(patch)).toEqual({
        kind: "rejected",
        reason: "invalid-payload",
      });
    }
    expect(h.store.calls).not.toContain("submit");
  });

  it("answers inbox-full for the 26th pending request of one operation", () => {
    const h = createHarness();
    for (let i = 0; i < 25; i += 1) {
      expect(h.submit({ subject: `s${i}` }).kind, `submit ${i}`).toBe("proposed");
    }
    expect(h.submit({ subject: "s25" })).toEqual({ kind: "rejected", reason: "inbox-full" });
    // another operation still has room
    expect(h.submit({ operation: "session.force-terminate", subject: "t0" }).kind).toBe("proposed");
  });

  it("answers inbox-full for the 51st pending request overall", () => {
    const third = fakeNamed("connector.fake-send");
    const h = createHarness({
      registry: ([a, b]) =>
        buildOperationRegistry(
          [a, b, third].map((f) => f?.definition).filter((d) => d !== undefined),
          EXTENDED_TABLE,
        ),
    });
    for (let i = 0; i < 25; i += 1) {
      expect(h.submit({ subject: `d${i}` }).kind).toBe("proposed");
      expect(h.submit({ operation: "session.force-terminate", subject: `t${i}` }).kind).toBe(
        "proposed",
      );
    }
    expect(h.submit({ operation: "connector.fake-send", subject: "c0" })).toEqual({
      kind: "rejected",
      reason: "inbox-full",
    });
  });
});

describe("lifetime (Task 2, Test 3)", () => {
  const expiry = (h: Harness, id: ProposalId) => Date.parse(h.store.get(id)?.expiresAt ?? "");

  it("honours a shorter requested lifetime", () => {
    const h = createHarness();
    const id = h.propose({ requestedTtlMs: 90_000 });
    expect(h.store.get(id)?.expiresAt).toBe("2026-10-06T12:01:30.000Z");
  });

  it("clamps a longer request, and one beyond the seven day ceiling, to the row default", () => {
    const h = createHarness();
    const longer = h.propose({ requestedTtlMs: 48 * HOUR, subject: "a" });
    const beyond = h.propose({ requestedTtlMs: 30 * 24 * HOUR, subject: "b" });
    expect(h.store.get(longer)?.expiresAt).toBe("2026-10-07T12:00:00.000Z");
    expect(h.store.get(beyond)?.expiresAt).toBe("2026-10-07T12:00:00.000Z");
    const terminate = h.propose({
      operation: "session.force-terminate",
      subject: "r",
      payload: {},
      requestedTtlMs: HOUR,
    });
    expect(h.store.get(terminate)?.expiresAt).toBe("2026-10-06T12:15:00.000Z");
  });

  it("never yields an expiry later than now plus the row default, whatever is requested", () => {
    const h = createHarness();
    const start = Date.parse(h.clock.now());
    const requests = [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      0,
      1,
      1.5,
      24 * HOUR - 1,
      24 * HOUR,
      24 * HOUR + 1,
      7 * 24 * HOUR,
      1e15,
      Number.MAX_SAFE_INTEGER,
    ];
    requests.forEach((requested, index) => {
      const id = h.propose({
        subject: `s${index}`,
        ...(requested === undefined ? {} : { requestedTtlMs: requested }),
      });
      expect(expiry(h, id), String(requested)).toBeLessThanOrEqual(start + 24 * HOUR);
      expect(expiry(h, id), String(requested)).toBeGreaterThan(start);
    });
  });
});

describe("dedupe and supersede (Task 2, Test 4)", () => {
  it("returns the same id with deduped true for an identical pending request, publishing nothing new", () => {
    const h = createHarness();
    const first = h.propose();
    const publishedBefore = h.published.length;
    const mirroredBefore = h.mirrored.length;
    const second = h.submit();
    expect(second).toEqual({
      kind: "proposed",
      proposalId: first,
      deduped: true,
      supersedes: null,
    });
    expect(h.published).toHaveLength(publishedBefore);
    expect(h.mirrored).toHaveLength(mirroredBefore);
  });

  it("creates a new id that supersedes the expired one once the first has expired and been swept", () => {
    const h = createHarness();
    const first = h.propose();
    h.clock.advance(24 * HOUR);
    h.store.expireDue(h.clock.now());
    const second = h.submit();
    expect(second.kind).toBe("proposed");
    if (second.kind !== "proposed") return;
    expect(second.proposalId).not.toBe(first);
    expect(second.deduped).toBe(false);
    expect(second.supersedes).toBe(first);
    expect(h.store.get(second.proposalId)?.supersedes).toBe(first);
  });

  it("does not hand back a pending request that is already past its expiry and not yet swept", () => {
    const h = createHarness();
    const first = h.propose();
    h.clock.advance(24 * HOUR + 1000);
    const second = h.submit();
    expect(second.kind).toBe("proposed");
    if (second.kind !== "proposed") return;
    expect(second.deduped).toBe(false);
    expect(second.proposalId).not.toBe(first);
    expect(second.supersedes).toBe(first);
    expect(h.store.get(first)?.state).toBe("expired");
    expect(
      h.published.some((e) => e.approval.proposalId === first && e.approval.state === "expired"),
    ).toBe(true);
  });
});

describe("decide vocabulary (Task 2, Test 5)", () => {
  it("hash-mismatch leaves the request pending and executes nothing", async () => {
    const h = createHarness();
    const id = h.propose();
    expect(await decideWith(h, id, "approve", ZEROS)).toEqual({ outcome: "hash-mismatch" });
    await h.engine.settled();
    expect(h.store.get(id)?.state).toBe("pending");
    expect(h.store.calls).not.toContain("claim");
    expect(h.diagnostic.executeCalls).toHaveLength(0);
  });

  it("a hash that is not even shaped like one is a hash-mismatch for a pending request, not-found for none, already-decided for a settled one", async () => {
    const h = createHarness();
    const id = h.propose();
    expect(await decideWith(h, id, "approve", "xyz")).toEqual({ outcome: "hash-mismatch" });
    expect(await decideWith(h, "q".repeat(25), "approve", "xyz")).toEqual({ outcome: "not-found" });
    await decideWith(h, id, "deny");
    expect(await decideWith(h, id, "approve", "xyz")).toEqual({
      outcome: "already-decided",
      state: "denied",
    });
  });

  it("expired, including at exactly the expiry instant; one millisecond earlier still decides", async () => {
    const h = createHarness();
    const early = h.propose({ subject: "early", requestedTtlMs: MINUTE });
    const exact = h.propose({ subject: "exact", requestedTtlMs: MINUTE });
    h.clock.set("2026-10-06T12:00:59.999Z");
    expect((await decideWith(h, early, "deny")).outcome).toBe("decided");
    h.clock.set("2026-10-06T12:01:00.000Z");
    expect(await decideWith(h, exact, "approve")).toEqual({ outcome: "expired" });
    await h.engine.settled();
    expect(h.store.get(exact)?.state).toBe("expired");
    expect(h.diagnostic.executeCalls).toHaveLength(0);
    expect(h.store.auditEvents(exact)).toEqual(["requested", "expired"]);
  });

  it("already-decided reports the state, and two simultaneous approvals execute exactly once", async () => {
    const h = createHarness();
    const id = h.propose();
    const hash = h.store.get(id)?.payloadHash;
    const results = await Promise.all([
      decideWith(h, id, "approve", hash),
      decideWith(h, id, "approve", hash),
    ]);
    await h.engine.settled();
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["already-decided", "decided"]);
    expect(h.diagnostic.executeCalls).toHaveLength(1);
    expect(h.diagnostic.effects.size).toBe(1);
    expect(await decideWith(h, id, "deny", hash)).toEqual({
      outcome: "already-decided",
      state: "executed",
    });
  });

  it("not-found for an unknown well-formed id and for a malformed one", async () => {
    const h = createHarness();
    expect(await decideWith(h, "q".repeat(25), "approve", ZEROS)).toEqual({ outcome: "not-found" });
    expect(await decideWith(h, "short", "approve", ZEROS)).toEqual({ outcome: "not-found" });
    expect(await decideWith(h, "", "deny", ZEROS)).toEqual({ outcome: "not-found" });
  });

  it("operation-reserved for a reserved row inserted by hand: changes nothing and executes nothing", async () => {
    const h = createHarness();
    h.store.insertRaw(rawRow());
    const before = h.store.get("z000000000000000000000001" as ProposalId);
    expect(await decideWith(h, "z000000000000000000000001", "approve", "b".repeat(64))).toEqual({
      outcome: "operation-reserved",
    });
    expect(await decideWith(h, "z000000000000000000000001", "deny", "b".repeat(64))).toEqual({
      outcome: "operation-reserved",
    });
    expect(h.store.get("z000000000000000000000001" as ProposalId)).toEqual(before);
    expect(h.store.calls).not.toContain("claim");
    expect(h.diagnostic.executeCalls).toHaveLength(0);
    expect(h.terminate.executeCalls).toHaveLength(0);
  });
});

describe("stored payload corruption (Task 2, Test 6)", () => {
  it("refuses to approve when the stored payload no longer hashes to the stored hash, and never executes", async () => {
    const h = createHarness();
    const id = h.propose({ payload: { note: "original" } });
    const hash = h.store.get(id)?.payloadHash;
    h.store.tamperPayloadJson(id, '{"note":"edited"}');
    expect(await decideWith(h, id, "approve", hash)).toEqual({ outcome: "hash-mismatch" });
    await h.engine.settled();
    expect(h.store.get(id)?.state).toBe("pending");
    expect(h.store.calls).not.toContain("claim");
    expect(h.diagnostic.executeCalls).toHaveLength(0);
    expect(h.log.lines.some((l) => l.fields.code === "stored-hash-mismatch")).toBe(true);
  });

  it("covers every column of the envelope: an edited reason, or a purged or unreadable payload, is refused", async () => {
    const h = createHarness();
    const a = h.propose({ subject: "a" });
    const b = h.propose({ subject: "b" });
    const c = h.propose({ subject: "c" });
    h.store.tamperReason(a, "a different reason");
    h.store.tamperPayloadJson(b, null);
    h.store.tamperPayloadJson(c, "{not json");
    for (const id of [a, b, c]) {
      expect(await decideWith(h, id, "approve", h.store.get(id)?.payloadHash)).toEqual({
        outcome: "hash-mismatch",
      });
    }
    expect(h.diagnostic.executeCalls).toHaveLength(0);
  });

  it("a deny of a corrupted row is still honoured: denying executes nothing", async () => {
    const h = createHarness();
    const id = h.propose();
    h.store.tamperPayloadJson(id, '{"note":"edited"}');
    const result = await decideWith(h, id, "deny");
    expect(result.outcome).toBe("decided");
    expect(h.store.get(id)?.state).toBe("denied");
  });

  it("re-checks the stored row at execution: a row edited after approval is finished failed and never executed", async () => {
    const h = createHarness();
    const id = h.propose();
    h.diagnostic.onClaimFacts = () => h.store.tamperReason(id, "changed after approval");
    await decideWith(h, id, "approve");
    await h.engine.settled();
    expect(h.diagnostic.executeCalls).toHaveLength(0);
    expect(h.store.get(id)?.state).toBe("failed");
    expect(h.store.get(id)?.outcomeCode).toBe("integrity-check-failed");
  });
});

describe("outcomes, first attempt (Task 2, Test 7)", () => {
  async function runWith(outcome: ExecuteOutcome | Error) {
    const h = createHarness();
    h.diagnostic.outcomes.push(outcome);
    const id = h.propose();
    await decideWith(h, id, "approve");
    await h.engine.settled();
    return { h, id, stored: h.store.get(id) };
  }

  it("executed with no note finishes executed", async () => {
    const { stored, h, id } = await runWith({ kind: "executed" });
    expect(stored?.state).toBe("executed");
    expect(stored?.outcomeCode).toBe("executed");
    expect(stored?.outcomeNote).toBeNull();
    expect(h.store.auditEvents(id).at(-1)).toBe("executed");
  });

  it("executed with the awaiting-exit note finishes executed with that note", async () => {
    const { stored } = await runWith({ kind: "executed", note: "awaiting-exit" });
    expect(stored?.state).toBe("executed");
    expect(stored?.outcomeNote).toBe("awaiting-exit");
  });

  it("drops a note that is not a fixed token rather than storing free text", async () => {
    const { stored } = await runWith({ kind: "executed", note: "Some free text here!" });
    expect(stored?.state).toBe("executed");
    expect(stored?.outcomeNote).toBeNull();
  });

  it.each(["process-ended", "run-not-found", "identity-mismatch"] as const)(
    "a refusal (%s) finishes failed with that reason code and never calls reconcile",
    async (reason) => {
      const { stored, h } = await runWith({ kind: "refused", reason });
      expect(stored?.state).toBe("failed");
      expect(stored?.outcomeCode).toBe(reason);
      expect(h.diagnostic.reconcileCalls).toHaveLength(0);
    },
  );

  it.each(["execution-failed", "capability-refused", "payload-invalid"] as const)(
    "a failure (%s) finishes failed with its code",
    async (reason) => {
      const { stored } = await runWith({ kind: "failed", reason });
      expect(stored?.state).toBe("failed");
      expect(stored?.outcomeCode).toBe(reason);
    },
  );

  it("a rejected execute finishes unknown with executor-threw, never failed, and logs no message text", async () => {
    const { stored, h, id } = await runWith(new Error("BOOM-SECRET-TEXT /Users/USERNAME/secret"));
    expect(stored?.state).toBe("unknown");
    expect(stored?.outcomeCode).toBe("executor-threw");
    expect(h.diagnostic.reconcileCalls).toHaveLength(0);
    expect(h.store.auditEvents(id).at(-1)).toBe("outcome-unknown");
    expect(JSON.stringify(h.log.lines)).not.toContain("BOOM-SECRET-TEXT");
    expect(JSON.stringify(h.log.lines)).not.toContain("/Users/USERNAME");
  });
});

describe("outcomes, retry attempt (Task 2, Test 8)", () => {
  const retry: ExecuteContext = { idempotencyKey: "k", claimFacts: {}, attempt: 2 };
  const first: ExecuteContext = { idempotencyKey: "k", claimFacts: {}, attempt: 1 };
  const payload = {};
  const NON_EXECUTED: ExecuteOutcome[] = [
    { kind: "refused", reason: "process-ended" },
    { kind: "refused", reason: "run-not-found" },
    { kind: "refused", reason: "identity-mismatch" },
    { kind: "failed", reason: "execution-failed" },
    { kind: "failed", reason: "capability-refused" },
  ];

  it("routes every non-executed result through reconcile; effect-proven finishes executed, reconciled, with the evidence", async () => {
    for (const outcome of NON_EXECUTED) {
      const op = createFakeOperation_();
      op.verdicts.push({ kind: "effect-proven", evidence: "process-gone" });
      const decision = await resolveOutcome(op.definition, payload, retry, {
        threw: false,
        outcome,
      });
      expect(decision, JSON.stringify(outcome)).toMatchObject({
        state: "executed",
        code: "executed",
        reconciled: true,
        evidence: "process-gone",
      });
      expect(op.reconcileCalls).toHaveLength(1);
      expect(op.reconcileCalls[0]?.context.attempt).toBe(2);
    }
  });

  it("effect-absent and unknown both finish unknown", async () => {
    for (const outcome of NON_EXECUTED) {
      const absent = createFakeOperation_();
      absent.verdicts.push({ kind: "effect-absent" });
      expect(
        await resolveOutcome(absent.definition, payload, retry, { threw: false, outcome }),
      ).toMatchObject({
        state: "unknown",
        reconciled: false,
      });
      const unknown = createFakeOperation_();
      unknown.verdicts.push({ kind: "unknown", reason: "ambiguous-run" });
      expect(
        await resolveOutcome(unknown.definition, payload, retry, { threw: false, outcome }),
      ).toMatchObject({
        state: "unknown",
        evidence: "ambiguous-run",
      });
    }
  });

  it("a plain failed is never produced for an attempt of 2 or more, whatever the verdict", async () => {
    const verdicts = [
      { kind: "effect-proven", evidence: "x" },
      { kind: "effect-absent" },
      { kind: "unknown", reason: "y" },
      new Error("reconcile broke"),
    ] as const;
    for (const attempt of [2, 3]) {
      for (const outcome of NON_EXECUTED) {
        for (const verdict of verdicts) {
          const op = createFakeOperation_();
          op.verdicts.push(verdict);
          const decision = await resolveOutcome(
            op.definition,
            payload,
            { ...retry, attempt },
            { threw: false, outcome },
          );
          expect(decision.state, `${attempt} ${JSON.stringify(outcome)}`).not.toBe("failed");
        }
      }
    }
  });

  it("a reconcile that throws finishes unknown with a fixed code and no message", async () => {
    const op = createFakeOperation_();
    op.verdicts.push(new Error("SECRET-RECONCILE-TEXT"));
    const decision = await resolveOutcome(op.definition, payload, retry, {
      threw: false,
      outcome: NON_EXECUTED[0] as ExecuteOutcome,
    });
    expect(decision).toMatchObject({ state: "unknown", code: "reconcile-threw" });
    expect(JSON.stringify(decision)).not.toContain("SECRET-RECONCILE-TEXT");
  });

  it("an evidence or reason string that is not a fixed token is replaced, never stored", async () => {
    const op = createFakeOperation_();
    op.verdicts.push({ kind: "effect-proven", evidence: "Free text /Users/USERNAME" });
    const decision = await resolveOutcome(op.definition, payload, retry, {
      threw: false,
      outcome: NON_EXECUTED[0] as ExecuteOutcome,
    });
    expect(decision.state).toBe("executed");
    expect(decision.evidence).toBe("reconcile-evidence");
  });

  it("an executed result on a retry is executed without asking reconcile; a throw is unknown", async () => {
    const op = createFakeOperation_();
    expect(
      await resolveOutcome(op.definition, payload, retry, {
        threw: false,
        outcome: { kind: "executed" },
      }),
    ).toMatchObject({ state: "executed", reconciled: false });
    expect(await resolveOutcome(op.definition, payload, retry, { threw: true })).toMatchObject({
      state: "unknown",
      code: "executor-threw",
    });
    expect(op.reconcileCalls).toHaveLength(0);
  });

  it("on the first attempt the same results are definitive and reconcile is not asked", async () => {
    const op = createFakeOperation_();
    const decision = await resolveOutcome(op.definition, payload, first, {
      threw: false,
      outcome: { kind: "refused", reason: "process-ended" },
    });
    expect(decision).toMatchObject({ state: "failed", code: "process-ended" });
    expect(op.reconcileCalls).toHaveLength(0);
  });
});

describe("token not executed when expired (Task 2, Test 9)", () => {
  it("does not call execute and finishes failed token-expired when the maximum approval age passed before the run", async () => {
    const h = createHarness();
    const id = h.propose();
    h.diagnostic.onClaimFacts = () => h.clock.advance(6 * MINUTE);
    await decideWith(h, id, "approve");
    await h.engine.settled();
    expect(h.diagnostic.executeCalls).toHaveLength(0);
    expect(h.diagnostic.effects.size).toBe(0);
    expect(h.store.get(id)?.state).toBe("failed");
    expect(h.store.get(id)?.outcomeCode).toBe("token-expired");
  });

  it("does the same when the proposal's own expiry has passed", async () => {
    const h = createHarness();
    const id = h.propose({ requestedTtlMs: MINUTE });
    h.diagnostic.onClaimFacts = () => h.clock.advance(2 * MINUTE);
    await decideWith(h, id, "approve");
    await h.engine.settled();
    expect(h.diagnostic.executeCalls).toHaveLength(0);
    expect(h.store.get(id)?.outcomeCode).toBe("token-expired");
  });

  it("still executes when the token expiry is in the future", async () => {
    const h = createHarness();
    const id = h.propose();
    h.diagnostic.onClaimFacts = () => h.clock.advance(4 * MINUTE);
    await decideWith(h, id, "approve");
    await h.engine.settled();
    expect(h.diagnostic.executeCalls).toHaveLength(1);
  });
});

describe("withdraw and decidedVia (Task 2, Test 10)", () => {
  it("withdraws a pending request and refuses every other state", async () => {
    const h = createHarness();
    const id = h.propose();
    expect(h.engine.withdraw(id)).toEqual({ kind: "withdrawn" });
    expect(h.store.get(id)?.state).toBe("withdrawn");
    expect(h.store.auditEvents(id)).toEqual(["requested", "withdrawn"]);
    expect(h.published.at(-1)?.approval.state).toBe("withdrawn");
    expect(h.engine.withdraw(id)).toEqual({ kind: "not-withdrawable" });

    const done = h.propose({ subject: "other" });
    await decideWith(h, done, "approve");
    await h.engine.settled();
    expect(h.engine.withdraw(done)).toEqual({ kind: "not-withdrawable" });
    expect(h.store.get(done)?.state).toBe("executed");
    expect(h.engine.withdraw("q".repeat(25))).toEqual({ kind: "not-withdrawable" });
    expect(h.engine.withdraw("bad")).toEqual({ kind: "not-withdrawable" });
  });

  it("stores the supplied decided-via value on an approval and on a denial, and any other value as other", async () => {
    const h = createHarness();
    const a = h.propose({ subject: "a" });
    const b = h.propose({ subject: "b" });
    const c = h.propose({ subject: "c" });
    await decideWith(h, a, "approve", undefined, "other");
    await decideWith(h, b, "deny", undefined, "plugin");
    await h.engine.decide({
      proposalId: c,
      decision: "deny",
      payloadHash: h.store.get(c)?.payloadHash ?? "",
      via: "someone-else" as never,
    });
    await h.engine.settled();
    expect(h.store.get(a)?.decidedVia).toBe("other");
    expect(h.store.get(b)?.decidedVia).toBe("plugin");
    expect(h.store.get(c)?.decidedVia).toBe("other");
  });
});

// ===========================================================================
// Task 3: get, list and snapshot

describe("get, list and snapshot (Task 3)", () => {
  it("get returns the service-built view of a pending request, with the fingerprint and history", async () => {
    const h = createHarness({ projectName: () => "Project one" });
    const id = h.propose({
      projectId: "project-1",
      reason: "Because.",
      requester: { kind: "skill", label: "Planner" },
    });
    const detail = h.engine.get(id);
    expect(detail.kind).toBe("found");
    if (detail.kind !== "found") return;
    expect(detail.purged).toBe(false);
    expect(detail.unreadable).toBe(false);
    expect(detail.view).not.toBeNull();
    expect(ApprovalItemViewSchema.safeParse(detail.view).success).toBe(true);
    expect(detail.view?.state).toBe("pending");
    expect(detail.view?.project).toBe("Project one");
    expect(detail.view?.reason.shown).toBe("Because.");
    expect(detail.view?.reviewable).toBe(true);
    expect(detail.fingerprint).toBe(h.store.get(id)?.payloadHash.slice(0, 12));
    expect(detail.summary.proposalId).toBe(id);
    expect(detail.history.map((e) => e.event)).toEqual(["requested"]);
  });

  it("get follows the request through to its outcome", async () => {
    const h = createHarness();
    const id = h.propose();
    await decideWith(h, id, "approve");
    await h.engine.settled();
    const detail = h.engine.get(id);
    if (detail.kind !== "found") throw new Error("expected found");
    expect(detail.view?.state).toBe("executed");
    expect(detail.view?.record.outcomeCode).toBe("executed");
    expect(detail.view?.record.decidedVia).toBe("plugin");
    expect(detail.history.map((e) => e.event)).toEqual([
      "requested",
      "approved",
      "claimed",
      "executed",
    ]);
  });

  it("get answers not-found for an unknown or malformed id", () => {
    const h = createHarness();
    expect(h.engine.get("q".repeat(25))).toEqual({ kind: "not-found" });
    expect(h.engine.get("bad")).toEqual({ kind: "not-found" });
  });

  it("a decided request whose payload was purged returns a null view with purged true, and still the summary, history and fingerprint (Test 9)", async () => {
    const h = createHarness();
    const id = h.propose();
    await decideWith(h, id, "deny");
    h.store.purgeDecidedPayloads("2099-01-01T00:00:00.000Z");
    expect(h.store.get(id)?.payloadJson).toBeNull();
    const detail = h.engine.get(id);
    if (detail.kind !== "found") throw new Error("expected found");
    expect(detail.view).toBeNull();
    expect(detail.purged).toBe(true);
    expect(detail.summary.state).toBe("denied");
    expect(detail.history.map((e) => e.event)).toEqual(["requested", "denied"]);
    expect(detail.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it("a request whose draft can no longer be rendered is reported unreadable, never half-built", () => {
    const h = createHarness();
    const id = h.propose();
    h.diagnostic.renderThrows = true;
    const detail = h.engine.get(id);
    if (detail.kind !== "found") throw new Error("expected found");
    expect(detail.view).toBeNull();
    expect(detail.unreadable).toBe(true);
    expect(detail.purged).toBe(false);
    expect(detail.summary.title.length).toBeGreaterThan(0);
  });

  it("list returns summaries for a bucket, soonest expiry first for pending", () => {
    const h = createHarness();
    const late = h.propose({ subject: "late" });
    const soon = h.propose({ subject: "soon", requestedTtlMs: MINUTE });
    expect(h.engine.list("pending").map((s) => s.proposalId)).toEqual([soon, late]);
    expect(h.engine.list("decided")).toEqual([]);
    expect(h.engine.list("expired")).toEqual([]);
  });

  it("snapshot lists pending, decided and expired with true counts and parses against the domain schema", async () => {
    const h = createHarness();
    const a = h.propose({ subject: "a" });
    const b = h.propose({ subject: "b" });
    const c = h.propose({ subject: "c", requestedTtlMs: MINUTE });
    await decideWith(h, a, "deny");
    h.clock.advance(2 * MINUTE);
    h.store.expireDue(h.clock.now());
    const snapshot = h.engine.snapshot();
    expect(ApprovalsSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.ready).toBe(true);
    expect(snapshot.pending.map((s) => s.proposalId)).toEqual([b]);
    expect(snapshot.decided.map((s) => s.proposalId)).toEqual([a]);
    expect(snapshot.expired.map((s) => s.proposalId)).toEqual([c]);
    expect(snapshot.counts).toEqual({ pending: 1, decided: 1, expired: 1 });
    expect(snapshot.truncated).toBe(false);
  });

  it("snapshot stays under a budget by trimming decided and expired, never pending", async () => {
    const h = createHarness();
    for (let i = 0; i < 10; i += 1) {
      await decideWith(h, h.propose({ subject: `x${i}` }), "deny");
    }
    for (let i = 0; i < 25; i += 1) h.propose({ subject: `d${i}` });
    for (let i = 0; i < 25; i += 1) {
      h.propose({ operation: "session.force-terminate", subject: `t${i}` });
    }
    const whole = h.engine.snapshot();
    expect(whole.decided).toHaveLength(10);
    const budget = Buffer.byteLength(JSON.stringify(whole), "utf8") - 1500;
    const snapshot = h.engine.snapshot(budget);
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(budget);
    expect(snapshot.pending).toHaveLength(50);
    expect(snapshot.decided.length).toBeLessThan(10);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.counts).toEqual({ pending: 50, decided: 10, expired: 0 });
  });
});

describe("outcome codes and stuck requests (06-w3 finding 2)", () => {
  const STORE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

  /** Makes the memory store as strict about outcome codes as the real one. */
  function strictFinish(h: Harness): void {
    const store = h.store as { finish: Harness["store"]["finish"] };
    const original = store.finish.bind(h.store);
    store.finish = (input) => {
      if (!STORE_CODE.test(input.code)) throw new Error("invalid outcome code");
      return original(input);
    };
  }

  it("an operation returning a reason that is not a fixed token still ends terminal", async () => {
    const h = createHarness();
    strictFinish(h);
    h.diagnostic.outcomes.push({ kind: "failed", reason: "Has Spaces" as never });
    const id = h.propose();
    await decideWith(h, id, "approve");
    await h.engine.settled();
    const stored = h.store.get(id);
    expect(stored?.state).toBe("failed");
    expect(stored?.outcomeCode).toBe("refused");
  });

  it("a store.finish that throws ends in a terminal unknown, never stuck executing", async () => {
    const h = createHarness();
    const store = h.store as { finish: Harness["store"]["finish"] };
    const original = store.finish.bind(h.store);
    let calls = 0;
    store.finish = (input) => {
      calls += 1;
      if (calls === 1) throw new Error("disk full");
      return original(input);
    };
    const id = h.propose();
    await decideWith(h, id, "approve");
    await h.engine.settled();
    const stored = h.store.get(id);
    expect(stored?.state).toBe("unknown");
    expect(JSON.stringify(h.log.lines)).not.toContain("disk full");
  });
});
