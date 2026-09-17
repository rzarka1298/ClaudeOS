import { describe, expect, it } from "vitest";
import { mintToken, verifyToken } from "./token.js";

const SECRET = Buffer.from("test-secret-material-0123456789", "utf8");
const OTHER_SECRET = Buffer.from("a-different-secret-material-000", "utf8");

describe("mintToken / verifyToken", () => {
  it("mints a token with three dot-separated segments that verifies against the same secret", () => {
    const nowMs = Date.now();
    const token = mintToken(SECRET, { nowMs });
    expect(token.split(".")).toHaveLength(3);
    expect(verifyToken(SECRET, token, { nowMs })).toEqual({ ok: true });
  });

  it("rejects a token verified against a different secret", () => {
    const nowMs = Date.now();
    const token = mintToken(SECRET, { nowMs });
    expect(verifyToken(OTHER_SECRET, token, { nowMs })).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("rejects a token one millisecond past its expiry", () => {
    const nowMs = Date.now();
    const token = mintToken(SECRET, { nowMs });
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as {
      expiresAt: number;
    };
    expect(verifyToken(SECRET, token, { nowMs: payload.expiresAt + 1 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a token whose payload segment was edited by one character", () => {
    const nowMs = Date.now();
    const token = mintToken(SECRET, { nowMs });
    const parts = token.split(".");
    const payload = parts[1] ?? "";
    const flippedChar = payload[0] === "A" ? "B" : "A";
    const tampered = [parts[0], flippedChar + payload.slice(1), parts[2]].join(".");
    expect(verifyToken(SECRET, tampered, { nowMs })).toEqual({ ok: false, reason: "signature" });
  });

  it("mints two different tokens at the same instant because the nonce differs", () => {
    const nowMs = Date.now();
    expect(mintToken(SECRET, { nowMs })).not.toBe(mintToken(SECRET, { nowMs }));
  });

  it("rejects a syntactically malformed token without throwing", () => {
    expect(() => verifyToken(SECRET, "not-a-token", { nowMs: Date.now() })).not.toThrow();
    expect(verifyToken(SECRET, "not-a-token", { nowMs: Date.now() })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects an empty string without throwing", () => {
    expect(verifyToken(SECRET, "", { nowMs: Date.now() })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
