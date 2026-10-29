import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  canonicalJson,
  dedupeKeyOf,
  type NewProposal,
  type NoteId,
  newProposalId,
  type StoredProposal,
} from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  approvalProofKey,
  type DecisionMacFields,
  DecisionProofSchema,
  decisionMacFields,
  signDecisionProof,
  verifyDecisionProof,
} from "./proof.js";
import { createMemoryApprovalStore } from "./test-support/memory-store.js";

const SECRET = Buffer.from(
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
  "hex",
);
const KEY = approvalProofKey(SECRET);
const T0 = "2026-10-06T10:00:00.000Z";
const T1 = "2026-10-06T10:00:30.000Z";
const T2 = "2026-10-06T10:01:00.000Z";

const FIELDS: DecisionMacFields = {
  proposalId: "p00000000000000000000000a" as StoredProposal["proposalId"],
  operation: "diagnostic.test",
  payloadHash: "ab12".repeat(16),
  approvedAt: T1,
  decidedVia: "presence",
};

/** A stored row carrying the given proof; every other column is a neutral value. */
function rowWith(
  fields: DecisionMacFields,
  decisionProof: string | null | undefined,
): StoredProposal {
  return {
    proposalId: fields.proposalId,
    operation: fields.operation,
    subject: "subject",
    dedupeKey: "key",
    requester: { kind: "dashboard", label: "Test" },
    projectId: null,
    runId: null,
    reason: "reason",
    payloadJson: "{}",
    payloadHash: fields.payloadHash,
    state: "approved",
    revision: 2,
    createdAt: T0,
    expiresAt: "2026-10-06T11:00:00.000Z",
    approvedAt: fields.approvedAt,
    decidedAt: fields.approvedAt,
    decidedVia: fields.decidedVia,
    claimFacts: null,
    attempts: 0,
    outcomeCode: null,
    outcomeNote: null,
    mirrorNoteId: "n000000000000000000000001" as NoteId,
    supersedes: null,
    ...(decisionProof === undefined ? {} : { decisionProof }),
  };
}

describe("approvalProofKey (Test 2)", () => {
  it("is 32 bytes, deterministic for one secret and different for another", () => {
    expect(KEY).toHaveLength(32);
    expect(approvalProofKey(SECRET).equals(KEY)).toBe(true);
    expect(approvalProofKey(randomBytes(32)).equals(KEY)).toBe(false);
  });

  it("is not the install secret itself and does not depend on its bytes being reused", () => {
    expect(KEY.equals(SECRET)).toBe(false);
  });
});

// Known-answer vectors, computed independently of proof.ts (a separate HKDF-SHA256 and HMAC-SHA256
// implementation over the literal canonical text below). They pin the HKDF info string, the covered
// members (including the constant `state`) and the use of the derived key, so a change to any of them
// fails here instead of silently minting proofs no earlier row can verify.
const KAT_KEY_HEX = "3dfccd744e9f31f4e4bc6e6e2dc5ad1a79613a9b25317083feff39ac1cecc0e0";
const KAT_MAC_HEX = "f9884452bfb052523430590a1d8f7ae139923df534515ce2c12f4f56e2770812";
const KAT_CANONICAL =
  '{"approvedAt":"2026-10-06T10:00:30.000Z","decidedVia":"presence","operation":"diagnostic.test",' +
  `"payloadHash":"${"ab12".repeat(16)}","proposalId":"p00000000000000000000000a","state":"approved","v":1}`;

describe("known-answer vectors (review finding: no KAT)", () => {
  it("derives the pinned key from the pinned secret", () => {
    expect(approvalProofKey(SECRET).toString("hex")).toBe(KAT_KEY_HEX);
  });

  it("signs the pinned MAC for the pinned fields", () => {
    const parsed = DecisionProofSchema.parse(JSON.parse(signDecisionProof(KEY, FIELDS, null)));
    expect(parsed.mac).toBe(KAT_MAC_HEX);
  });

  it("the signed bytes are the canonical JSON of the covered members, state included", () => {
    expect(canonicalJson({ v: 1, ...FIELDS, state: "approved" })).toBe(KAT_CANONICAL);
    const independent = createHmac("sha256", Buffer.from(KAT_KEY_HEX, "hex"))
      .update(KAT_CANONICAL, "utf8")
      .digest("hex");
    expect(independent).toBe(KAT_MAC_HEX);
    expect(DecisionProofSchema.parse(JSON.parse(signDecisionProof(KEY, FIELDS, null))).mac).toBe(
      independent,
    );
  });

  it("a proof stored as canonical JSON verifies (the stored text is exactly the proof)", () => {
    const text = signDecisionProof(KEY, FIELDS, null);
    expect(text).toBe(`{"mac":"${KAT_MAC_HEX}","presence":null,"v":1}`);
    expect(verifyDecisionProof(KEY, rowWith(FIELDS, text))).toBe("valid");
  });
});

