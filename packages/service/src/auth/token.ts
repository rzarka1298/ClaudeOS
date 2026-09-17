import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { TOKEN_TTL_MS, type TokenPayload } from "@ccc/domain";

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "signature" | "expired" | "malformed" };

const TOKEN_VERSION = "v1";

function sign(secret: Buffer, encodedPayload: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

/**
 * Mints a bearer token: a versioned, base64url-encoded {@link TokenPayload}
 * plus an HMAC-SHA256 signature over that encoded payload, joined with
 * dots as `v1.<payload>.<signature>`. Uses `node:crypto` exclusively — no
 * third-party signing library (research §Pattern 4 / ADR-0016).
 */
export function mintToken(secret: Buffer, opts: { nowMs: number }): string {
  const payload: TokenPayload = {
    issuedAt: opts.nowMs,
    expiresAt: opts.nowMs + TOKEN_TTL_MS,
    nonce: randomBytes(16).toString("base64url"),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = sign(secret, encodedPayload);
  return `${TOKEN_VERSION}.${encodedPayload}.${signature}`;
}

/**
 * Verifies a token: checks structure, then the HMAC signature over the
 * still-encoded payload segment (via `timingSafeEqual` on equal-length
 * buffers) BEFORE ever decoding or parsing that payload — a tampered
 * payload therefore always fails as a signature mismatch, never a parse
 * error, matching the token.test.ts "edited by one character" case. Never
 * throws; the caller decides the response status from the discriminated
 * result, and the specific reason never reaches the response body
 * (require-token.ts keeps it in the log only).
 */
export function verifyToken(secret: Buffer, token: string, opts: { nowMs: number }): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    return { ok: false, reason: "malformed" };
  }
  const [, encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) {
    return { ok: false, reason: "malformed" };
  }

  const expectedSignature = sign(secret, encodedPayload);
  const expectedBuf = Buffer.from(expectedSignature, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false, reason: "signature" };
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.expiresAt !== "number") {
    return { ok: false, reason: "malformed" };
  }

  if (opts.nowMs > payload.expiresAt) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true };
}
