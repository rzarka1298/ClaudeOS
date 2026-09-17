import { z } from "zod";
import { API_BASE } from "./api.js";

/**
 * The bearer token's time-to-live: one hour, literally, in milliseconds.
 * Research §Pattern 4 / ADR-0016: short-lived so a credential that leaks
 * into a log line is contained rather than permanent.
 */
export const TOKEN_TTL_MS = 60 * 60 * 1000;

/** The header every authenticated request carries its bearer token in. */
export const AUTH_HEADER = "authorization";

/**
 * `POST /api/v1/handshake` — the only route not wrapped in `requireToken`.
 * The socket's `0600` permission is the authorization event for reaching
 * it at all (ADR-0016); it mints a bearer token for every other route.
 */
export const HANDSHAKE_PATH = `${API_BASE}/handshake`;

/** `GET /api/v1/health` — requires a valid `Authorization: Bearer <token>`. */
export const HEALTH_PATH = `${API_BASE}/health`;

export const HandshakeResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
});
export type HandshakeResponse = z.infer<typeof HandshakeResponseSchema>;

export const TokenPayloadSchema = z.object({
  issuedAt: z.number(),
  expiresAt: z.number(),
  nonce: z.string(),
});
export type TokenPayload = z.infer<typeof TokenPayloadSchema>;
