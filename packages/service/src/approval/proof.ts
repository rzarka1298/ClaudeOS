import { createHmac, createPublicKey, hkdfSync, timingSafeEqual, verify } from "node:crypto";
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
 * The `presence` member (09-18) is `null` for an operation that needs no presence, and
 * `{ scheme: "p256", sig }` for a presence-required one: the presence helper's ECDSA P-256 signature over
 * {@link presenceMessage}, which verifies against the public key pinned in the helper-only Keychain item.
 * The MAC does not cover it (the 09-16 known-answer vector is fixed); the signature binds the same id,
 * operation, payload hash and approval instant on its own, so a MAC-valid row with no, a copied or a
 * forged presence part is refused wherever the row's operation needs presence.
 */

/** The HKDF `info` string. A new version of the proof format changes it, so old keys never sign new proofs. */
const PROOF_KEY_INFO = "ccc approval decision proof v1";

/** The proof format version carried in the MAC input and the stored JSON. */
const PROOF_VERSION = 1;

/** A derived key is 32 bytes (the HMAC-SHA256 block-friendly size). */
const PROOF_KEY_BYTES = 32;

/** The shortest install secret accepted (the service generates 32 random bytes). */
const MIN_INSTALL_SECRET_BYTES = 32;

/**
 * Derives the proof key from the install secret: HKDF-SHA256, empty salt, a fixed `info`. The same
 * secret always gives the same key, a different secret a different one, and the key is never the secret. Throws a `RangeError` for a secret under 32 bytes.
 */
export function approvalProofKey(installSecret: Buffer): Buffer {
  // The install secret is 32 random bytes. A shorter one (an empty buffer most of all) would derive a
  // constant, public key, so refuse it rather than mint proofs anyone could compute.
  if (installSecret.length < MIN_INSTALL_SECRET_BYTES) {
    throw new RangeError(
      `approvalProofKey: the install secret must be at least ${MIN_INSTALL_SECRET_BYTES} bytes`,
    );
  }
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

/** Canonical base64 of 8..80 bytes (a DER ECDSA P-256 signature is 70 to 72). */
function isSignatureBase64(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value && bytes.length >= 8 && bytes.length <= 80;
}

/** The presence part of a stored proof: the helper's signature, or null when the operation needs no presence. */
export const PresencePartSchema = z.strictObject({
  scheme: z.literal("p256"),
  sig: z.string().refine(isSignatureBase64),
});

export type PresencePart = z.infer<typeof PresencePartSchema>;

/**
 * The stored proof, strict: exactly these three members. `mac` is 64 lowercase hex digits (32 bytes).
 * `presence` is null or the helper's `{ scheme: "p256", sig }` (the recorded custody is K-ATTR, so there is no
 * `none` scheme to store).
 */
export const DecisionProofSchema = z
  .object({
    v: z.literal(PROOF_VERSION),
    mac: z.string().regex(/^[0-9a-f]{64}$/),
    presence: PresencePartSchema.nullable(),
  })
  .strict();

export type DecisionProof = z.infer<typeof DecisionProofSchema>;

/** What the owner's gesture vouches for: one proposal, one operation, one payload, one approval instant. */
export interface PresenceMessageFields {
  readonly proposalId: string;
  readonly operation: string;
  readonly payloadHash: string;
  readonly approvedAt: string;
}

/**
 * THE canonical message the presence helper signs (and the prompt is built from): canonical JSON of
 * `{ v: 1, proposalId, operation, payloadHash, decision: "approve", approvedAt }`. The adapter passes it to the
 * helper and this file verifies the helper's signature over it, so there is exactly one builder (T-09-40).
 */
export function presenceMessage(fields: PresenceMessageFields): string {
  return canonicalJson({
    v: 1,
    proposalId: fields.proposalId,
    operation: fields.operation,
    payloadHash: fields.payloadHash,
    decision: "approve",
    approvedAt: fields.approvedAt,
  });
}

function canonicalBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

/**
 * True only when `sigB64` is a DER ECDSA P-256 / SHA-256 signature of exactly `message`'s UTF-8 bytes made by
 * the private half of `pinB64` (base64 of a DER SPKI public key on the prime256v1 curve). Any malformed input,
 * a key of another type or curve, and any mismatch are false; nothing here throws.
 */
export function verifyPresenceSignature(pinB64: string, message: string, sigB64: string): boolean {
  try {
    const der = canonicalBase64(pinB64);
    const sig = canonicalBase64(sigB64);
    if (der === null || sig === null || sig.length === 0) return false;
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      return false;
    }
    return verify("sha256", Buffer.from(message, "utf8"), { key, dsaEncoding: "der" }, sig);
  } catch {
    return false;
  }
}

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
export function signDecisionProof(
  key: Buffer,
  fields: DecisionMacFields,
  presence: PresencePart | null,
): string {
  const proof: DecisionProof = {
    v: PROOF_VERSION,
    mac: macOf(key, fields).toString("hex"),
    presence,
  };
  return canonicalJson(proof);
}

/** What the check needs to know about the row's operation and the pin the presence part is verified against. */
export interface ProofCheckOptions {
  /** True when the row's classification says `presence: "required"`. */
  readonly presenceRequired: boolean;
  /** The pinned public key (base64 SPKI), or null when none could be read (a presence-required row is then invalid). */
  readonly pin: string | null;
}

/**
 * Checks a stored row's proof against the fields of that same row. An absent or null proof, text that is
 * not the strict JSON shape, a row with no approval instant or channel, and any mismatch are all
 * `invalid`: nothing here throws and nothing is guessed. The comparison is constant-time.
 *
 * For a presence-required row the MAC alone is never enough (R-05): the row must be decided via `presence`,
 * and its presence part must verify, against `pin`, over the presence message of THIS row. A row that needs no
 * presence must carry a null presence part. `options` is required, so no caller can forget the question.
 */
export function verifyDecisionProof(
  key: Buffer,
  row: Pick<
    StoredProposal,
    "proposalId" | "operation" | "payloadHash" | "approvedAt" | "decidedVia" | "decisionProof"
  >,
  options: ProofCheckOptions,
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
    if (!timingSafeEqual(claimed, expected)) return "invalid";
    const part = parsed.data.presence;
    if (!options.presenceRequired) return part === null ? "valid" : "invalid";
    if (part === null || options.pin === null || fields.decidedVia !== "presence") return "invalid";
    return verifyPresenceSignature(options.pin, presenceMessage(fields), part.sig)
      ? "valid"
      : "invalid";
  } catch {
    return "invalid";
  }
}
