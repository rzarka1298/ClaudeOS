import type { ClaudeIntegrationStatus } from "@ccc/domain";
import { CLAUDE_INTEGRATION_PATH, CLAUDE_TRANSCRIPT_ANALYSIS_PATH } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  ClaudeRequestError,
  getClaudeIntegration,
  setTranscriptAnalysis,
} from "./claude-client.js";
import type { SocketApiClient, SocketRequestOptions, SocketResponse } from "./socket-api-client.js";
import { SocketUnreachableError } from "./socket-api-client.js";

/**
 * Task 1 (tracer): the settings tab reads Claude integration status and
 * flips transcript analysis through the service.
 *
 * These tests use a fake `SocketApiClient` rather than a real socket server
 * -- the transport itself is proven by `socket-api-client.test.ts`; what
 * this file proves is `claude-client.ts`'s own mapping from a response (or a
 * transport failure) to a typed value or a fixed {@link ClaudeRequestError}
 * code.
 */

function fakeClient(
  handler: (opts: SocketRequestOptions) => SocketResponse<unknown> | Promise<never>,
): SocketApiClient {
  return {
    request: async (opts) => {
      const result = handler(opts);
      return result as Promise<SocketResponse<unknown>>;
    },
  };
}

function fakeErrorClient(error: unknown): SocketApiClient {
  return {
    request: () => Promise.reject(error),
  };
}

const VALID_STATUS: ClaudeIntegrationStatus = {
  hooks: "installed",
  hookRuntimeMissing: false,
  disableAllHooks: false,
  lastEventAt: null,
  telemetry: { kind: "ok" },
  detectedClaudeVersion: null,
  statusLine: "installed",
  statusLineReported: true,
  transcriptAnalysis: { enabled: false },
  spoolDropCount: 0,
  unknownEventCount: 0,
  cleanupPeriodDays: 30,
};

function timeoutError(): SocketUnreachableError {
  const cause = Object.assign(new Error("request timed out"), {
    code: "ETIMEDOUT",
  }) as NodeJS.ErrnoException;
  return new SocketUnreachableError("/tmp/ccc.sock", cause);
}

function connectionRefusedError(): SocketUnreachableError {
  const cause = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  }) as NodeJS.ErrnoException;
  return new SocketUnreachableError("/tmp/ccc.sock", cause);
}

describe("getClaudeIntegration (Test 1)", () => {
  it("returns the parsed status for a 200", async () => {
    const client = fakeClient((opts) => {
      expect(opts.method).toBe("GET");
      expect(opts.path).toBe(CLAUDE_INTEGRATION_PATH);
      return { status: 200, body: VALID_STATUS };
    });

    await expect(getClaudeIntegration(client)).resolves.toEqual(VALID_STATUS);
  });

  it("maps a SocketUnreachableError to service-disconnected", async () => {
    const client = fakeErrorClient(connectionRefusedError());

    const failure = await getClaudeIntegration(client).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ClaudeRequestError);
    expect((failure as ClaudeRequestError).code).toBe("service-disconnected");
  });

  it("maps a timeout to the timeout code", async () => {
    const client = fakeErrorClient(timeoutError());

    const failure = await getClaudeIntegration(client).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ClaudeRequestError);
    expect((failure as ClaudeRequestError).code).toBe("timeout");
  });

  it("maps a 200 body failing the schema to unrecognised-response", async () => {
    const client = fakeClient(() => ({ status: 200, body: { nonsense: true } }));

    const failure = await getClaudeIntegration(client).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ClaudeRequestError);
    expect((failure as ClaudeRequestError).code).toBe("unrecognised-response");
  });
});

describe("setTranscriptAnalysis (Test 2)", () => {
  it("POSTs { enabled } to CLAUDE_TRANSCRIPT_ANALYSIS_PATH and returns the parsed body", async () => {
    const client = fakeClient((opts) => {
      expect(opts.method).toBe("POST");
      expect(opts.path).toBe(CLAUDE_TRANSCRIPT_ANALYSIS_PATH);
      expect(opts.body).toEqual({ enabled: true });
      return { status: 200, body: { enabled: true } };
    });

    await expect(setTranscriptAnalysis(client, true)).resolves.toEqual({ enabled: true });
  });
});
