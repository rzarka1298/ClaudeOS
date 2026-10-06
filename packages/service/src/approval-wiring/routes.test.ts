import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_DECIDE_OUTCOMES,
  APPROVAL_DECIDE_PATH,
  APPROVAL_GET_PATH,
  APPROVAL_LIST_PATH,
  APPROVAL_RESPONSE_BUDGET_BYTES,
  APPROVAL_TEST_PATH,
  ApprovalDetailResponseSchema,
  type ApprovalSummary,
  type ApprovalsSnapshot,
  ApprovalTestRequestSchema,
  capDiffLines,
  DECIDED_VIA_HEADER,
  DECIDED_VIA_PLUGIN,
  DecideResponseSchema,
  fitApprovalsSnapshotToBudget,
  HANDSHAKE_PATH,
  markReviewability,
} from "@ccc/domain";
import { applyMigrations, type OperationalStore, openStore } from "@ccc/operational-store";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logging.js";
import {
  approvalView,
  createFakeServices,
  type FakeServices,
  HASH,
  proposalId,
  type RouteHarness,
  requestOverSocket,
  startRouteHarness,
  summary,
} from "../test-support/approval-fixtures.js";
import { approvalRoutes } from "./routes.js";
import type { ApprovalServices } from "./types.js";

const UNAUTHENTICATED = { error: "authentication required" };
const INVALID_BODY = { error: "invalid request body" };
const INTERNAL_ERROR = { error: "internal error" };
const UNAVAILABLE = { error: "approval-unavailable" };

let baseDir: string;
let store: OperationalStore;

beforeAll(() => {
  const base = join(homedir(), ".ccc-test");
  mkdirSync(base, { recursive: true });
  baseDir = mkdtempSync(join(base, "appr-store-"));
  store = openStore(join(baseDir, "operational.db"));
  applyMigrations(store.db);
});

afterAll(() => {
  store.close();
  rmSync(baseDir, { recursive: true, force: true });
});

let harness: RouteHarness;
let fake: FakeServices;

function asServices(f: FakeServices): ApprovalServices {
  return f as unknown as ApprovalServices;
}

beforeEach(async () => {
  fake = createFakeServices();
  harness = await startRouteHarness(store, { approvals: asServices(fake) });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.close();
});

function call<T = unknown>(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string | string[]>;
    token?: string | null;
  } = {},
) {
  const token = opts.token === undefined ? harness.token : (opts.token ?? undefined);
  return requestOverSocket<T>(harness.socketPath, {
    method: opts.method ?? "POST",
    path,
    ...(opts.body === undefined ? {} : { body: opts.body }),
    ...(opts.rawBody === undefined ? {} : { rawBody: opts.rawBody }),
    ...(opts.headers === undefined ? {} : { headers: opts.headers }),
    ...(token === undefined ? {} : { token }),
  });
}

const ROUTES: readonly { method: string; path: string; body?: unknown }[] = [
  { method: "GET", path: APPROVAL_LIST_PATH },
  { method: "POST", path: APPROVAL_GET_PATH, body: { proposalId: proposalId(1) } },
  {
    method: "POST",
    path: APPROVAL_DECIDE_PATH,
    body: { proposalId: proposalId(1), decision: "approve", payloadHash: HASH },
  },
  { method: "POST", path: APPROVAL_TEST_PATH, body: {} },
];

function noServicesCalled(): void {
  expect(fake.decideCalls).toHaveLength(0);
  expect(fake.testCalls).toHaveLength(0);
  expect(fake.getCalls).toHaveLength(0);
  expect(fake.snapshotBudgets).toHaveLength(0);
}

describe("auth (tracer test 1)", () => {
  it("answers every approval route without a valid bearer token with the one shared 401 body", async () => {
    for (const route of ROUTES) {
      const none = await call(route.path, { ...route, token: null });
      expect(none.status).toBe(401);
      expect(none.body).toEqual(UNAUTHENTICATED);
      const bad = await call(route.path, { ...route, token: "not-a-token" });
      expect(bad.status).toBe(401);
      expect(bad.body).toEqual(UNAUTHENTICATED);
    }
    noServicesCalled();
  });

  it("registers every approval route behind the token and leaves only the handshake unwrapped", async () => {
    for (const [path, methods] of Object.entries(approvalRoutes)) {
      expect(path).not.toBe(HANDSHAKE_PATH);
      for (const handler of Object.values(methods)) expect(typeof handler).toBe("function");
    }
    const handshake = await call(HANDSHAKE_PATH, { token: null, body: {} });
    expect(handshake.status).toBe(200);
  });
});

