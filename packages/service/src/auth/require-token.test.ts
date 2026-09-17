import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// `./require-token.js` imports the service's real, redacting singleton
// logger (`../logging.js`), which eagerly resolves its destination file
// from `CCC_RUNTIME_DIR` at import time (the same discipline every
// socket-path-bearing test in this repo already follows). Set it, and the
// log file it implies, before the dynamic import below runs.
const runtimeDir = mkdtempSync(join(tmpdir(), "ccc-require-token-test-"));
process.env.CCC_RUNTIME_DIR = runtimeDir;
const logPath = join(runtimeDir, "logs", "service.log");

const { requireToken } = await import("./require-token.js");
const { mintToken } = await import("./token.js");

afterAll(() => {
  delete process.env.CCC_RUNTIME_DIR;
  rmSync(runtimeDir, { recursive: true, force: true });
});

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

function readLogLines(): Array<Record<string, unknown>> {
  const raw = readFileSync(logPath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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

  it("routes the rejection reason through the redacting logger (never console), and never logs the raw token bytes", () => {
    const handler = vi.fn();
    const wrapped = requireToken(() => SECRET, handler);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const rawGarbageToken = "not-a-real-token-marker-xyz789";
    wrapped(fakeReq({ authorization: `Bearer ${rawGarbageToken}` }), fakeRes());
    wrapped(fakeReq({}), fakeRes());

    // Rejection is never surfaced via a raw console write.
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();

    const lines = readLogLines();
    const rejectionLines = lines.filter((l) => l.msg === "authentication rejected");
    expect(rejectionLines.length).toBeGreaterThanOrEqual(2);
    const reasons = rejectionLines.map((l) => l.reason);
    expect(reasons).toContain("missing");
    expect(reasons).toContain("malformed");

    const rawLogText = readFileSync(logPath, "utf8");
    expect(rawLogText).not.toContain(rawGarbageToken);
  });
});
