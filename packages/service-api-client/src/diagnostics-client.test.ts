import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIAGNOSTICS_ERROR_CODES, DIAGNOSTICS_HEALTH_PATH } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  DIAGNOSTICS_CLIENT_TIMEOUT_MS,
  DiagnosticsRequestError,
  getDiagnosticsHealth,
} from "./diagnostics-client.js";
import type { SocketApiClient, SocketRequestOptions, SocketResponse } from "./socket-api-client.js";
import {
  createSocketApiClient,
  SocketUnreachableError,
  VaultSetupRequestError,
} from "./socket-api-client.js";

/**
 * Plan 08-07 Task 1 Test 3 (client; D-02, T-08-15): the diagnostics health client. A fake
 * `SocketApiClient` stands in for the transport, so this file proves the request shape and the
 * mapping from a response or a transport failure onto a closed code that carries no socket path
 * and no message text.
 */

const INSTANT = "2026-10-22T09:00:00.000Z";

function part(partId: string, reasonCode: string, status: string) {
  return { partId, status, reasonCode };
}

/** A fresh-install response: five setup-needed rows with real parts (the strict schema's shape). */
const HEALTH_RESPONSE = {
  generatedAt: INSTANT,
  service: { version: "0.1.0", startedAt: INSTANT, storeSchemaVersion: 12 },
  rows: [
    {
      id: "vault",
      status: "setup-needed",
      reasonCode: "vault-not-set-up",
      checkedAt: INSTANT,
      freshness: "live",
    },
    {
      id: "hooks",
      status: "setup-needed",
      reasonCode: "hooks-not-installed",
      checkedAt: INSTANT,
      freshness: "live",
    },
    {
      id: "collectors",
      status: "setup-needed",
      reasonCode: "statusline-not-installed",
      checkedAt: INSTANT,
      freshness: "live",
      parts: [
        part("telemetry", "telemetry-ok", "ok"),
        part("status-line", "statusline-not-installed", "setup-needed"),
        part("transcript-analysis", "analysis-off", "setup-needed"),
        part("spool", "spool-clean", "ok"),
        part("codex-install", "codex-not-installed", "setup-needed"),
        part("codex-hooks", "codex-hooks-not-installed", "setup-needed"),
        part("codex-bridge", "codex-bridge-not-installed", "setup-needed"),
        part("codex-doctor", "codex-doctor-not-run", "setup-needed"),
      ],
    },
    {
      id: "scheduler",
      status: "setup-needed",
      reasonCode: "never-run",
      checkedAt: INSTANT,
      freshness: "live",
      parts: [
        part("last-run", "never-run", "setup-needed"),
        part("research-key", "research-key-missing", "setup-needed"),
        part("sources", "sources-configured", "ok"),
      ],
    },
    {
      id: "launchers",
      status: "setup-needed",
      reasonCode: "launcher-not-set-up",
      checkedAt: INSTANT,
      freshness: "live",
      parts: ["antigravity", "claude-code", "claude-desktop", "codex"].map((id) =>
        part(id, "launcher-not-set-up", "setup-needed"),
      ),
    },
  ],
  keychain: { installSecret: "unknown", researchKey: "unknown" },
  paths: { vault: null, runtimeDir: "~/.example-runtime", socket: "~/.example-runtime/svc.sock" },
  vaultFingerprint: null,
  counts: { projects: null, scanFolders: null, openTasks: null, reports: null },
};

function recording(status: number, body: unknown) {
  const calls: SocketRequestOptions[] = [];
  const client: SocketApiClient = {
    request: <T>(opts: SocketRequestOptions) => {
      calls.push(opts);
      return Promise.resolve({ status, body } as SocketResponse<T>);
    },
  };
  return { client, calls };
}

function failing(error: unknown): SocketApiClient {
  return { request: () => Promise.reject(error) };
}

function unreachable(errno: string): SocketUnreachableError {
  return new SocketUnreachableError(
    "/Users/USERNAME/private/socket.sock",
    Object.assign(new Error(`connect failed ${errno}`), { code: errno }),
  );
}

async function rejection(promise: Promise<unknown>): Promise<DiagnosticsRequestError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DiagnosticsRequestError);
    return error as DiagnosticsRequestError;
  }
  throw new Error("expected the call to reject");
}

describe("the request shape", () => {
  it("sends a GET with no body to the fixed path, with its own 8-second timeout, and returns the parsed response", async () => {
    const { client, calls } = recording(200, HEALTH_RESPONSE);
    const response = await getDiagnosticsHealth(client);
    expect(response.rows).toHaveLength(5);
    expect(calls).toHaveLength(1);
    const call = calls[0] as SocketRequestOptions;
    expect(call.method).toBe("GET");
    expect(call.path.startsWith(DIAGNOSTICS_HEALTH_PATH)).toBe(true);
    expect(call.body).toBeUndefined();
    expect(call.timeoutMs).toBe(DIAGNOSTICS_CLIENT_TIMEOUT_MS);
    expect(DIAGNOSTICS_CLIENT_TIMEOUT_MS).toBe(8000);
  });

  it("sends trigger=reconnect unless the caller names a gesture (Amendment A1)", async () => {
    const reconnect = recording(200, HEALTH_RESPONSE);
    await getDiagnosticsHealth(reconnect.client);
    expect(reconnect.calls[0]?.path).toBe(`${DIAGNOSTICS_HEALTH_PATH}?trigger=reconnect`);

    const explicit = recording(200, HEALTH_RESPONSE);
    await getDiagnosticsHealth(explicit.client, "reconnect");
    expect(explicit.calls[0]?.path).toBe(`${DIAGNOSTICS_HEALTH_PATH}?trigger=reconnect`);

    const gesture = recording(200, HEALTH_RESPONSE);
    await getDiagnosticsHealth(gesture.client, "gesture");
    expect(gesture.calls[0]?.path).toBe(`${DIAGNOSTICS_HEALTH_PATH}?trigger=gesture`);
  });

  it("falls back to reconnect for a trigger value that is not one of the two", async () => {
    const { client, calls } = recording(200, HEALTH_RESPONSE);
    await getDiagnosticsHealth(client, "anything" as never);
    expect(calls[0]?.path).toBe(`${DIAGNOSTICS_HEALTH_PATH}?trigger=reconnect`);
  });
});