describe("no engine (tracer test 2)", () => {
  it("answers 503 with a constant body on every route and drains the request body", async () => {
    const bare = await startRouteHarness(store, {});
    try {
      const big = JSON.stringify({ filler: "x".repeat(100 * 1024) });
      for (const route of ROUTES) {
        const reply = await requestOverSocket(bare.socketPath, {
          method: route.method,
          path: route.path,
          token: bare.token,
          ...(route.method === "POST" ? { rawBody: big } : {}),
        });
        expect(reply.status).toBe(503);
        expect(reply.body).toEqual(UNAVAILABLE);
      }
    } finally {
      await bare.close();
    }
  });
});

describe("test route (tracer test 3)", () => {
  it("creates one request per call and answers with its id", async () => {
    const first = await call<{ outcome: string; proposalId: string }>(APPROVAL_TEST_PATH, {
      body: {},
    });
    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe("proposed");
    expect(fake.testCalls).toEqual([{}]);
    const second = await call<{ outcome: string; proposalId: string }>(APPROVAL_TEST_PATH, {
      body: {},
    });
    expect(second.body.proposalId).not.toBe(first.body.proposalId);
    expect(fake.testCalls).toHaveLength(2);
  });

  it("forwards a shortened lifetime and refuses any other key with the constant 400", async () => {
    const shortened = await call(APPROVAL_TEST_PATH, { body: { ttlMs: 60_000 } });
    expect(shortened.status).toBe(200);
    expect(fake.testCalls).toEqual([{ ttlMs: 60_000 }]);

    for (const body of [
      { operation: "diagnostic.test" },
      { ttlMs: 60_000, extra: true },
      { ttlMs: 0 },
      { ttlMs: "soon" },
    ]) {
      const refused = await call(APPROVAL_TEST_PATH, { body });
      expect(refused.status).toBe(400);
      expect(refused.body).toEqual(INVALID_BODY);
    }
    expect(fake.testCalls).toHaveLength(1);
  });

  it("maps a refused submission onto a closed code and never a message", async () => {
    fake.script.testResults.push({ kind: "rejected", reason: "inbox-full" });
    fake.script.testResults.push({ kind: "rejected", reason: "operation-reserved" });
    fake.script.testResults.push({ kind: "rejected", reason: "invalid-payload" });
    const full = await call(APPROVAL_TEST_PATH, { body: {} });
    expect(full.status).toBe(409);
    expect(full.body).toEqual({ error: "too-many-pending" });
    const reserved = await call(APPROVAL_TEST_PATH, { body: {} });
    expect(reserved.status).toBe(409);
    expect(reserved.body).toEqual({ error: "operation-reserved" });
    const other = await call(APPROVAL_TEST_PATH, { body: {} });
    expect(other.status).toBe(500);
    expect(other.body).toEqual({ error: "action-failed" });
  });
});

describe("list (tracer test 4)", () => {
  it("answers the bounded snapshot object and no other field", async () => {
    fake.script.snapshot = {
      ready: true,
      pending: [summary(1), summary(2)],
      decided: [summary(3, "approved")],
      expired: [],
      counts: { pending: 2, decided: 1, expired: 0 },
      truncated: false,
    };
    const reply = await call<Record<string, unknown>>(APPROVAL_LIST_PATH, { method: "GET" });
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.body).sort()).toEqual(
      ["counts", "decided", "expired", "pending", "ready", "truncated"].sort(),
    );
    expect(reply.body).toEqual(fake.script.snapshot);
    expect(fake.snapshotBudgets).toHaveLength(1);
  });
});

