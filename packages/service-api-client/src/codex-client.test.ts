import type { HeadroomSignal } from "@ccc/domain";
import { CODEX_HEADROOM_PATH } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import * as codexClient from "./codex-client.js";
import { CodexRequestError, getCodexHeadroom } from "./codex-client.js";
import type { SocketApiClient, SocketRequestOptions, SocketResponse } from "./socket-api-client.js";
import { SocketUnreachableError } from "./socket-api-client.js";

/**
 * Plan 05.1-06: the Codex client maps a response (or a transport failure) to
 * a typed value or a fixed CodexRequestError code. A fake SocketApiClient is
 * used, as claude-client.test.ts does; the transport has its own tests.
 */

function fakeClient(
  handler: (opts: SocketRequestOptions) => SocketResponse<unknown>,
): SocketApiClient {
  return {
    request: <T>(opts: SocketRequestOptions) => Promise.resolve(handler(opts) as SocketResponse<T>),
  };
}

function fakeErrorClient(error: unknown): SocketApiClient {
  return { request: () => Promise.reject(error) };
}

function unreachable(code: string): SocketUnreachableError {
  const cause = Object.assign(new Error(code), { code }) as NodeJS.ErrnoException;
  return new SocketUnreachableError("/tmp/ccc.sock", cause);
}

const NOW = "2026-10-10T12:00:00.000Z";

const VALID_SIGNAL: HeadroomSignal = {
  generatedAt: NOW,
  codex: {
    verdict: "allow",
    reason: null,
    worstWindow: { windowMinutes: 10080, usedPercent: 41, resetsAt: "2026-10-14T00:00:00.000Z" },
    source: "app-server",
    observedAt: NOW,
    freshness: "live",
    pausedRuns: { count: 0, earliestResetAt: null },
  },
  claude: {
    kind: "available",
    window: "five-hour",
    usedPercent: 62,
    resetsAt: "2026-10-10T16:40:00.000Z",
    source: "claude-code-status-line",
    observedAt: NOW,
    freshness: "cached",
  },
};

async function failureOf(promise: Promise<unknown>): Promise<CodexRequestError> {
  const failure = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(CodexRequestError);
  return failure as CodexRequestError;
}

describe("getCodexHeadroom (tracer, CODEX-11, CODEX-12)", () => {
  it("Test 1: sends GET to the headroom path with no body and returns the parsed signal", async () => {
    let seen: SocketRequestOptions | undefined;
    const client = fakeClient((opts) => {
      seen = opts;
      return { status: 200, body: VALID_SIGNAL };
    });
    await expect(getCodexHeadroom(client)).resolves.toEqual(VALID_SIGNAL);
    expect(seen?.method).toBe("GET");
    expect(seen?.path).toBe(CODEX_HEADROOM_PATH);
    expect(seen?.body).toBeUndefined();
  });

  it("Test 2: a 200 body that fails the schema (a recommendedAgent key) is unrecognised-response", async () => {
    const client = fakeClient(() => ({
      status: 200,
      body: { ...VALID_SIGNAL, recommendedAgent: "codex" },
    }));
    const failure = await failureOf(getCodexHeadroom(client));
    expect(failure.code).toBe("unrecognised-response");
    expect(failure.status).toBe(200);
  });

  it("Test 3: a 503 { error: unavailable } carries status 503 and the fixed code", async () => {
    const client = fakeClient(() => ({ status: 503, body: { error: "unavailable" } }));
    const failure = await failureOf(getCodexHeadroom(client));
    expect(failure.status).toBe(503);
    expect(failure.code).toBe("unavailable");
  });

  it("Test 3: a 500 with free text is unrecognised-response and never surfaces that text", async () => {
    const secret = "stack trace at /Users/USERNAME/repo/secret.ts";
    const client = fakeClient(() => ({ status: 500, body: { error: secret } }));
    const failure = await failureOf(getCodexHeadroom(client));
    expect(failure.code).toBe("unrecognised-response");
    expect(failure.message).not.toContain("USERNAME");
    expect(failure.message).not.toContain("trace");
    expect(JSON.stringify(failure)).not.toContain("USERNAME");
  });

  it("Test 4: ETIMEDOUT maps to timeout and any other errno to service-disconnected", async () => {
    expect(
      (await failureOf(getCodexHeadroom(fakeErrorClient(unreachable("ETIMEDOUT"))))).code,
    ).toBe("timeout");
    expect(
      (await failureOf(getCodexHeadroom(fakeErrorClient(unreachable("ECONNREFUSED"))))).code,
    ).toBe("service-disconnected");
  });

  it("Test 5: the module has no function that posts to the headroom route", () => {
    const names = Object.keys(codexClient).filter((name) => /headroom/i.test(name));
    expect(names).toEqual(["getCodexHeadroom"]);
  });
});
