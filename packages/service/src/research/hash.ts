import { createHash, randomBytes } from "node:crypto";
import { canonicalHashInput } from "@ccc/research";

/**
 * The service-side hashing of the research pipeline (D-11, research Pattern 4). `@ccc/research`
 * is Node-free, so it fixes the string that is hashed (`canonicalHashInput`) and the hashing
 * itself happens here.
 */

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A source id: the first 32 hex characters of the SHA-256 of the canonical address. */
export function sourceIdFor(canonicalUrl: string): string {
  return sha256Hex(canonicalUrl).slice(0, 32);
}

/**
 * A source reference's content hash: the SHA-256 of the canonical form of the text, so it can be
 * recomputed from a raw note body. The vault writer is handed this function and recomputes the
 * hash itself rather than trusting the reference (wave 3 review A4).
 */
export function contentHashFor(text: string): string {
  return sha256Hex(canonicalHashInput(text));
}

/** A fresh run nonce: 32 lowercase hex characters from random bytes. */
export function newNonce(): string {
  return randomBytes(16).toString("hex");
}