describe("decide validation (tracer test 5)", () => {
  const VALID = { proposalId: proposalId(1), decision: "approve", payloadHash: HASH };

  it("refuses a malformed body with the constant 400 and never calls the services", async () => {
    const bad: unknown[] = [
      { proposalId: VALID.proposalId, decision: "approve" },
      { ...VALID, payloadHash: "ab12".repeat(15) },
      { ...VALID, payloadHash: `${"ab12".repeat(15)}ABCD` },
      { ...VALID, payloadHash: HASH.slice(0, 12) },
      { ...VALID, proposalId: "short" },
      { ...VALID, proposalId: "A".repeat(25) },
      { ...VALID, decision: "approve-always" },
      { ...VALID, decision: "remember" },
      { ...VALID, remember: true },
      { ...VALID, always: true },
      { ...VALID, alwaysAllow: true },
      { ...VALID, payload: {} },
      { ...VALID, operation: "diagnostic.test" },
      [],
      "approve",
      null,
    ];
    for (const body of bad) {
      const reply = await call(APPROVAL_DECIDE_PATH, { body });
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual(INVALID_BODY);
    }
    const notJson = await call(APPROVAL_DECIDE_PATH, { rawBody: "{not json" });
    expect(notJson.status).toBe(400);
    expect(notJson.body).toEqual(INVALID_BODY);
    expect(fake.decideCalls).toHaveLength(0);
  });

  it("caps the body at 4 KiB", async () => {
    const padded = JSON.stringify({ ...VALID, pad: "x".repeat(4096) });
    expect(Buffer.byteLength(padded)).toBeGreaterThan(4096);
    const reply = await call(APPROVAL_DECIDE_PATH, { rawBody: padded });
    expect(reply.status).toBe(400);
    expect(reply.body).toEqual(INVALID_BODY);
    expect(fake.decideCalls).toHaveLength(0);

    const ok = await call(APPROVAL_DECIDE_PATH, { body: VALID });
    expect(ok.status).toBe(200);
    expect(fake.decideCalls).toHaveLength(1);
  });
});

describe("decide outcomes (tracer test 6)", () => {
  it("returns every business outcome as a 200 body in the closed vocabulary", async () => {
    const approval = summary(1, "approved");
    const results = [
      { outcome: "decided", approval },
      { outcome: "hash-mismatch" },
      { outcome: "expired" },
      { outcome: "already-decided", state: "denied" },
      { outcome: "not-found" },
      { outcome: "operation-reserved" },
    ] as const;
    expect(results.map((r) => r.outcome).sort()).toEqual([...APPROVAL_DECIDE_OUTCOMES].sort());
    for (const result of results) {
      fake.script.decideResult = DecideResponseSchema.parse(result);
      const reply = await call(APPROVAL_DECIDE_PATH, {
        body: { proposalId: proposalId(1), decision: "approve", payloadHash: HASH },
      });
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual(result);
    }
  });

  it("passes the decision and the full hash to the services, and nothing else", async () => {
    await call(APPROVAL_DECIDE_PATH, {
      body: { proposalId: proposalId(7), decision: "deny", payloadHash: HASH },
    });
    expect(fake.decideCalls).toEqual([
      { proposalId: proposalId(7), decision: "deny", payloadHash: HASH, via: "other" },
    ]);
  });
});

describe("decided via (tracer test 7)", () => {
  const body = { proposalId: proposalId(1), decision: "approve", payloadHash: HASH };

  it("derives plugin only from the exact client header value", async () => {
    await call(APPROVAL_DECIDE_PATH, {
      body,
      headers: { [DECIDED_VIA_HEADER]: DECIDED_VIA_PLUGIN },
    });
    expect(fake.decideCalls.at(-1)?.via).toBe("plugin");
  });

  it("derives other for no header, another value, a doubled header or a smuggled value", async () => {
    const cases: (Record<string, string | string[]> | undefined)[] = [
      undefined,
      { [DECIDED_VIA_HEADER]: "other" },
      { [DECIDED_VIA_HEADER]: "Plugin" },
      { [DECIDED_VIA_HEADER]: "plugin2" },
      { [DECIDED_VIA_HEADER]: "plugin, other" },
      { [DECIDED_VIA_HEADER]: "plugin; admin=1" },
      { [DECIDED_VIA_HEADER]: [DECIDED_VIA_PLUGIN, DECIDED_VIA_PLUGIN] },
      { [DECIDED_VIA_HEADER]: "" },
    ];
    for (const headers of cases) {
      fake.decideCalls.length = 0;
      const reply = await call(APPROVAL_DECIDE_PATH, {
        body,
        ...(headers === undefined ? {} : { headers }),
      });
      expect(reply.status).toBe(200);
      expect(fake.decideCalls).toHaveLength(1);
      expect(fake.decideCalls[0]?.via).toBe("other");
    }
  });
});

describe("no generic submit (tracer test 8)", () => {
  it("registers exactly the four fixed paths and accepts no operation name", async () => {
    expect(Object.keys(approvalRoutes).sort()).toEqual(
      [APPROVAL_LIST_PATH, APPROVAL_GET_PATH, APPROVAL_DECIDE_PATH, APPROVAL_TEST_PATH].sort(),
    );
    expect(Object.keys(approvalRoutes[APPROVAL_LIST_PATH] ?? {})).toEqual(["GET"]);
    for (const path of [APPROVAL_GET_PATH, APPROVAL_DECIDE_PATH, APPROVAL_TEST_PATH]) {
      expect(Object.keys(approvalRoutes[path] ?? {})).toEqual(["POST"]);
    }
    expect(Object.keys(ApprovalTestRequestSchema.shape)).toEqual(["ttlMs"]);
  });

  it("answers an invented submit path with the shared not-found behaviour", async () => {
    for (const path of [
      "/api/v1/approvals/submit",
      "/api/v1/approvals/propose",
      "/api/v1/approvals/execute",
      "/api/v1/approvals/diagnostic.test",
    ]) {
      const reply = await call(path, {
        body: { operation: "session.force-terminate", payload: {} },
      });
      expect(reply.status).toBe(404);
      expect(reply.body).toEqual({ error: "no such route" });
    }
    noServicesCalled();
  });
});

