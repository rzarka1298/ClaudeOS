import { createHash } from "node:crypto";
import {
  type ApprovalEnvelope,
  canonicalJson,
  type JsonValue,
  type StoredProposal,
} from "@ccc/domain";

/**
 * The payload hash contract (D-16, T-06-03): SHA-256 over the RFC 8785
 * canonical JSON of the envelope, so the same content always has one hash
 * whatever the insertion order of its members. The envelope covers everything
 * the owner is shown and everything the executor will use (operation, subject,
 * requester, project, run, reason and payload). The one allowed Node import in
 * the approval folder is `node:crypto`, here, for the digest.
 */

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The hash computed once at submit, over the canonical envelope. Throws a `TypeError` for content with no canonical form. */
export function payloadHashOf(envelope: ApprovalEnvelope): string {
  return sha256Hex(canonicalJson(envelope));
}

/** The columns of a stored row that make up its envelope. */
export type StoredEnvelopeColumns = Pick<
  StoredProposal,
  "operation" | "subject" | "requester" | "projectId" | "runId" | "reason" | "payloadJson"
>;

/**
 * Rebuilds the envelope from a stored row and hashes it, so the engine can
 * check that the row still says what was hashed at submit (corruption or an
 * edit made behind the store's back). `null` when the payload was purged or is
 * not valid JSON: a missing or unreadable payload is never guessed at.
 */
export function recomputeFromStored(stored: StoredEnvelopeColumns): string | null {
  if (stored.payloadJson === null) return null;
  let payload: JsonValue;
  try {
    payload = JSON.parse(stored.payloadJson) as JsonValue;
  } catch {
    return null;
  }
  try {
    return payloadHashOf({
      operation: stored.operation,
      subject: stored.subject,
      requester: { kind: stored.requester.kind, label: stored.requester.label },
      projectId: stored.projectId,
      runId: stored.runId,
      reason: stored.reason,
      payload,
    });
  } catch {
    return null;
  }
}