describe("the error mapping", () => {
  it("maps a closed non-200 body to DiagnosticsRequestError(status, code)", async () => {
    for (const [status, code] of [
      [503, "service-disconnected"],
      [500, "internal"],
    ] as const) {
      const { client } = recording(status, { error: code });
      const error = await rejection(getDiagnosticsHealth(client));
      expect(error.status).toBe(status);
      expect(error.code).toBe(code);
      expect(error.message).toBe(code);
    }
  });

  it("maps a non-200 body that is not a closed code, or carries an extra key, to unrecognised-response", async () => {
    for (const body of [
      { error: "something else" },
      { error: "internal", message: "/Users/USERNAME/x" },
      "plain text",
      undefined,
    ]) {
      const { client } = recording(500, body);
      const error = await rejection(getDiagnosticsHealth(client));
      expect(error.status).toBe(500);
      expect(error.code).toBe("unrecognised-response");
    }
  });

  it("maps a 200 body the strict schema refuses to unrecognised-response", async () => {
    for (const body of [
      {},
      { ...HEALTH_RESPONSE, extra: 1 },
      { ...HEALTH_RESPONSE, rows: HEALTH_RESPONSE.rows.slice(0, 4) },
      undefined,
    ]) {
      const { client } = recording(200, body);
      const error = await rejection(getDiagnosticsHealth(client));
      expect(error.status).toBe(200);
      expect(error.code).toBe("unrecognised-response");
    }
  });

  it("maps a socket timeout to timeout and any other unreachable socket to service-disconnected, naming no path", async () => {
    const timedOut = await rejection(getDiagnosticsHealth(failing(unreachable("ETIMEDOUT"))));
    expect(timedOut.code).toBe("timeout");
    expect(timedOut.status).toBe(0);
    for (const errno of ["ECONNREFUSED", "ENOENT", "ECONNRESET"]) {
      const error = await rejection(getDiagnosticsHealth(failing(unreachable(errno))));
      expect(error.code, errno).toBe("service-disconnected");
      expect(error.message).not.toContain("Users");
      expect(error.message).not.toContain("socket.sock");
    }
  });

  it("only ever carries a code the domain lists", async () => {
    const { client } = recording(500, { error: "internal" });
    const error = await rejection(getDiagnosticsHealth(client));
    expect(DIAGNOSTICS_ERROR_CODES).toContain(error.code);
  });
});

describe("FIX2A F10: the transport's own refusal of a body it cannot use is a closed code, keeping the status", () => {
  const refusal = (status: number) =>
    new VaultSetupRequestError(
      status,
      "The service returned a response this client does not recognise. (/Users/USERNAME/x)",
    );

  it("maps a non-JSON body (the transport throws VaultSetupRequestError) to unrecognised-response with the HTTP status", async () => {
    for (const status of [200, 500, 502]) {
      const error = await rejection(getDiagnosticsHealth(failing(refusal(status))));
      expect(error.code).toBe("unrecognised-response");
      expect(error.status).toBe(status);
      expect(error.message).toBe("unrecognised-response");
    }
  });

  it("maps an over-64-KiB body the same way, and carries none of the transport's text", async () => {
    const error = await rejection(getDiagnosticsHealth(failing(refusal(200))));
    expect(error.code).toBe("unrecognised-response");
    expect(JSON.stringify({ message: error.message, code: error.code })).not.toContain("USERNAME");
    expect(error).not.toBeInstanceOf(VaultSetupRequestError);
  });

  it("still lets an error it does not know escape, and still maps an unreachable socket", async () => {
    await expect(getDiagnosticsHealth(failing(new TypeError("boom")))).rejects.toThrow(TypeError);
    const error = await rejection(getDiagnosticsHealth(failing(unreachable("ETIMEDOUT"))));
    expect(error.code).toBe("timeout");
  });
});

describe("FIX2A F10: through the real transport", () => {
  async function against(
    handler: (res: ServerResponse) => void,
    run: (client: SocketApiClient) => Promise<void>,
  ): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "ccc-diag-sock-"));
    const socketPath = join(dir, "t.sock");
    const server = createServer((_req, res) => handler(res));
    await new Promise<void>((done) => server.listen(socketPath, done));
    try {
      await run(createSocketApiClient({ socketPath, timeoutMs: 2000 }));
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("a proxy error page (not JSON) reads unrecognised-response and keeps the HTTP status", async () => {
    await against(
      (res) => {
        res.writeHead(502, { "content-type": "text/html" });
        res.end("<html>Bad gateway at /Users/USERNAME/x</html>");
      },
      async (client) => {
        const error = await rejection(getDiagnosticsHealth(client));
        expect(error.code).toBe("unrecognised-response");
        expect(error.status).toBe(502);
      },
    );
  });

  it("a body over 64 KiB reads unrecognised-response and keeps the HTTP status", async () => {
    await against(
      (res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ padding: "x".repeat(70 * 1024) }));
      },
      async (client) => {
        const error = await rejection(getDiagnosticsHealth(client));
        expect(error.code).toBe("unrecognised-response");
        expect(error.status).toBe(200);
      },
    );
  });
});