describe("approvalProofKey refuses a short secret (review finding)", () => {
  it.each([0, 1, 16, 31])("throws RangeError for a %d byte secret", (bytes) => {
    expect(() => approvalProofKey(Buffer.alloc(bytes, 7))).toThrow(RangeError);
  });

  it("accepts exactly 32 bytes and longer", () => {
    expect(approvalProofKey(Buffer.alloc(32, 7))).toHaveLength(32);
    expect(approvalProofKey(Buffer.alloc(64, 7))).toHaveLength(32);
  });
});

describe("sign and verify (Test 1)", () => {
  it("signs JSON that the strict schema accepts, with a null presence member", () => {
    const proof = signDecisionProof(KEY, FIELDS, null);
    const parsed = DecisionProofSchema.parse(JSON.parse(proof));
    expect(parsed.v).toBe(1);
    expect(parsed.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.presence).toBeNull();
  });

  it("is valid for the row it was made for", () => {
    const row = rowWith(FIELDS, signDecisionProof(KEY, FIELDS, null));
    expect(verifyDecisionProof(KEY, row)).toBe("valid");
  });

  it("is deterministic: the same fields give the same proof", () => {
    expect(signDecisionProof(KEY, FIELDS, null)).toBe(signDecisionProof(KEY, FIELDS, null));
  });

  it("decisionMacFields reads exactly the covered columns of an approved row", () => {
    const row = rowWith(FIELDS, null);
    expect(decisionMacFields(row)).toEqual(FIELDS);
  });

  it("decisionMacFields is null for a row with no approval instant or no channel", () => {
    expect(decisionMacFields({ ...rowWith(FIELDS, null), approvedAt: null })).toBeNull();
    expect(decisionMacFields({ ...rowWith(FIELDS, null), decidedVia: null })).toBeNull();
  });

  it.each([
    ["proposal id", { proposalId: "p00000000000000000000000b" }],
    ["operation", { operation: "session.force-terminate" }],
    ["payload hash", { payloadHash: "cd34".repeat(16) }],
    ["approved_at", { approvedAt: T2 }],
    ["decided_via", { decidedVia: "plugin" }],
  ] as const)("is invalid when the row's %s differs from what was signed", (_name, change) => {
    const proof = signDecisionProof(KEY, FIELDS, null);
    const row = { ...rowWith(FIELDS, proof), ...change } as StoredProposal;
    expect(verifyDecisionProof(KEY, row)).toBe("invalid");
  });

  it("is invalid when the MAC has one hex digit changed", () => {
    const parsed = DecisionProofSchema.parse(JSON.parse(signDecisionProof(KEY, FIELDS, null)));
    const first = parsed.mac[0] === "0" ? "1" : "0";
    const bad = JSON.stringify({ ...parsed, mac: `${first}${parsed.mac.slice(1)}` });
    expect(verifyDecisionProof(KEY, rowWith(FIELDS, bad))).toBe("invalid");
  });

  it("is invalid when the JSON carries an extra key", () => {
    const parsed = DecisionProofSchema.parse(JSON.parse(signDecisionProof(KEY, FIELDS, null)));
    const extra = JSON.stringify({ ...parsed, extra: true });
    expect(verifyDecisionProof(KEY, rowWith(FIELDS, extra))).toBe("invalid");
  });

  it("is invalid when the version, MAC case or presence member is wrong", () => {
    const parsed = DecisionProofSchema.parse(JSON.parse(signDecisionProof(KEY, FIELDS, null)));
    for (const mutated of [
      { ...parsed, v: 2 },
      { ...parsed, mac: parsed.mac.toUpperCase() },
      { ...parsed, mac: parsed.mac.slice(2) },
      { ...parsed, presence: "sig" },
    ]) {
      expect(verifyDecisionProof(KEY, rowWith(FIELDS, JSON.stringify(mutated)))).toBe("invalid");
    }
  });

  it("treats an absent, null, empty or unparseable proof as invalid (fail closed)", () => {
    expect(verifyDecisionProof(KEY, rowWith(FIELDS, undefined))).toBe("invalid");
    expect(verifyDecisionProof(KEY, rowWith(FIELDS, null))).toBe("invalid");
    expect(verifyDecisionProof(KEY, rowWith(FIELDS, ""))).toBe("invalid");
    expect(verifyDecisionProof(KEY, rowWith(FIELDS, "not json"))).toBe("invalid");
    expect(verifyDecisionProof(KEY, rowWith(FIELDS, "[]"))).toBe("invalid");
    expect(verifyDecisionProof(KEY, rowWith(FIELDS, "null"))).toBe("invalid");
  });

  it("treats a row with no approval instant or no channel as invalid whatever the proof says", () => {
    const proof = signDecisionProof(KEY, FIELDS, null);
    expect(verifyDecisionProof(KEY, { ...rowWith(FIELDS, proof), approvedAt: null })).toBe(
      "invalid",
    );
    expect(verifyDecisionProof(KEY, { ...rowWith(FIELDS, proof), decidedVia: null })).toBe(
      "invalid",
    );
  });

  it("is invalid under a different key", () => {
    const row = rowWith(FIELDS, signDecisionProof(KEY, FIELDS, null));
    expect(verifyDecisionProof(approvalProofKey(randomBytes(32)), row)).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// Test 3 (tracer): a proof made for an approved row survives the store port.

function newPending(operation: string, subject: string): NewProposal {
  const payloadJson = JSON.stringify({ subject });
  const payloadHash = createHash("sha256").update(payloadJson).digest("hex");
  return {
    proposalId: newProposalId(),
    operation,
    subject,
    dedupeKey: dedupeKeyOf(operation, subject),
    requester: { kind: "dashboard", label: "Test" },
    projectId: null,
    runId: null,
    reason: "reason",
    payloadJson,
    payloadHash,
    createdAt: T0,
    expiresAt: "2026-10-06T11:00:00.000Z",
    mirrorNoteId: "n000000000000000000000001" as NoteId,
    supersedes: null,
  };
}

describe("the proof over the store port (Test 3, tracer)", () => {
  it("stores the proof an approving decide is given, returns it, and verifies it", () => {
    const store = createMemoryApprovalStore();
    const proposal = newPending("diagnostic.test", "one");
    store.submit(proposal, { perOperation: 25, total: 50 });
    const proof = signDecisionProof(
      KEY,
      {
        proposalId: proposal.proposalId,
        operation: proposal.operation,
        payloadHash: proposal.payloadHash,
        approvedAt: T1,
        decidedVia: "plugin",
      },
      null,
    );
    const result = store.decide({
      proposalId: proposal.proposalId,
      decision: "approve",
      expectedHash: proposal.payloadHash,
      now: T2,
      via: "plugin",
      approvedAt: T1,
      decisionProof: proof,
    });
    expect(result.kind).toBe("approved");
    const stored = store.get(proposal.proposalId);
    expect(stored?.decisionProof).toBe(proof);
    expect(stored && verifyDecisionProof(KEY, stored)).toBe("valid");
  });

  it("refuses a copied proof: the same proof on a second approved row is invalid", () => {
    const store = createMemoryApprovalStore();
    const first = newPending("diagnostic.test", "first");
    const second = newPending("diagnostic.test", "second");
    store.submit(first, { perOperation: 25, total: 50 });
    store.submit(second, { perOperation: 25, total: 50 });
    const proofForFirst = signDecisionProof(
      KEY,
      {
        proposalId: first.proposalId,
        operation: first.operation,
        payloadHash: first.payloadHash,
        approvedAt: T1,
        decidedVia: "plugin",
      },
      null,
    );
    for (const p of [first, second]) {
      store.decide({
        proposalId: p.proposalId,
        decision: "approve",
        expectedHash: p.payloadHash,
        now: T2,
        via: "plugin",
        approvedAt: T1,
        decisionProof: proofForFirst,
      });
    }
    const a = store.get(first.proposalId);
    const b = store.get(second.proposalId);
    expect(a && verifyDecisionProof(KEY, a)).toBe("valid");
    expect(b?.state).toBe("approved");
    expect(b && verifyDecisionProof(KEY, b)).toBe("invalid");
  });

  it("stores null on a deny, on a pending row and on an approve given no proof", () => {
    const store = createMemoryApprovalStore();
    const denied = newPending("diagnostic.test", "denied");
    const pending = newPending("diagnostic.test", "pending");
    const unsigned = newPending("diagnostic.test", "unsigned");
    for (const p of [denied, pending, unsigned]) store.submit(p, { perOperation: 25, total: 50 });
    store.decide({
      proposalId: denied.proposalId,
      decision: "deny",
      expectedHash: denied.payloadHash,
      now: T2,
      via: "plugin",
      decisionProof: "ignored-on-deny",
    });
    store.decide({
      proposalId: unsigned.proposalId,
      decision: "approve",
      expectedHash: unsigned.payloadHash,
      now: T2,
      via: "plugin",
    });
    expect(store.get(denied.proposalId)?.decisionProof).toBeNull();
    expect(store.get(pending.proposalId)?.decisionProof).toBeNull();
    const approvedUnsigned = store.get(unsigned.proposalId);
    expect(approvedUnsigned?.decisionProof).toBeNull();
    expect(approvedUnsigned && verifyDecisionProof(KEY, approvedUnsigned)).toBe("invalid");
  });
});
