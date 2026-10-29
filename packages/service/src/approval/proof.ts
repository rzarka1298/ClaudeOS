import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { canonicalJson, type DecidedVia, type StoredProposal } from "@ccc/domain";
import { z } from "zod";

/**
 * The decision proof (09-16, D-03, APPR-12): a MAC the service writes into an approved row at the
 * moment of approval, and checks again before anything that row authorises is run.
 *
 * What it is: a detection floor. `mac` is HMAC-SHA256 over the canonical JSON of
 * `{ v: 1, proposalId, operation, payloadHash, state: "approved", approvedAt, decidedVia }`, keyed by a
 * key derived (HKDF-SHA256) from the install secret that lives in the macOS Keychain. A row that was
 * inserted or edited by something that does not hold that key fails the check, and a valid proof copied
 * onto another row fails too, because the MAC binds the row's id, operation, payload hash, approval
 * instant and channel.
 *
 * What it is not: a boundary. A process of the same user that can read the install secret (through
 * `/usr/bin/security`, for one) can compute a valid MAC. So the MAC is never the only check for a
 * presence-required row; the operating-system-anchored signature (09-18) is. The socket token never
 * carries this key and nothing here is logged: the key, the proof and the MAC input stay in memory and
 * in the row.
 *
 * The `presence` member is `null` until 09-18 widens it to carry the helper's signature.
 */

/** The HKDF `info` string. A new version of the proof format changes it, so old keys never sign new proofs. */
const PROOF_KEY_INFO = "ccc approval decision proof v1";

/** The proof format version carried in the MAC input and the stored JSON. */
const PROOF_VERSION = 1;

/** A derived key is 32 bytes (the HMAC-SHA256 block-friendly size). */
const PROOF_KEY_BYTES = 32;

/**
 * Derives the proof key from the install secret: HKDF-SHA256, empty salt, a fixed `info`. The same
 * secret always gives the same key, a different secret a different one, and the key is never the secret.
 */
export function approvalProofKey(installSecret: Buffer): Buffer {
  const derived = hkdfSync(
    "sha256",
    installSecret,
    Buffer.alloc(0),
    PROOF_KEY_INFO,
    PROOF_KEY_BYTES,
  );
  return Buffer.from(derived);
}

/** The columns of an approved row that the MAC covers. */
export interface DecisionMacFields {
  readonly proposalId: StoredProposal["proposalId"];
  readonly operation: string;
  readonly payloadHash: string;
  /** The instant the owner vouched for the approval (ISO 8601 UTC). */
  readonly approvedAt: string;
  readonly decidedVia: DecidedVia;
}

/**
 * Reads the covered fields off a stored row, or null when the row has no approval instant or no
 * channel (it was never approved, so no proof can match it).
 */
export function decisionMacFields(
  row: Pick<
    StoredProposal,
    "proposalId" | "operation" | "payloadHash" | "approvedAt" | "decidedVia"
  >,
): DecisionMacFields | null {
  if (row.approvedAt === null || row.decidedVia === null) return null;
  return {
    proposalId: row.proposalId,
    operation: row.operation,
    payloadHash: row.payloadHash,
    approvedAt: row.approvedAt,
    decidedVia: row.decidedVia,
  };
}

/**
 * The stored proof, strict: exactly these three members. `mac` is 64 lowercase hex digits (32 bytes).
 * `presence` is `z.null()` for now; 09-18 widens it.
 */
export const DecisionProofSchema = z
  .object({
    v: z.literal(PROOF_VERSION),
    mac: z.string().regex(/^[0-9a-f]{64}$/),
    presence: z.null(),
  })
  .strict();

export type DecisionProof = z.infer<typeof DecisionProofSchema>;

function macOf(key: Buffer, fields: DecisionMacFields): Buffer {
  const input = canonicalJson({
    v: PROOF_VERSION,
    proposalId: fields.proposalId,
    operation: fields.operation,
    payloadHash: fields.payloadHash,
    state: "approved",
    approvedAt: fields.approvedAt,
    decidedVia: fields.decidedVia,
  });
  return createHmac("sha256", key).update(input, "utf8").digest();
}

/** Makes the proof text to store with an approving decision. Throws a `TypeError` for fields with no canonical form. */
export function signDecisionProof(key: Buffer, fields: DecisionMacFields, presence: null): string {
  const proof: DecisionProof = {
    v: PROOF_VERSION,
    mac: macOf(key, fields).toString("hex"),
    presence,
  };
  return canonicalJson(proof);
}

/**
 * Checks a stored row's proof against the fields of that same row. An absent or null proof, text that is
 * not the strict JSON shape, a row with no approval instant or channel, and any mismatch are all
 * `invalid`: nothing here throws and nothing is guessed. The comparison is constant-time.
 */
export function verifyDecisionProof(
  key: Buffer,
  row: Pick<
    StoredProposal,
    "proposalId" | "operation" | "payloadHash" | "approvedAt" | "decidedVia" | "decisionProof"
  >,
): "valid" | "invalid" {
  const text = row.decisionProof;
  if (text === undefined || text === null) return "invalid";
  const fields = decisionMacFields(row);
  if (fields === null) return "invalid";
  try {
    const parsed = DecisionProofSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return "invalid";
    const claimed = Buffer.from(parsed.data.mac, "hex");
    const expected = macOf(key, fields);
    if (claimed.length !== expected.length) return "invalid";
    return timingSafeEqual(claimed, expected) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}
