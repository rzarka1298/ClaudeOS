import { createHash } from "node:crypto";
import { buildEnvelope, canonicalJson, type DecideResponse } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { createHarness, flush, type Harness, REQUESTER } from "./test-support/harness.js";

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