describe("errors (tracer test 9)", () => {
  it("answers a throwing service with the constant 500 and logs only the route and the class name", async () => {
    const errorSpy = vi.spyOn(logger, "error");
    const secret = "payload text /Users/USERNAME/private-project";
    fake.script.decideResult = new TypeError(secret);
    const decide = await call(APPROVAL_DECIDE_PATH, {
      body: { proposalId: proposalId(1), decision: "approve", payloadHash: HASH },
    });
    expect(decide.status).toBe(500);
    expect(decide.body).toEqual(INTERNAL_ERROR);
    expect(decide.raw).not.toContain("payload text");

    fake.script.testResults.push(new RangeError(secret));
    const test = await call(APPROVAL_TEST_PATH, { body: {} });
    expect(test.status).toBe(500);
    expect(test.body).toEqual(INTERNAL_ERROR);

    fake.script.snapshotThrows = true;
    const list = await call(APPROVAL_LIST_PATH, { method: "GET" });
    expect(list.status).toBe(500);
    expect(list.body).toEqual(INTERNAL_ERROR);

    expect(errorSpy).toHaveBeenCalled();
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain("payload text");
    expect(logged).not.toContain("/Users/");
    for (const [fields] of errorSpy.mock.calls) {
      expect(Object.keys(fields as object).sort()).toEqual(["errorName", "route"]);
    }
    expect(logged).toContain("TypeError");
    expect(logged).toContain("RangeError");
  });
});

// ---------------------------------------------------------------------------
// Task 2: the get route, the ready flag and the response-size guarantee

const ID_1 = proposalId(1);

/** Every text field of a summary at its schema maximum, in a three-byte script. */
function maxSummary(n: number, state: ApprovalSummary["state"] = "pending"): ApprovalSummary {
  const cjk = (count: number) => "\u6f22".repeat(count);
  return summary(n, state, {
    title: cjk(120),
    operationLabel: cjk(80),
    requesterLabel: cjk(64),
    projectName: cjk(120),
    runId: "0mfk1a2b3c4d5e6f7a8b9c0d1",
    decidedAt: "2026-10-06T10:30:00.000Z",
    outcomeCode: "x".repeat(64),
  });
}

describe("get route (task 2 test 1)", () => {
  it("answers the summary, the view, the purged flag and the full hash", async () => {
    const view = approvalView();
    fake.script.getResult = {
      kind: "found",
      summary: summary(1),
      view,
      purged: false,
      payloadHash: HASH,
    };
    const reply = await call<unknown>(APPROVAL_GET_PATH, { body: { proposalId: ID_1 } });
    expect(reply.status).toBe(200);
    const parsed = ApprovalDetailResponseSchema.parse(reply.body);
    expect(parsed.payloadHash).toBe(HASH);
    expect(parsed.purged).toBe(false);
    expect(parsed.view?.proposalId).toBe(ID_1);
    expect(fake.getCalls).toEqual([ID_1]);
  });

  it("answers a null view for a purged request", async () => {
    fake.script.getResult = {
      kind: "found",
      summary: summary(1, "executed"),
      view: null,
      purged: true,
      payloadHash: HASH,
    };
    const reply = await call<unknown>(APPROVAL_GET_PATH, { body: { proposalId: ID_1 } });
    expect(reply.status).toBe(200);
    const parsed = ApprovalDetailResponseSchema.parse(reply.body);
    expect(parsed.view).toBeNull();
    expect(parsed.purged).toBe(true);
  });

  it("answers the closed not-found error for an unknown id and 400 for a bad body", async () => {
    const missing = await call(APPROVAL_GET_PATH, { body: { proposalId: proposalId(9) } });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "not-found" });
    for (const body of [{}, { proposalId: "short" }, { proposalId: ID_1, extra: 1 }]) {
      const bad = await call(APPROVAL_GET_PATH, { body });
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual(INVALID_BODY);
    }
    expect(fake.getCalls).toHaveLength(1);
  });
});

