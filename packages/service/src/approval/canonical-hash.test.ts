import { createHash } from "node:crypto";
import { type ApprovalEnvelope, canonicalJson, type StoredProposal } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { payloadHashOf, recomputeFromStored } from "./canonical-hash.js";

const ENVELOPE: ApprovalEnvelope = {
  operation: "diagnostic.test",
  subject: "diagnostic",
  requester: { kind: "dashboard", label: "Test dashboard" },
  projectId: null,
  runId: null,
  reason: "Because.",
  payload: { a: 1, b: ["x", { c: true }] },
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("payloadHashOf (Test 5)", () => {
  it("is the SHA-256 of the canonical JSON of the envelope, as 64 lowercase hex characters", () => {
    const hash = payloadHashOf(ENVELOPE);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(sha256(canonicalJson(ENVELOPE)));
  });

  it("is stable across key insertion order, at every depth", () => {
    const reordered: ApprovalEnvelope = {
      payload: { b: ["x", { c: true }], a: 1 },
      reason: "Because.",
      runId: null,
      projectId: null,
      requester: { label: "Test dashboard", kind: "dashboard" },
      subject: "diagnostic",
      operation: "diagnostic.test",
    };
    expect(payloadHashOf(reordered)).toBe(payloadHashOf(ENVELOPE));
  });

  it("differs when any single envelope member differs", () => {
    const base = payloadHashOf(ENVELOPE);
    const variants: Record<string, ApprovalEnvelope> = {
      operation: { ...ENVELOPE, operation: "session.force-terminate" },
      subject: { ...ENVELOPE, subject: "other" },
      "requester label": { ...ENVELOPE, requester: { kind: "dashboard", label: "Another" } },
      "requester kind": { ...ENVELOPE, requester: { kind: "skill", label: "Test dashboard" } },
      project: { ...ENVELOPE, projectId: "project-1" },
      run: { ...ENVELOPE, runId: "run-1" },
      reason: { ...ENVELOPE, reason: "Different." },
      payload: { ...ENVELOPE, payload: { a: 2, b: ["x", { c: true }] } },
    };
    for (const [name, envelope] of Object.entries(variants)) {
      expect(payloadHashOf(envelope), name).not.toBe(base);
    }
  });

  it("hashes an NFC and an NFD spelling differently (a look-alike cannot share a hash)", () => {
    const nfc = payloadHashOf({ ...ENVELOPE, reason: "é" });
    const nfd = payloadHashOf({ ...ENVELOPE, reason: "é" });
    expect(nfc).not.toBe(nfd);
  });
});

describe("recomputeFromStored (Test 5)", () => {
  const stored: Pick<
    StoredProposal,
    "operation" | "subject" | "requester" | "projectId" | "runId" | "reason" | "payloadJson"
  > = {
    operation: ENVELOPE.operation,
    subject: ENVELOPE.subject,
    requester: ENVELOPE.requester,
    projectId: ENVELOPE.projectId,
    runId: ENVELOPE.runId,
    reason: ENVELOPE.reason,
    payloadJson: canonicalJson(ENVELOPE.payload),
  };

  it("equals the hash computed at submit when the stored columns are intact", () => {
    expect(recomputeFromStored(stored)).toBe(payloadHashOf(ENVELOPE));
  });

  it("changes when any stored column changes", () => {
    const base = recomputeFromStored(stored);
    expect(recomputeFromStored({ ...stored, reason: "Edited." })).not.toBe(base);
    expect(recomputeFromStored({ ...stored, subject: "other" })).not.toBe(base);
    expect(recomputeFromStored({ ...stored, payloadJson: canonicalJson({ a: 9 }) })).not.toBe(base);
  });

  it("returns null when the payload was purged or is not valid JSON, never a guess", () => {
    expect(recomputeFromStored({ ...stored, payloadJson: null })).toBeNull();
    expect(recomputeFromStored({ ...stored, payloadJson: "{not json" })).toBeNull();
  });
});
