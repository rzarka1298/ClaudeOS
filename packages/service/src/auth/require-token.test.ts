import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { requireToken } from "./require-token.js";
import { mintToken } from "./token.js";

const SECRET = Buffer.from("require-token-test-secret-000000", "utf8");

function fakeReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

interface FakeResponse {
  statusCode: number;
  body: string;
}

function fakeRes(): ServerResponse & FakeResponse {
  const res = {
    statusCode: 0,
    body: "",
  } as FakeResponse;
  const target = res as unknown as Record<string, unknown>;
  target.writeHead = (status: number): FakeResponse => {
    res.statusCode = status;
    return res;
  };
  target.end = (chunk?: string): void => {
    res.body = chunk ?? "";
  };
  return res as unknown as ServerResponse & FakeResponse;
}

describe("requireToken", () => {
  it("rejects a request with no authorization header", () => {
    const handler = vi.fn();
    const wrapped = requireToken(() => SECRET, handler);
    const res = fakeRes();
    wrapped(fakeReq({}), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe('{"error":"authentication required"}');
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a request with authorization: Bearer <garbage>", () => {
    const handler = vi.fn();
    const wrapped = requireToken(() => SECRET, handler);
    const res = fakeRes();
    wrapped(fakeReq({ authorization: "Bearer garbage" }), res);
    expect(res.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("invokes the wrapped handler exactly once for a valid token", () => {
    const handler = vi.fn();
    const wrapped = requireToken(() => SECRET, handler);
    const token = mintToken(SECRET, { nowMs: Date.now() });
    const res = fakeRes();
    wrapped(fakeReq({ authorization: `Bearer ${token}` }), res);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("never leaks the specific failure reason (signature/expired/malformed) into the 401 body", () => {
    const handler = vi.fn();
    const wrapped = requireToken(() => SECRET, handler);
    const cases: Array<Record<string, string>> = [
      { authorization: "Bearer garbage" },
      {},
      { authorization: "Bearer v1.x.y" },
    ];
    for (const headers of cases) {
      const res = fakeRes();
      wrapped(fakeReq(headers), res);
      expect(res.body).not.toMatch(/signature|expired|malformed/);
      expect(res.statusCode).toBe(401);
    }
  });
});
