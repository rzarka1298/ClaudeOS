import {
  APPROVAL_DECIDE_OUTCOMES,
  APPROVAL_DECIDE_PATH,
  APPROVAL_ERROR_CODES,
  APPROVAL_GET_PATH,
  APPROVAL_LIST_PATH,
  APPROVAL_TEST_PATH,
  type ApprovalSummary,
  type ApprovalsSnapshot,
  DECIDED_VIA_HEADER,
  DECIDED_VIA_PLUGIN,
} from "@ccc/domain";
import { describe, expect, it, vi } from "vitest";
import { ApprovalRequestError, createApprovalsClient } from "./approvals-client.js";
import type { SocketApiClient, SocketRequestOptions, SocketResponse } from "./socket-api-client.js";
import { SocketUnreachableError } from "./socket-api-client.js";

/**
 * The approvals client (plan 06-13, task 2): one typed, validated client over
 * the four fixed routes. Uses a fake `SocketApiClient`; the transport is proven
 * by `socket-api-client.test.ts`, so this file proves request shapes, outgoing
 * validation and the mapping from a response or a transport failure onto a
 * closed code that never carries a socket path or message text.
 */

const ID = "0mfk1a2b3c4d5e6f7a8b9c001";
const HASH = "ab12".repeat(16);

const SUMMARY: ApprovalSummary = {
  proposalId: ID,
  state: "pending",
  revision: 1,
  title: "Test approval",
  operationLabel: "Test approval",
  requesterKind: "dashboard",
  requesterLabel: "Dashboard",
  projectName: null,
  runId: null,
  createdAt: "2026-10-06T10:00:00.000Z",
  expiresAt: "2026-10-07T10:00:00.000Z",
  decidedAt: null,
  outcomeCode: null,
} as unknown as ApprovalSummary;

