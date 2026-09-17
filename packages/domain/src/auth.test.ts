import { describe, expect, it } from "vitest";
import {
  AUTH_HEADER,
  HANDSHAKE_PATH,
  HandshakeResponseSchema,
  HEALTH_PATH,
  TOKEN_TTL_MS,
  TokenPayloadSchema,
} from "./auth.js";

describe("auth schemas and constants", () => {
  it("HandshakeResponseSchema accepts a well-formed handshake response", () => {
    const result = HandshakeResponseSchema.safeParse({
      token: "v1.abc.def",
      expiresAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("HandshakeResponseSchema rejects a body missing token", () => {
    const result = HandshakeResponseSchema.safeParse({ expiresAt: new Date().toISOString() });
    expect(result.success).toBe(false);
  });

  it("TokenPayloadSchema accepts a well-formed payload", () => {
    const result = TokenPayloadSchema.safeParse({
      issuedAt: Date.now(),
      expiresAt: Date.now() + TOKEN_TTL_MS,
      nonce: "abc123",
    });
    expect(result.success).toBe(true);
  });

  it("TokenPayloadSchema rejects a payload missing nonce", () => {
    const result = TokenPayloadSchema.safeParse({
      issuedAt: Date.now(),
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });
    expect(result.success).toBe(false);
  });

  it("exports the one-hour token TTL literal", () => {
    expect(TOKEN_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("exports the shared auth header name and route path constants", () => {
    expect(AUTH_HEADER).toBe("authorization");
    expect(HANDSHAKE_PATH).toBe("/api/v1/handshake");
    expect(HEALTH_PATH).toBe("/api/v1/health");
  });
});
