import { mkdtempSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VAULT_SETUP_PATH,
  VAULT_SETUP_PLAN_PATH,
  type VaultSetupPlanResponse,
  type VaultSetupResponse,
} from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  createSocketApiClient,
  requestVaultSetup,
  requestVaultSetupPlan,
  type SocketApiClient,
  type SocketRequestOptions,
  SocketUnreachableError,
  VaultSetupRequestError,
} from "./socket-api-client.js";

describe("createSocketApiClient", () => {
  it("rejects with SocketUnreachableError when no socket is listening", async () => {
    const socketPath = join(tmpdir(), "ccc-no-such-socket.sock");
    const client = createSocketApiClient({ socketPath, timeoutMs: 1000 });
    await expect(client.request({ method: "GET", path: "/api/v1/health" })).rejects.toBeInstanceOf(
      SocketUnreachableError,
    );
  });
});

/**
 * A real Unix-domain-socket server replaying one canned reply.
 *
 * These cases need the genuine transport rather than the client double
 * below: the defect they cover lives in the response event handlers, which
 * a fake `request()` never exercises at all. Every handler there fires
 * AFTER the Promise executor has returned, so a throw inside one escapes
 * the promise entirely -- an uncaught exception in Obsidian's renderer plus
 * a caller `await` that never settles.
 */
async function withSocketServer(
  handler: (res: ServerResponse) => void,
  run: (client: SocketApiClient) => Promise<void>,
): Promise<void> {
  const socketPath = join(mkdtempSync(join(tmpdir(), "ccc-sock-")), "t.sock");
  const server = createServer((_req, res) => handler(res));
  await new Promise<void>((done) => server.listen(socketPath, done));
  try {
    await run(createSocketApiClient({ socketPath, timeoutMs: 2000 }));
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

/** Rejects if the promise has not settled within `ms` -- the assertion that
 * distinguishes "reported a failure" from "hung forever", which is the
 * actual symptom being fixed. */
function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, fail) =>
      setTimeout(() => fail(new Error(`promise never settled within ${ms}ms`)), ms),
    ),
  ]);
}

describe("createSocketApiClient response handling", () => {
  it("rejects rather than stranding the caller when the body is not JSON", async () => {
    await withSocketServer(
      (res) => {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end("<html><body>Proxy error</body></html>");
      },
      async (client) => {
        await expect(
          settlesWithin(client.request({ method: "GET", path: "/api/v1/health" }), 2000),
        ).rejects.toBeInstanceOf(VaultSetupRequestError);
      },
    );
  });

  it("rejects when the connection is torn down after the headers, which emits no end event", async () => {
    await withSocketServer(
      (res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"partial":');
        res.socket?.destroy();
      },
      async (client) => {
        await expect(
          settlesWithin(client.request({ method: "GET", path: "/api/v1/health" }), 2000),
        ).rejects.toBeInstanceOf(Error);
      },
    );
  });

  it("refuses a response larger than the inbound cap instead of buffering it without bound", async () => {
    await withSocketServer(
      (res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        // 128 KiB of valid JSON: parseable, and twice the cap the service
        // applies in the other direction.
        res.end(JSON.stringify({ pad: "x".repeat(128 * 1024) }));
      },
      async (client) => {
        await expect(
          settlesWithin(client.request({ method: "GET", path: "/api/v1/health" }), 2000),
        ).rejects.toBeInstanceOf(VaultSetupRequestError);
      },
    );
  });

  it("still returns a well-formed JSON body unchanged", async () => {
    await withSocketServer(
      (res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      },
      async (client) => {
        const res = await settlesWithin(
          client.request<{ status: string }>({ method: "GET", path: "/api/v1/health" }),
          2000,
        );
        expect(res).toEqual({ status: 200, body: { status: "ok" } });
      },
    );
  });

  it("returns undefined for an empty body rather than trying to parse it", async () => {
    await withSocketServer(
      (res) => {
        res.writeHead(204);
        res.end();
      },
      async (client) => {
        const res = await settlesWithin(
          client.request({ method: "GET", path: "/api/v1/health" }),
          2000,
        );
        expect(res).toEqual({ status: 204, body: undefined });
      },
    );
  });
});

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