describe("ready flag (task 2 test 4)", () => {
  it("reports ready only while the services report ready", async () => {
    fake.script.ready = true;
    const ready = await call<ApprovalsSnapshot>(APPROVAL_LIST_PATH, { method: "GET" });
    expect(ready.body.ready).toBe(true);
    fake.script.ready = false;
    const notReady = await call<ApprovalsSnapshot>(APPROVAL_LIST_PATH, { method: "GET" });
    expect(notReady.body.ready).toBe(false);
    fake.script.snapshot = { ...fake.script.snapshot, ready: false };
    fake.script.ready = true;
    const engineNotReady = await call<ApprovalsSnapshot>(APPROVAL_LIST_PATH, { method: "GET" });
    expect(engineNotReady.body.ready).toBe(false);
  });
});

describe("response size (task 2 test 5)", () => {
  const CAP = 64 * 1024;

  it("sends a maximum-size snapshot byte for byte and under the client cap", async () => {
    const wide: ApprovalsSnapshot = {
      ready: true,
      pending: Array.from({ length: 50 }, (_, i) => maxSummary(i + 1)),
      decided: Array.from({ length: 50 }, (_, i) => maxSummary(i + 100, "executed")),
      expired: Array.from({ length: 50 }, (_, i) => maxSummary(i + 200, "expired")),
      counts: { pending: 50, decided: 50, expired: 50 },
      truncated: false,
    };
    // The untrimmed inbox is far over the cap; the services' budgeted builder trims it.
    expect(Buffer.byteLength(JSON.stringify(wide))).toBeGreaterThan(CAP);
    const trimmed = fitApprovalsSnapshotToBudget(wide, APPROVAL_RESPONSE_BUDGET_BYTES);
    fake.script.snapshot = trimmed;
    const reply = await call<unknown>(APPROVAL_LIST_PATH, { method: "GET" });
    expect(reply.status).toBe(200);
    expect(reply.raw).toBe(JSON.stringify(trimmed));
    expect(Buffer.byteLength(reply.raw, "utf8")).toBeLessThan(CAP);
    // Multibyte: the character count would pass a naive check the byte count would not.
    expect(Buffer.byteLength(reply.raw, "utf8")).toBeGreaterThan(reply.raw.length);
  });

  it("sends a maximum-size detail byte for byte and under the client cap", async () => {
    const cjk = (count: number) => "\u6f22".repeat(count);
    const lines = Array.from({ length: 30 }, (_, i) => ({
      kind: i % 2 === 0 ? ("removed" as const) : ("added" as const),
      text: cjk(400),
    }));
    const { change } = capDiffLines(lines, "engine");
    const view = markReviewability(
      {
        ...approvalView(),
        change,
        reason: {
          origin: "requester",
          shown: cjk(1000),
          full: cjk(4000),
          shortened: false,
        },
      },
      { change: false, reason: false, target: false },
    );
    // The precondition the engine guarantees: the view alone is within its budget.
    expect(Buffer.byteLength(JSON.stringify({ view }), "utf8")).toBeLessThanOrEqual(
      APPROVAL_RESPONSE_BUDGET_BYTES,
    );
    // And it is big in bytes while modest in characters.
    const found = {
      kind: "found",
      summary: maxSummary(1),
      view,
      purged: false,
      payloadHash: HASH,
    } as const;
    fake.script.getResult = found;
    const reply = await call<unknown>(APPROVAL_GET_PATH, { body: { proposalId: ID_1 } });
    expect(reply.status).toBe(200);
    const expected = JSON.stringify({
      summary: found.summary,
      view: found.view,
      purged: false,
      payloadHash: HASH,
    });
    expect(reply.raw).toBe(expected);
    expect(Buffer.byteLength(reply.raw, "utf8")).toBeLessThan(CAP);
    expect(Buffer.byteLength(reply.raw, "utf8")).toBeGreaterThan(reply.raw.length);
    expect(Buffer.byteLength(reply.raw, "utf8")).toBeGreaterThan(40 * 1024);
  });

  it("sends a decided response carrying a maximum-size summary under the client cap", async () => {
    fake.script.decideResult = { outcome: "decided", approval: maxSummary(1, "approved") };
    const reply = await call<unknown>(APPROVAL_DECIDE_PATH, {
      body: { proposalId: ID_1, decision: "approve", payloadHash: HASH },
    });
    expect(reply.raw).toBe(JSON.stringify(fake.script.decideResult));
    expect(Buffer.byteLength(reply.raw, "utf8")).toBeLessThan(CAP);
  });
});
