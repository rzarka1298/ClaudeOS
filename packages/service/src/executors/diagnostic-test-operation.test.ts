import { CLASSIFICATION, type CapabilityToken, newProposalId, type Requester } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { createDiagnosticTestOperation } from "./diagnostic-test-operation.js";
import { createFakeEffects } from "./test-support/fakes.js";

/**
 * Tests only: the approval engine is the one issuer of a real token. A local
 * cast here is the sanctioned test pattern; backstop rule 10 forbids it in
 * non-test source.
 */
function tokenFor(
  proposalId: string,
  patch: { operation?: string; subject?: string } = {},
): CapabilityToken<"diagnostic.test"> {
  return {
    proposalId,
    operation: patch.operation ?? "diagnostic.test",
    subject: patch.subject ?? "diagnostic",
    expiresAt: "2099-01-01T00:00:00.000Z",
  } as unknown as CapabilityToken<"diagnostic.test">;
}

function contextFor(idempotencyKey: string, attempt = 1) {
  return { idempotencyKey, claimFacts: {}, attempt };
}

const REQUESTER: Requester = { kind: "dashboard", label: "ZZ-requester-label" };

describe("diagnostic.test operation", () => {
  describe("Test 1: payload", () => {
    it("accepts only an empty object", () => {
      const { payload } = createDiagnosticTestOperation({ effects: createFakeEffects() });
      expect(payload.safeParse({}).success).toBe(true);
      expect(payload.safeParse({ extra: 1 }).success).toBe(false);
      expect(payload.safeParse({ reason: "x" }).success).toBe(false);
      expect(payload.safeParse(null).success).toBe(false);
      expect(payload.safeParse("x").success).toBe(false);
      expect(payload.safeParse([]).success).toBe(false);
    });
  });

  describe("Test 2: execute", () => {
    it("records exactly one effect for the proposal id and reports executed", async () => {
      const effects = createFakeEffects();
      const op = createDiagnosticTestOperation({ effects });
      const id = newProposalId();
      const outcome = await op.execute(tokenFor(id), {}, contextFor(id));
      expect(outcome).toEqual({ kind: "executed" });
      expect(effects.recordCalls).toEqual([id]);
      expect([...effects.rows]).toEqual([id]);
    });

    it("is idempotent: executing twice for one proposal leaves one effect and still reports executed", async () => {
      const effects = createFakeEffects();
      const op = createDiagnosticTestOperation({ effects });
      const id = newProposalId();
      const first = await op.execute(tokenFor(id), {}, contextFor(id, 1));
      const second = await op.execute(tokenFor(id), {}, contextFor(id, 2));
      expect(first).toEqual({ kind: "executed" });
      expect(second).toEqual({ kind: "executed" });
      expect(effects.recordCalls).toHaveLength(2);
      expect(effects.rows.size).toBe(1);
    });

    it("keeps effects for different proposals apart", async () => {
      const effects = createFakeEffects();
      const op = createDiagnosticTestOperation({ effects });
      const a = newProposalId();
      const b = newProposalId();
      await op.execute(tokenFor(a), {}, contextFor(a));
      await op.execute(tokenFor(b), {}, contextFor(b));
      expect(effects.rows.size).toBe(2);
    });
  });

  describe("Test 3: token guard", () => {
    it("refuses a token for another operation and records nothing", async () => {
      const effects = createFakeEffects();
      const op = createDiagnosticTestOperation({ effects });
      const id = newProposalId();
      const outcome = await op.execute(
        tokenFor(id, { operation: "session.force-terminate" }),
        {},
        contextFor(id),
      );
      expect(outcome).toEqual({ kind: "failed", reason: "capability-refused" });
      expect(effects.recordCalls).toEqual([]);
      expect(effects.rows.size).toBe(0);
    });

    it("refuses a token whose proposal id differs from the idempotency key and records nothing", async () => {
      const effects = createFakeEffects();
      const op = createDiagnosticTestOperation({ effects });
      const id = newProposalId();
      const other = newProposalId();
      const outcome = await op.execute(tokenFor(other), {}, contextFor(id));
      expect(outcome).toEqual({ kind: "failed", reason: "capability-refused" });
      expect(effects.recordCalls).toEqual([]);
    });

    it("refuses an idempotency key that is not a proposal id and records nothing", async () => {
      const effects = createFakeEffects();
      const op = createDiagnosticTestOperation({ effects });
      const outcome = await op.execute(tokenFor("not-an-id"), {}, contextFor("not-an-id"));
      expect(outcome).toEqual({ kind: "failed", reason: "capability-refused" });
      expect(effects.recordCalls).toEqual([]);
    });
  });

  describe("Test 4: reconcile", () => {
    it("reports effect-proven with an evidence code when the effect row exists", async () => {
      const id = newProposalId();
      const effects = createFakeEffects([id]);
      const op = createDiagnosticTestOperation({ effects });
      const verdict = await op.reconcile({}, contextFor(id));
      expect(verdict.kind).toBe("effect-proven");
      if (verdict.kind === "effect-proven") {
        expect(verdict.evidence).toMatch(/^[a-z][a-z0-9-]*$/);
      }
    });

    it("reports effect-absent when there is no row", async () => {
      const effects = createFakeEffects();
      const op = createDiagnosticTestOperation({ effects });
      const verdict = await op.reconcile({}, contextFor(newProposalId()));
      expect(verdict).toEqual({ kind: "effect-absent" });
    });

    it("never calls the record method", async () => {
      const effects = createFakeEffects();
      const op = createDiagnosticTestOperation({ effects });
      await op.reconcile({}, contextFor(newProposalId()));
      await op.reconcile({}, contextFor("not-an-id"));
      expect(effects.recordCalls).toEqual([]);
      expect(effects.rows.size).toBe(0);
    });

    it("reports unknown, not absent, for a key that is not a proposal id", async () => {
      const effects = createFakeEffects();
      const op = createDiagnosticTestOperation({ effects });
      const verdict = await op.reconcile({}, contextFor("not-an-id"));
      expect(verdict.kind).toBe("unknown");
    });
  });

  describe("Test 5: render", () => {
    const op = createDiagnosticTestOperation({ effects: createFakeEffects() });
    const draft = op.render({}, { requester: REQUESTER });

    it("is the fixed, non-destructive draft", () => {
      expect(draft.title).toBe("Test approval");
      expect(draft.destructive).toBe(false);
      expect(draft.effect).toBeNull();
      expect(draft.target).toEqual([]);
      expect(draft.change).toEqual({ type: "none" });
      expect(draft.changeFromRequester).toBe(false);
      expect(draft.runName).toBeNull();
      expect(draft.checkHint).toBeNull();
    });

    it("has one risk line stating that the test changes nothing", () => {
      expect(draft.risks).toHaveLength(1);
      expect(draft.risks[0]).toMatch(/changes nothing/i);
    });

    it("has an engine-templated action sentence", () => {
      expect(draft.action.length).toBeGreaterThan(0);
      expect(draft.action).toContain(CLASSIFICATION["diagnostic.test"].summary);
    });

    it("carries no requester text of any kind", () => {
      expect(JSON.stringify(draft)).not.toContain("ZZ-requester-label");
      const other = op.render({}, { requester: { kind: "skill", label: "different" } });
      expect(other).toEqual(draft);
    });
  });

  describe("Test 6: definition shape", () => {
    const op = createDiagnosticTestOperation({ effects: createFakeEffects() });

    it("names an enabled approval-required row", () => {
      expect(op.operation).toBe("diagnostic.test");
      const row = CLASSIFICATION["diagnostic.test"];
      expect(row.class).toBe("approval-required");
      expect(row.status).toBe("enabled");
    });

    it("is non-modifiable and idempotent, as the classification table says", () => {
      const row = CLASSIFICATION["diagnostic.test"];
      expect(row.modifiable).toBe(false);
      expect(row.retry).toBe("idempotent");
    });

    it("does not carry a claimFacts hook (it reads nothing before the claim)", () => {
      expect(op.claimFacts).toBeUndefined();
    });
  });
});