/**
 * A client double that records what was asked of it and replays a canned
 * reply. Deliberately NOT a live socket: these tests are about the two
 * vault-setup wrappers — which path they post to, what body they send, and
 * how they turn a status and a body into a value or an error. The real
 * transport is already covered by the unreachable-socket test above and by
 * the service's own route suite over a real socket.
 */
function fakeClient(reply: { status: number; body: unknown }): {
  client: SocketApiClient;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    client: {
      request<T>(opts: SocketRequestOptions): Promise<{ status: number; body: T }> {
        requests.push({ method: opts.method, path: opts.path, body: opts.body });
        return Promise.resolve({ status: reply.status, body: reply.body as T });
      },
    },
  };
}

const PLAN_BODY: VaultSetupPlanResponse = {
  vaultRoot: "/Users/USERNAME/Vault",
  entries: [
    { relativePath: "global", kind: "folder", exists: false },
    { relativePath: "global/index.md", kind: "index", exists: true },
    { relativePath: "CLAUDE.md", kind: "claude-md", exists: false },
  ],
};

const SETUP_BODY: VaultSetupResponse = {
  created: ["global", "CLAUDE.md"],
  existing: ["inbox"],
};

describe("requestVaultSetupPlan", () => {
  it("posts the vault root to the plan path and returns the parsed entry list", async () => {
    const { client, requests } = fakeClient({ status: 200, body: PLAN_BODY });

    const plan = await requestVaultSetupPlan(client, "/Users/USERNAME/Vault");

    expect(requests).toEqual([
      { method: "POST", path: VAULT_SETUP_PLAN_PATH, body: { vaultRoot: "/Users/USERNAME/Vault" } },
    ]);
    expect(plan).toEqual(PLAN_BODY);
  });

  it("maps a non-200 into VaultSetupRequestError carrying the status and the service's own message", async () => {
    const { client } = fakeClient({ status: 422, body: { error: "vault root does not exist" } });

    await expect(requestVaultSetupPlan(client, "/Users/USERNAME/Nope")).rejects.toMatchObject({
      name: "VaultSetupRequestError",
      status: 422,
      message: "vault root does not exist",
    });
  });

  it("maps a 401 into VaultSetupRequestError rather than returning a body the caller would misread", async () => {
    const { client } = fakeClient({ status: 401, body: { error: "authentication required" } });

    await expect(requestVaultSetupPlan(client, "/Users/USERNAME/Vault")).rejects.toBeInstanceOf(
      VaultSetupRequestError,
    );
  });

  it("refuses a 200 whose body does not match the plan schema", async () => {
    const { client } = fakeClient({
      status: 200,
      body: { vaultRoot: "/x", entries: "not a list" },
    });

    await expect(requestVaultSetupPlan(client, "/Users/USERNAME/Vault")).rejects.toBeInstanceOf(
      VaultSetupRequestError,
    );
  });

  it("falls back to a constant message when an error body carries no error field", async () => {
    const { client } = fakeClient({ status: 500, body: undefined });

    await expect(requestVaultSetupPlan(client, "/Users/USERNAME/Vault")).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining("service"),
    });
  });
});

describe("requestVaultSetup", () => {
  it("posts the vault root to the setup path and returns the created/existing split", async () => {
    const { client, requests } = fakeClient({ status: 200, body: SETUP_BODY });

    const result = await requestVaultSetup(client, "/Users/USERNAME/Vault");

    expect(requests).toEqual([
      { method: "POST", path: VAULT_SETUP_PATH, body: { vaultRoot: "/Users/USERNAME/Vault" } },
    ]);
    expect(result).toEqual(SETUP_BODY);
  });

  it("maps a 400 into VaultSetupRequestError carrying the status and message", async () => {
    const { client } = fakeClient({ status: 400, body: { error: "invalid request body" } });

    await expect(requestVaultSetup(client, "relative/Vault")).rejects.toMatchObject({
      name: "VaultSetupRequestError",
      status: 400,
      message: "invalid request body",
    });
  });

  it("refuses a 200 whose body does not match the setup-result schema", async () => {
    const { client } = fakeClient({ status: 200, body: { created: ["global"] } });

    await expect(requestVaultSetup(client, "/Users/USERNAME/Vault")).rejects.toBeInstanceOf(
      VaultSetupRequestError,
    );
  });
});
