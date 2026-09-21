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