const SNAPSHOT: ApprovalsSnapshot = {
  ready: true,
  pending: [SUMMARY],
  decided: [],
  expired: [],
  counts: { pending: 1, decided: 0, expired: 0 },
  truncated: false,
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

describe("request shapes (task 2 test 6)", () => {
  it("lists with GET on the list path", async () => {
    const { client, calls } = recording(200, SNAPSHOT);
    const result = await createApprovalsClient(client).list();
    expect(result).toEqual(SNAPSHOT);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe(APPROVAL_LIST_PATH);
  });

  it("gets with POST and a strict body", async () => {
    const detail = { summary: SUMMARY, view: null, purged: true, payloadHash: HASH };
    const { client, calls } = recording(200, detail);
    const result = await createApprovalsClient(client).get(ID);
    expect(result.payloadHash).toBe(HASH);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe(APPROVAL_GET_PATH);
    expect(calls[0]?.body).toEqual({ proposalId: ID });
    expect(calls[0]?.headers?.[DECIDED_VIA_HEADER]).toBeUndefined();
  });

  it("decides with POST, a strict body and the plugin channel header", async () => {
    const { client, calls } = recording(200, { outcome: "hash-mismatch" });
    const result = await createApprovalsClient(client).decide({
      proposalId: ID as never,
      decision: "approve",
      payloadHash: HASH,
    });
    expect(result).toEqual({ outcome: "hash-mismatch" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe(APPROVAL_DECIDE_PATH);
    expect(calls[0]?.body).toEqual({ proposalId: ID, decision: "approve", payloadHash: HASH });
    expect(calls[0]?.headers?.[DECIDED_VIA_HEADER]).toBe(DECIDED_VIA_PLUGIN);
  });

  it("tests with POST and an empty or shortened body", async () => {
    const { client, calls } = recording(200, { outcome: "proposed", proposalId: ID });
    const api = createApprovalsClient(client);
    await api.test();
    await api.test({ ttlMs: 60_000 });
    expect(calls.map((c) => c.path)).toEqual([APPROVAL_TEST_PATH, APPROVAL_TEST_PATH]);
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST"]);
    expect(calls[0]?.body).toEqual({});
    expect(calls[1]?.body).toEqual({ ttlMs: 60_000 });
  });

  it("throws before any request when a body has an extra key, a bad id or a bad hash", async () => {
    const { client, calls } = recording(200, {});
    const api = createApprovalsClient(client);
    const good = { proposalId: ID as never, decision: "approve" as const, payloadHash: HASH };
    await expect(api.decide({ ...good, remember: true } as never)).rejects.toThrow();
    await expect(api.decide({ ...good, always: true } as never)).rejects.toThrow();
    await expect(api.decide({ ...good, decision: "approve-always" } as never)).rejects.toThrow();
    await expect(api.decide({ ...good, payloadHash: HASH.slice(0, 12) })).rejects.toThrow();
    await expect(api.decide({ ...good, proposalId: "short" as never })).rejects.toThrow();
    await expect(api.get("short")).rejects.toThrow();
    await expect(api.test({ operation: "diagnostic.test" } as never)).rejects.toThrow();
    await expect(api.test({ ttlMs: 0 })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("errors (task 2 test 7)", () => {
  it("maps a timeout to timeout and any other unreachable error to service-disconnected", async () => {
    const timeout = await createApprovalsClient(failing(unreachable("ETIMEDOUT")))
      .list()
      .catch((e: unknown) => e);
    expect(timeout).toBeInstanceOf(ApprovalRequestError);
    expect((timeout as ApprovalRequestError).code).toBe("timeout");
    for (const errno of ["ECONNREFUSED", "ENOENT", "ECONNRESET"]) {
      const err = await createApprovalsClient(failing(unreachable(errno)))
        .list()
        .catch((e: unknown) => e);
      expect((err as ApprovalRequestError).code).toBe("service-disconnected");
    }
  });

  it("exposes neither the socket path nor any message text, only a status and a code", async () => {
    const err = (await createApprovalsClient(failing(unreachable("ECONNREFUSED")))
      .list()
      .catch((e: unknown) => e)) as ApprovalRequestError;
    expect(err.message).toBe(err.code);
    expect(err.status).toBe(0);
    expect(err.cause).toBeUndefined();
    const own = Object.getOwnPropertyNames(err).filter((k) => k !== "stack");
    expect(own.sort()).toEqual(["code", "message", "name", "status"]);
    expect(JSON.stringify(err)).not.toContain("/Users/");
    expect(String(err.stack ?? "")).not.toContain("/Users/USERNAME/private");
  });

  it("maps a non-200 response with a closed error body to that code", async () => {
    for (const code of APPROVAL_ERROR_CODES) {
      const { client } = recording(409, { error: code });
      const err = await createApprovalsClient(client)
        .test()
        .catch((e: unknown) => e);
      expect((err as ApprovalRequestError).code).toBe(code);
      expect((err as ApprovalRequestError).status).toBe(409);
    }
  });

  it("maps a generic or unknown error body to unrecognised-response without surfacing its text", async () => {
    for (const body of [
      { error: "internal error" },
      { error: "disk /Users/USERNAME/x full" },
      "x",
      null,
    ]) {
      const { client } = recording(500, body);
      const err = (await createApprovalsClient(client)
        .list()
        .catch((e: unknown) => e)) as ApprovalRequestError;
      expect(err.code).toBe("unrecognised-response");
      expect(err.message).not.toContain("USERNAME");
    }
  });

  it("maps a 200 response that fails its schema to unrecognised-response", async () => {
    const wrong = [
      {
        client: recording(200, { pending: [] }).client,
        call: (a: ReturnType<typeof createApprovalsClient>) => a.list(),
      },
      {
        client: recording(200, { summary: SUMMARY }).client,
        call: (a: ReturnType<typeof createApprovalsClient>) => a.get(ID),
      },
      {
        client: recording(200, { outcome: "proposed" }).client,
        call: (a: ReturnType<typeof createApprovalsClient>) => a.test(),
      },
    ];
    for (const { client, call } of wrong) {
      const err = (await call(createApprovalsClient(client)).catch(
        (e: unknown) => e,
      )) as ApprovalRequestError;
      expect(err).toBeInstanceOf(ApprovalRequestError);
      expect(err.code).toBe("unrecognised-response");
    }
  });
});

describe("decide response parsing (task 2 test 8)", () => {
  const BODIES: Record<(typeof APPROVAL_DECIDE_OUTCOMES)[number], unknown> = {
    decided: { outcome: "decided", approval: { ...SUMMARY, state: "approved" } },
    "hash-mismatch": { outcome: "hash-mismatch" },
    expired: { outcome: "expired" },
    "already-decided": { outcome: "already-decided", state: "denied" },
    "not-found": { outcome: "not-found" },
    "operation-reserved": { outcome: "operation-reserved" },
  };

  it("parses each outcome", async () => {
    const input = { proposalId: ID as never, decision: "deny" as const, payloadHash: HASH };
    for (const outcome of APPROVAL_DECIDE_OUTCOMES) {
      const { client } = recording(200, BODIES[outcome]);
      const result = await createApprovalsClient(client).decide(input);
      expect(result.outcome).toBe(outcome);
    }
  });

  it("rejects an unknown outcome string and an extra key on a known outcome", async () => {
    const input = { proposalId: ID as never, decision: "deny" as const, payloadHash: HASH };
    for (const body of [
      { outcome: "approved-forever" },
      { outcome: "expired", note: "x" },
      { outcome: "decided" },
    ]) {
      const { client } = recording(200, body);
      const err = (await createApprovalsClient(client)
        .decide(input)
        .catch((e: unknown) => e)) as ApprovalRequestError;
      expect(err.code).toBe("unrecognised-response");
    }
  });
});

describe("transport pass-through", () => {
  it("rethrows a non-transport failure of the underlying client unchanged", async () => {
    const boom = new TypeError("not a transport error");
    const spy = vi.fn(() => Promise.reject(boom));
    const err = await createApprovalsClient({ request: spy as never })
      .list()
      .catch((e: unknown) => e);
    expect(err).toBe(boom);
  });
});
